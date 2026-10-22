import path from 'node:path';
import { isIP } from 'node:net';

export const CLIENT_PROFILE_IDS = ['gemini-cli-stdio', 'gemini-cli-http', 'grok-build-stdio', 'grok-build-http', 'gemini-api', 'grok-api'] as const;
export type ClientProfileId = typeof CLIENT_PROFILE_IDS[number];

export interface ClientProfileContext {
  platform: string;
  nodePath: string;
  cliPath: string;
  stateDir: string;
  publicUrl?: string;
}

export interface ClientCommand { text: string; shell: string }
export interface ClientProfile {
  id: ClientProfileId;
  title: string;
  format: 'json' | 'toml';
  content: string;
  available: boolean;
  requiresPublicUrl: boolean;
  command?: ClientCommand;
  documentationUrl: string;
  reason?: string;
}

export interface ApiRequestOptions {
  model: string;
  prompt: string;
  mcpUrl: string;
  mcpToken: string;
  access?: 'status' | 'tools';
}

const toolNames = ['bridge_status', 'bridge_list_tools', 'bridge_tool_schema', 'bridge_read', 'bridge_invoke', 'bridge_call', 'bridge_job', 'bridge_cancel', 'bridge_watch_get', 'bridge_watch_list', 'bridge_watch_wait', 'bridge_watch_cancel'] as const;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const controls = /[\u0000-\u001f\u007f]/;

function validatePath(value: string, platform: string): void {
  if (typeof value !== 'string' || controls.test(value) || invalidUnicode.test(value) || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(value)) {
    throw new Error('O caminho deve ser absoluto e não pode conter caracteres de controle ou Unicode inválido.');
  }
}

function localPaths(context: ClientProfileContext, client?: 'gemini' | 'grok'): [string, string, string] {
  const values: [string, string, string] = [context.nodePath, context.cliPath, context.stateDir];
  for (const value of values) {
    validatePath(value, context.platform);
    // These clients expand variables after parsing their configuration; shell
    // quoting cannot make a literal filesystem path immune to that expansion.
    const expands = client === 'gemini' ? /\$(?:\w+|\{[^}]+\})/.test(value) || (context.platform === 'win32' && /%[^%]+%/.test(value))
      : client === 'grok' && /\$\{[^}]+\}/.test(value);
    if (expands) throw new Error('Este cliente expande variáveis neste caminho. Use uma instalação e um diretório de estado sem esse padrão para exportar o perfil.');
  }
  return values;
}

function command(args: readonly string[], platform: string): ClientCommand {
  const windows = platform === 'win32';
  const quoted = args.map(value => {
    if (controls.test(value) || invalidUnicode.test(value)) throw new Error('O comando contém um argumento inválido.');
    return "'" + value.replace(/'/g, windows ? "''" : "'\\''") + "'";
  });
  return { text: (windows ? '& ' : '') + quoted.join(' '), shell: windows ? 'PowerShell' : 'Bash / Zsh' };
}

export function apiTokenCommand(context: ClientProfileContext): ClientCommand {
  const [node, cli, state] = localPaths(context);
  return command([node, cli, 'token', 'api', '--state-dir', state], context.platform);
}

function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host) === 4) {
    const [a = 0, b = 0, c = 0] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && !/^2001:db8:/i.test(host);
  }
  // WHATWG URL accepts some non-DNS characters (including $ and braces).
  // These must not reach clients that expand variables in configured URLs.
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function mcpUrl(value: string): URL {
  const message = 'Use uma URL MCP pública HTTPS, sem credenciais, fragmento, espaços ou endereço local/privado.';
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value) || controls.test(value) || invalidUnicode.test(value)) throw new Error(message);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !publicHost(url.hostname)) throw new Error(message);
  return url;
}

function endpoint(context: ClientProfileContext): string {
  if (!context.publicUrl) throw new Error('Configure a URL pública HTTPS no painel para disponibilizar este perfil.');
  const url = mcpUrl(context.publicUrl);
  if (url.pathname !== '/' || url.search) throw new Error('A URL pública HTTPS deve conter somente a origem, sem caminho ou parâmetros.');
  return url.origin + '/mcp';
}

