import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig, Secrets, UpstreamConfig } from '../types.js';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Use letras minúsculas, números, _ ou -, começando com letra.');
export const projectSchema = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  root: z.string().min(1).max(4096).refine(value => path.isAbsolute(value), 'O caminho precisa ser absoluto.'),
  allowWrite: z.boolean().default(true),
  allowExec: z.boolean().default(false),
}).strict();

const mapping = z.record(z.string().min(1).max(200), z.string().max(8192));
export const upstreamSchema = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  transport: z.enum(['stdio', 'http', 'sse']),
  enabled: z.boolean().default(true),
  command: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(8192)).max(100).optional(),
  cwd: z.string().max(4096).optional(),
  env: mapping.optional(),
  url: z.string().url().max(4096).optional(),
  headers: mapping.optional(),
  readOnlyTools: z.array(z.string().min(1).max(200)).max(500).optional(),
  allowedTools: z.array(z.string().min(1).max(200)).max(500).optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
}).strict().superRefine((server, ctx) => {
  if (server.transport === 'stdio') {
    if (!server.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'Informe o executável.' });
    if (server.cwd && !path.isAbsolute(server.cwd)) ctx.addIssue({ code: 'custom', path: ['cwd'], message: 'O diretório precisa ser absoluto.' });
  } else {
    if (!server.url) { ctx.addIssue({ code: 'custom', path: ['url'], message: 'Informe a URL MCP.' }); return; }
    const url = new URL(server.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (local && url.protocol === 'http:')) || url.username || url.password || url.hash) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Use HTTPS, ou HTTP em localhost, sem usuário/senha na URL.' });
    }
  }
});

export const publicUrlSchema = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
  } catch { return false; }
}, 'Use uma origem HTTPS, sem caminho, credenciais ou parâmetros.');

const configSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1024).max(65535),
  apiPort: z.number().int().min(1024).max(65535),
  publicUrl: publicUrlSchema.optional(),
  approvalMode: z.enum(['mutations', 'all', 'automatic']),
  mcpToolExposure: z.enum(['full', 'compact']).default('full'),
  projects: z.array(projectSchema).max(100),
  upstreams: z.array(upstreamSchema).max(30),
}).strict().superRefine((config, ctx) => {
  if (config.port === config.apiPort) ctx.addIssue({ code: 'custom', message: 'Painel e API precisam de portas diferentes.' });
  for (const key of ['projects', 'upstreams'] as const) {
    const ids = config[key].map(item => item.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: [key], message: 'IDs duplicados.' });
  }
});

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input);
}

export function robloxPreset(platform: NodeJS.Platform = process.platform): UpstreamConfig {
  if (platform !== 'win32' && platform !== 'darwin') throw new Error('O Roblox Studio oficial é executado em Windows ou macOS. Configure este preset no computador com o Studio.');
  return {
    id: 'roblox', name: 'Roblox Studio', transport: 'stdio', enabled: true,
    ...(platform === 'win32'
      ? { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'] }
      : { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] }),
    readOnlyTools: [], timeoutMs: 120000,
  };
}

export class ConfigStore {
  private current: AppConfig;
  private chain = Promise.resolve();
  private constructor(readonly stateDir: string, config: AppConfig, readonly secrets: Secrets) { this.current = config; }
  get config(): AppConfig { return structuredClone(this.current); }

  static async open(stateDir: string, options: { workspace?: string; port?: number; apiPort?: number } = {}): Promise<ConfigStore> {
    stateDir = path.resolve(stateDir);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(stateDir, 'config.json');
    let config: AppConfig;
    try { config = parseConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const root = path.resolve(options.workspace ?? path.join(path.dirname(stateDir), 'workspace'));
      await mkdir(root, { recursive: true });
      config = parseConfig({
        version: 1, port: options.port ?? 4317, apiPort: options.apiPort ?? 4318, approvalMode: 'mutations',
        projects: [{ id: 'principal', name: 'Projeto principal', root: await realpath(root), allowWrite: true, allowExec: false }], upstreams: [],
      });
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const secretsPath = path.join(stateDir, 'secrets.json');
    let secrets: Secrets;
    try {
      secrets = z.object({ adminToken: z.string().min(40), apiToken: z.string().min(40) }).strict().parse(JSON.parse(await readFile(secretsPath, 'utf8')));
      if (secrets.adminToken === secrets.apiToken) throw new Error('Os tokens de administração e API precisam ser diferentes.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      secrets = { adminToken: randomBytes(32).toString('base64url'), apiToken: randomBytes(32).toString('base64url') };
      await writeFile(secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    await chmod(configPath, 0o600);
    await chmod(secretsPath, 0o600);
    return new ConfigStore(stateDir, config, secrets);
  }

  async update(mutator: (config: AppConfig) => AppConfig): Promise<AppConfig> {
    let updated!: AppConfig;
    const task = this.chain.then(async () => {
      updated = parseConfig(mutator(this.config));
      const destination = path.join(this.stateDir, 'config.json');
      const temporary = destination + '.' + randomBytes(8).toString('hex') + '.tmp';
      await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
      this.current = updated;
    });
    this.chain = task.catch(() => {});
    await task;
    return this.config;
  }

  publicConfig(): AppConfig {
    const config = this.config;
    for (const server of config.upstreams) {
      for (const key of ['env', 'headers'] as const) {
        if (server[key]) server[key] = Object.fromEntries(Object.entries(server[key]!).map(([name, value]) => [name, /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? value : '[REDACTED]']));
      }
      if (server.url) {
        const url = new URL(server.url);
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
        server.url = url.toString();
      }
    }
    return config;
  }
}
