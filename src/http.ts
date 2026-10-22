import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Application } from './app.js';
import { projectRoot } from './app.js';
import { projectSchema, upstreamSchema, publicUrlSchema, robloxPreset } from './core/config.js';
import { makeOpenApi } from './openapi.js';
import { makeMcpServer, publicTools, callGateway, SERVER_INSTRUCTIONS } from './mcp/server.js';
import { handleModernMcp } from './mcp/modern.js';
import { authenticateMcp, isOAuthProtocolPath, mountOAuth } from './auth/http.js';

function equalSecret(value: string, secret: string): boolean {
  const a = Buffer.from(value); const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function security(app: Express, runtime: Application, kind: 'admin' | 'api') {
  app.disable('x-powered-by'); app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    const port = req.socket.localPort;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const publicUrl = runtime.store.config.publicUrl;
    if (kind === 'api' && publicUrl) allowed.add(new URL(publicUrl).host);
    if (!req.headers.host || !allowed.has(req.headers.host.toLowerCase())) { res.status(403).json({ error: 'Host não autorizado. Configure publicUrl para o endereço HTTPS do túnel da API.' }); return; }
    const origin = req.headers.origin;
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (kind === 'api' && publicUrl) origins.add(new URL(publicUrl).origin);
    if (origin && !origins.has(origin) && !(kind === 'api' && isOAuthProtocolPath(req.path))) { res.status(403).json({ error: 'Origem não autorizada.' }); return; }
    next();
  });
}

function bearer(expected: string) {
  let windowStart = Date.now(); let failures = 0; let requests = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); failures = 0; requests = 0; }
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    if (!match || !equalSecret(match[1] ?? '', expected)) {
      failures++;
      res.set('WWW-Authenticate', 'Bearer realm="ponte-mcp"');
      res.status(failures > 30 ? 429 : 401).json({ error: failures > 30 ? 'Muitas tentativas inválidas. Aguarde um minuto.' : 'Token inválido ou ausente.' }); return;
    }
    if (++requests > 600) { res.set('Retry-After', '60').status(429).json({ error: 'Limite local de 600 requisições por minuto.' }); return; }
    next();
  };
}

const invocation = z.object({
  tool: z.string().min(1).max(128),
  arguments: z.record(z.unknown()).optional(),
  argumentsJson: z.string().max(1024 * 1024).optional(),
  idempotencyKey: z.string().max(128).optional(),
}).strict().refine(value => Boolean(value.arguments) !== (value.argumentsJson !== undefined), 'Informe exatamente um de arguments ou argumentsJson.');

function parseInvocation(body: unknown) {
  const value = invocation.parse(body);
  let args = value.arguments;
  if (value.argumentsJson !== undefined) {
    try { args = z.record(z.unknown()).parse(JSON.parse(value.argumentsJson)); }
    catch { throw new Error('argumentsJson deve conter um objeto JSON válido.'); }
  }
  return { name: value.tool, args: args!, key: value.idempotencyKey };
}

function errors(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  const parserError = error as { type?: string; body?: unknown; status?: number };
  if (req.path === '/mcp' && ['entity.parse.failed', 'entity.too.large', 'charset.unsupported', 'encoding.unsupported'].includes(parserError?.type ?? '')) {
    const modern = req.get('MCP-Protocol-Version') === '2026-07-28';
    let code = -32700;
    if (parserError.type === 'entity.parse.failed' && typeof parserError.body === 'string') {
      try { JSON.parse(parserError.body); code = -32600; } catch { /* Malformed JSON has no request ID. */ }
    }
    const large = parserError.type === 'entity.too.large';
    const encoding = parserError.type === 'charset.unsupported' || parserError.type === 'encoding.unsupported';
    if (large || encoding) code = -32600;
    res.status(large ? 413 : encoding ? 415 : 400).json({
      jsonrpc: '2.0', ...(modern ? {} : { id: null }),
      error: { code, message: large ? 'Solicitação excede 1 MiB.' : encoding ? 'O corpo JSON deve usar UTF-8 sem codificação não suportada.' : code === -32700 ? 'JSON inválido.' : 'Solicitação JSON-RPC inválida.' },
    });
    return;
  }
  if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.') || 'configuração'}: ${issue.message}`).join('; ') }); return; }
  const status = (error as { status?: number })?.status;
  res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? 'Solicitação excede 1 MiB.' : error instanceof Error ? error.message : 'Não foi possível processar a solicitação.' });
}