export function buildApiRequest(provider: 'gemini' | 'grok', options: ApiRequestOptions): { url: string; body: Record<string, unknown> } {
  if (provider !== 'gemini' && provider !== 'grok') throw new Error('Provedor de API desconhecido. Use gemini ou grok.');
  if (!options || typeof options.model !== 'string' || !options.model.trim() || controls.test(options.model) || invalidUnicode.test(options.model)) throw new Error('Informe um modelo válido disponível na sua conta do provedor.');
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || invalidUnicode.test(options.prompt)) throw new Error('Informe um prompt não vazio.');
  if (typeof options.mcpToken !== 'string' || !/^[\x21-\x7e]+$/.test(options.mcpToken)) throw new Error('Informe o token de API da Ponte, sem espaços ou caracteres de controle.');
  const url = mcpUrl(options.mcpUrl).href;
  if (options.access !== undefined && options.access !== 'status' && options.access !== 'tools') throw new Error('Modo de acesso inválido. Use status ou tools.');
  const allowed_tools = options.access === 'tools' ? [...toolNames] : ['bridge_status'];
  const headers = { Authorization: 'Bearer ' + options.mcpToken };
  if (provider === 'gemini') {
    return { url: 'https://generativelanguage.googleapis.com/v1beta/interactions', body: {
      model: options.model, input: options.prompt, store: false,
      tools: [{ type: 'mcp_server', name: 'ponte', url, headers, allowed_tools }],
    } };
  }
  return { url: 'https://api.x.ai/v1/responses', body: {
    model: options.model, input: [{ role: 'user', content: options.prompt }],
    tools: [{ type: 'mcp', server_label: 'ponte', server_url: url, headers, allowed_tools }],
  } };
}

const metadata: Record<ClientProfileId, Pick<ClientProfile, 'title' | 'format' | 'requiresPublicUrl' | 'documentationUrl'>> = {
  'gemini-cli-stdio': { title: 'Gemini CLI · stdio local', format: 'json', requiresPublicUrl: false, documentationUrl: 'https://geminicli.com/docs/tools/mcp-server/' },
  'gemini-cli-http': { title: 'Gemini CLI · HTTP com OAuth', format: 'json', requiresPublicUrl: true, documentationUrl: 'https://geminicli.com/docs/tools/mcp-server/' },
  'grok-build-stdio': { title: 'Grok Build · stdio local', format: 'toml', requiresPublicUrl: false, documentationUrl: 'https://docs.x.ai/build/features/mcp-servers' },
  'grok-build-http': { title: 'Grok Build · HTTP com OAuth', format: 'toml', requiresPublicUrl: true, documentationUrl: 'https://docs.x.ai/build/features/mcp-servers' },
  'gemini-api': { title: 'Gemini API · modelo de requisição', format: 'json', requiresPublicUrl: true, documentationUrl: 'https://ai.google.dev/gemini-api/docs/function-calling#remote-mcp-model-context-protocol' },
  'grok-api': { title: 'Grok API · modelo de requisição', format: 'json', requiresPublicUrl: true, documentationUrl: 'https://docs.x.ai/developers/tools/remote-mcp' },
};

function generateProfile(id: ClientProfileId, context: ClientProfileContext): Pick<ClientProfile, 'content' | 'command'> {
  if (id === 'gemini-api' || id === 'grok-api') {
    const provider = id === 'gemini-api' ? 'gemini' : 'grok';
    return { content: json(buildApiRequest(provider, { model: provider === 'gemini' ? '${GEMINI_MODEL}' : '${XAI_MODEL}', prompt: 'Use bridge_status para conferir a conexão da Ponte e apresente o estado retornado.', mcpUrl: endpoint(context), mcpToken: '${PONTE_API_TOKEN}' })) };
  }
  const remote = id.endsWith('-http');
  const gemini = id.startsWith('gemini');
  if (remote) {
    const url = endpoint(context);
    return gemini
      ? { content: json({ mcpServers: { ponte: { httpUrl: url, timeout: 60000, trust: false } } }), command: command(['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http', '--timeout', '60000', 'ponte', url], context.platform) }
      : { content: '[mcp_servers.ponte]\nurl = ' + JSON.stringify(url) + '\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n', command: command(['grok', 'mcp', 'add', '--transport', 'http', 'ponte', url], context.platform) };
  }
  const [node, cli, state] = localPaths(context, gemini ? 'gemini' : 'grok');
  const args = [cli, 'stdio', '--state-dir', state];
  return gemini
    ? { content: json({ mcpServers: { ponte: { command: node, args, timeout: 60000, trust: false } } }), command: command(['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'stdio', '--timeout', '60000', 'ponte', node, '--', ...args], context.platform) }
    : { content: '[mcp_servers.ponte]\ncommand = ' + JSON.stringify(node) + '\nargs = ' + JSON.stringify(args) + '\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n', command: command(['grok', 'mcp', 'add', 'ponte', '--', node, ...args], context.platform) };
}

export function createClientProfiles(context: ClientProfileContext): ClientProfile[] {
  return CLIENT_PROFILE_IDS.map(id => {
    const base = { id, ...metadata[id] };
    try { return { ...base, ...generateProfile(id, context), available: true }; }
    catch (error) { return { ...base, content: '', available: false, reason: error instanceof Error ? error.message : 'Não foi possível gerar este perfil.' }; }
  });
}

export function exportClientProfile(id: string, context: ClientProfileContext): ClientProfile {
  if (!(CLIENT_PROFILE_IDS as readonly string[]).includes(id)) throw new Error('Perfil de cliente desconhecido. Consulte export-client --help.');
  const profile = createClientProfiles(context).find(item => item.id === id)!;
  if (!profile.available) throw new Error(profile.reason);
  return profile;
}
