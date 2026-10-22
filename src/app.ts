import { createServer, type Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ConfigStore } from './core/config.js';
import { AuditLog } from './core/audit.js';
import { JobManager } from './core/jobs.js';
import { McpHub } from './mcp/hub.js';
import { createLocalTools } from './tools/local.js';
import { createHttpApps } from './http.js';
import { catalog } from './mcp/server.js';
import type { Job, ToolDefinition } from './types.js';
import { PonteOAuthProvider } from './auth/provider.js';
import { oauthConnectionState } from './auth/http.js';
import { EventService } from './events/service.js';
import type { WebhookPost } from './events/webhook.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class Application {
  readonly startedAt = new Date().toISOString();
  readonly audit: AuditLog;
  readonly hub: McpHub;
  readonly jobs: JobManager;
  readonly apiPrincipal: string;
  events!: EventService;
  adminUrl = '';
  apiUrl = '';
  private servers: HttpServer[] = [];
  private closed = false;
  private stopJobEvents?: () => void;
  constructor(readonly store: ConfigStore, readonly oauth: PonteOAuthProvider) {
    this.audit = new AuditLog(store.stateDir);
    this.hub = new McpHub(store.config.upstreams);
    this.jobs = new JobManager(() => this.getTools(), () => store.config.approvalMode, this.audit);
    this.apiPrincipal = 'api:' + createHash('sha256').update(store.secrets.apiToken).digest('hex');
  }
  async initializeEvents(post?: WebhookPost): Promise<void> {
    this.events = await EventService.open({
      stateDir: this.store.stateDir,
      getJob: (principal, id) => {
        if (this.jobs.ownerOf(id) !== principal) throw new Error('Trabalho indisponível para esta conexão.');
        return this.jobs.get(id);
      },
      isAuthorized: principal => principal === this.apiPrincipal || (principal.startsWith('oauth:') && this.oauth.isGrantActive(principal.slice(6))),
      ...(post ? { post } : {}),
    });
    this.stopJobEvents = this.jobs.onTerminal(job => { void this.events.record(job).catch(() => { /* Retained in Events diagnostics. */ }); });
  }
  getJobForClient(id: string, principal?: string): Job {
    try {
      const job = this.jobs.get(id);
      if (principal !== undefined && this.jobs.ownerOf(id) !== principal) throw new Error('Trabalho indisponível para esta conexão.');
      return job;
    }
    catch (error) {
      const archived = principal ? this.events?.getArchivedJob(principal, id) : undefined;
      if (archived) return archived;
      throw error;
    }
  }
  getTools(): ToolDefinition[] { return [...createLocalTools(() => this.store.config, this.store.stateDir), ...this.hub.tools()]; }
  publicStatus() {
    return {
      name: 'Ponte MCP', version: '0.5.0', paused: this.jobs.paused, approvalMode: this.store.config.approvalMode,
      projects: this.store.config.projects.map(({ id, name, allowWrite, allowExec }) => ({ id, name, allowWrite, allowExec })),
      servers: this.hub.statuses(), toolCount: this.getTools().length,
      events: { supported: Boolean(this.events), protocolVersion: '2026-07-28', event: 'ponte.job.completed', subscriptionRequired: true },
      note: 'O chat precisa suportar ferramentas. Cotas e custos dos provedores permanecem válidos.',
    };
  }
  state() {
    const jobs = this.jobs.list(200);
    const config = this.store.publicConfig();
    const tools = this.getTools();
    const counts = (status: string) => jobs.filter(job => job.status === status).length;
    return {
      name: 'Ponte MCP', version: '0.5.0', paused: this.jobs.paused, startedAt: this.startedAt,
      config, servers: this.hub.statuses(),
      jobs: jobs.slice(0, 50).map(({ result: _result, preview: _preview, arguments: _arguments, ...job }) => ({ ...job, arguments: {} })),
      stats: { tools: tools.length, projects: config.projects.length, pending: counts('pending_approval'), running: counts('running') + counts('queued'), succeeded: counts('succeeded'), failed: counts('failed') },
      ...(this.audit.error ? { auditError: this.audit.error } : {}),
      events: this.events?.snapshot(),
      connection: {
        platform: process.platform,
        mcpUrl: (config.publicUrl ?? this.apiUrl).replace(/\/$/, '') + '/mcp', apiUrl: config.publicUrl ?? this.apiUrl,
        openapiUrl: (config.publicUrl ?? this.apiUrl).replace(/\/$/, '') + '/openapi.json',
        stdioCommand: process.execPath, stdioArgs: [path.join(projectRoot, 'dist', 'cli.js'), 'stdio', '--state-dir', this.store.stateDir],
        oauth: oauthConnectionState(this),
      },
    };
  }
  toolCatalog() { return catalog(this.getTools()); }
  attach(servers: HttpServer[]): void { this.servers = servers; }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.jobs.close();
    this.stopJobEvents?.();
    await this.events?.close();
    await this.hub.close();
    await Promise.all(this.servers.map(server => new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    })));
    await this.audit.flush();
  }
}

async function listen(server: HttpServer, port: number): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener inválido.');
  return 'http://127.0.0.1:' + address.port;
}

export async function startApplication(options: { stateDir: string; workspace?: string; adminPort?: number; apiPort?: number; eventPost?: WebhookPost }): Promise<Application> {
  const store = await ConfigStore.open(options.stateDir, { workspace: options.workspace });
  const oauth = await PonteOAuthProvider.open(store.stateDir, () => store.config.publicUrl);
  const application = new Application(store, oauth);
  try {
    await application.initializeEvents(options.eventPost);
    const apps = createHttpApps(application);
    const admin = createServer(apps.admin); const api = createServer(apps.api);
    for (const server of [admin, api]) { server.requestTimeout = 150000; server.headersTimeout = 10000; server.maxHeadersCount = 64; }
    application.attach([admin, api]);
    application.adminUrl = await listen(admin, options.adminPort ?? store.config.port);
    application.apiUrl = await listen(api, options.apiPort ?? store.config.apiPort);
    await application.hub.connectAll();
    return application;
  } catch (error) { await application.close(); throw error; }
}