export function createHttpApps(runtime: Application): { admin: Express; api: Express } {
  const admin = express(); const api = express();
  security(admin, runtime, 'admin'); security(api, runtime, 'api');
  admin.get('/health', (_req, res) => { res.json({ ok: true, name: 'Ponte MCP' }); });
  api.get('/health', (_req, res) => { res.json({ ok: true }); });
  admin.use('/admin', bearer(runtime.store.secrets.adminToken), express.json({ limit: '1mb', strict: true }));
  api.get('/openapi.json', (_req, res) => { res.json(makeOpenApi(runtime.store.config.publicUrl ?? runtime.apiUrl)); });
  mountOAuth(admin, api, runtime);
  const apiBearer = bearer(runtime.store.secrets.apiToken);
  api.use('/v1', apiBearer);
  api.use('/mcp', authenticateMcp(runtime, apiBearer));
  api.use(express.json({ limit: '1mb', strict: true }));

  admin.get('/admin/state', (_req, res) => { res.json(runtime.state()); });
  admin.get('/admin/tools', (_req, res) => { res.json({ tools: runtime.toolCatalog() }); });
  admin.get('/admin/jobs/:id', (req, res) => { res.json(runtime.jobs.get(String(req.params.id))); });
  admin.post('/admin/invoke', async (req, res) => {
    const { name, args, key } = parseInvocation(req.body);
    res.status(202).json(await runtime.jobs.submit(name, args, key, runtime.apiPrincipal));
  });
  admin.delete('/admin/events/subscriptions/:id', async (req, res) => {
    const removed = await runtime.events.cancel(String(req.params.id));
    res.json({ ok: true, removed });
  });
  for (const action of ['approve', 'reject', 'cancel'] as const) {
    admin.post('/admin/jobs/:id/' + action, (req, res) => { res.json(runtime.jobs[action](String(req.params.id))); });
  }
  admin.post('/admin/pause', (req, res) => {
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(req.body);
    runtime.jobs.setPaused(paused); res.json({ ok: true, paused });
  });
  admin.patch('/admin/settings', async (req, res) => {
    const settings = z.object({ approvalMode: z.enum(['mutations', 'all', 'automatic']).optional(), publicUrl: z.union([publicUrlSchema, z.literal(''), z.null()]).optional() }).strict().parse(req.body);
    let changedOrigin = false;
    await runtime.store.update(config => {
      if (settings.approvalMode) config.approvalMode = settings.approvalMode;
      if (settings.publicUrl !== undefined) {
        const nextOrigin = settings.publicUrl ? new URL(settings.publicUrl).origin : undefined;
        changedOrigin = nextOrigin !== config.publicUrl;
        if (settings.publicUrl) config.publicUrl = new URL(settings.publicUrl).origin;
        else delete config.publicUrl;
      }
      return config;
    });
    if (changedOrigin) await runtime.oauth.publicUrlChanged();
    const approvals = settings.approvalMode !== undefined ? runtime.jobs.reconcileApprovalMode() : undefined;
    res.json({ ok: true, approvalMode: runtime.store.config.approvalMode, ...(approvals ? { approvals } : {}) });
  });

  admin.post('/admin/projects', async (req, res) => {
    const requestedId = typeof req.body?.id === 'string' ? req.body.id : '';
    const existing = runtime.store.config.projects.find(item => item.id === requestedId);
    const project = projectSchema.parse({ ...existing, ...req.body });
    const root = await realpath(project.root);
    if (!(await stat(root)).isDirectory()) throw new Error('O caminho precisa apontar para uma pasta existente.');
    if (path.parse(root).root === root) throw new Error('Selecione uma pasta de projeto, não a raiz do disco.');
    const relative = path.relative(runtime.store.stateDir, root);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('A pasta interna da ponte não pode ser um projeto.');
    project.root = root;
    await runtime.store.update(config => ({ ...config, projects: [...config.projects.filter(item => item.id !== project.id), project] }));
    res.json({ ok: true });
  });
  admin.delete('/admin/projects/:id', async (req, res) => {
    await runtime.store.update(config => ({ ...config, projects: config.projects.filter(item => item.id !== req.params.id) }));
    res.json({ ok: true });
  });

  admin.post('/admin/servers', async (req, res) => {
    const requestedId = typeof req.body?.id === 'string' ? req.body.id : '';
    const existing = runtime.store.config.upstreams.find(item => item.id === requestedId);
    const input = { ...existing, ...req.body };
    // null explicitly removes a prior restriction; [] deliberately exposes none.
    if (req.body?.allowedTools === null) delete input.allowedTools;
    const server = upstreamSchema.parse(input);
    if (server.id === 'local' || server.id === 'bridge') throw new Error('Este ID é reservado.');
    if (Object.values(server.env ?? {}).some(value => value.includes('[REDACTED]')) || Object.values(server.headers ?? {}).some(value => value.includes('[REDACTED]'))) throw new Error('Substitua os valores ocultos por referências de ambiente, ou omita env/headers para preservá-los.');
    const updated = await runtime.store.update(config => ({ ...config, upstreams: [...config.upstreams.filter(item => item.id !== server.id), server] }));
    await runtime.hub.replaceConfigs(updated.upstreams); res.json({ ok: true });
  });
  admin.delete('/admin/servers/:id', async (req, res) => {
    const updated = await runtime.store.update(config => ({ ...config, upstreams: config.upstreams.filter(item => item.id !== req.params.id) }));
    await runtime.hub.replaceConfigs(updated.upstreams); res.json({ ok: true });
  });
  admin.post('/admin/servers/:id/reconnect', async (req, res) => { await runtime.hub.reconnect(String(req.params.id)); res.json({ ok: true }); });
  admin.post('/admin/roblox', async (_req, res) => {
    const preset = robloxPreset();
    if (runtime.store.config.upstreams.some(server => server.id === preset.id)) { await runtime.hub.reconnect(preset.id); res.json({ ok: true }); return; }
    const updated = await runtime.store.update(config => ({ ...config, upstreams: [...config.upstreams, preset] }));
    await runtime.hub.replaceConfigs(updated.upstreams); res.json({ ok: true });
  });
  admin.get('/admin/openapi', (_req, res) => { res.json(makeOpenApi(runtime.store.config.publicUrl ?? runtime.apiUrl)); });

  api.get('/v1/status', (_req, res) => { res.json(runtime.publicStatus()); });
  api.get('/v1/tools', (req, res) => {
    const query = z.object({ search: z.string().max(200).optional(), source: z.string().max(100).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const tools = runtime.toolCatalog().filter(tool => (!query.source || tool.source === query.source) && (!query.search || (tool.name + ' ' + tool.description).toLowerCase().includes(query.search.toLowerCase())));
    res.json({ tools: tools.slice(query.offset, query.offset + query.limit), total: tools.length, nextOffset: query.offset + query.limit < tools.length ? query.offset + query.limit : null });
  });
  api.post('/v1/jobs', async (req, res) => {
    const { name, args, key } = parseInvocation(req.body);
    const headerKey = req.get('Idempotency-Key');
    if (headerKey && key && headerKey !== key) throw new Error('Chaves de idempotência divergentes no cabeçalho e no corpo.');
    res.status(202).json(await runtime.jobs.submit(name, args, key ?? headerKey, runtime.apiPrincipal));
  });
  api.get('/v1/jobs/:id', (req, res) => { res.json(runtime.getJobForClient(String(req.params.id), runtime.apiPrincipal)); });
  api.post('/v1/jobs/:id/cancel', (req, res) => {
    const id = String(req.params.id);
    const job = runtime.getJobForClient(id, runtime.apiPrincipal);
    res.json(['pending_approval', 'queued', 'running'].includes(job.status) ? runtime.jobs.cancel(id) : job);
  });
  api.get('/v1/mcp/tools', (_req, res) => { res.json({ tools: publicTools(runtime) }); });
  api.post('/v1/mcp/call', async (req, res) => {
    const value = z.object({ name: z.string().min(1).max(128), arguments: z.record(z.unknown()).default({}) }).strict().parse(req.body);
    res.json(await callGateway(runtime, value.name, value.arguments, runtime.apiPrincipal));
  });
  api.post('/mcp', async (req, res) => {
    const grantId = req.auth?.extra?.grantId;
    if (req.auth && typeof grantId !== 'string') { res.status(401).json({ error: 'Identidade da conexão indisponível.' }); return; }
    const principal = typeof grantId === 'string' ? 'oauth:' + grantId : runtime.apiPrincipal;
    const getTools = () => publicTools(runtime, Boolean(runtime.store.config.publicUrl));
    const call = (name: string, args: Record<string, unknown>) => callGateway(runtime, name, args, principal);
    if (await handleModernMcp(req, res, { getTools, call, events: runtime.events, principal, version: '0.5.0', instructions: SERVER_INSTRUCTIONS })) return;
    const server = makeMcpServer(getTools, call);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    finally { await server.close(); }
  });
  api.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).json({ error: 'Este endpoint MCP usa POST e sessões stateless.' }); });
  admin.use(express.static(path.join(projectRoot, 'public'), { dotfiles: 'deny', index: 'index.html', cacheControl: false }));
  for (const app of [admin, api]) {
    app.use((_req, res) => { res.status(404).json({ error: 'Rota não encontrada.' }); });
    app.use(errors);
  }
  return { admin, api };
}
