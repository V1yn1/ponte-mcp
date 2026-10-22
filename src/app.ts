import { createServer, type Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ConfigStore } from './core/config.js';
import { AuditLog } from './core/audit.js';
import { JobManager } from './core/jobs.js';
import { McpHub } from './mcp/hub.js';
import { McpManagement } from './mcp/management.js';
import { createLocalTools } from './tools/local.js';
import { createHttpApps } from './http.js';
import { catalog } from './mcp/server.js';
import type { Job, ToolDefinition } from './types.js';
import { PonteOAuthProvider } from './auth/provider.js';
import { oauthConnectionState } from './auth/http.js';
import { EventService } from './events/service.js';
import type { WebhookPost } from './events/webhook.js';
import { WatchService } from './watchers/service.js';
import { createWatcherTool, jobForObservation } from './watchers/tools.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class Application {
  readonly startedAt = new Date().toISOString();
  readonly audit: AuditLog;
  readonly hub: McpHub;
  readonly mcpManagement: McpManagement;
  readonly jobs: JobManager;
  readonly apiPrincipal: string;
  events!: EventService;
  watchers!: WatchService;
  adminUrl = '';
  apiUrl = '';
  private servers: HttpServer[] = [];
  private closed = false;
  private stopJobEvents?: () => void;
  private stopJobWatchers?: () => void;
  constructor(readonly store: ConfigStore, readonly oauth: PonteOAuthProvider) {
    this.audit = new AuditLog(store.stateDir);
    this.hub = new McpHub(store.config.upstreams);
    this.jobs = new JobManager(() => this.getTools(), () => store.config.approvalMode, this.audit);
    this.apiPrincipal = 'api:' + createHash('sha256').update(store.secrets.apiToken).digest('hex');
    this.mcpManagement = new McpManagement(store, this.hub,
      principal => principal === this.apiPrincipal || (principal.startsWith('oauth:') && this.oauth.isGrantActive(principal.slice(6))));
  }
  async initializeEvents(post?: WebhookPost): Promise<void> {
    this.events = await EventService.open({
      stateDir: this.store.stateDir,
      getJob: (principal, id) => {
        if (this.jobs.ownerOf(id) !== principal) throw new Error('Trabalho indisponível para esta conexão.');
        return jobForObservation(this.jobs.get(id));
      },
      isAuthorized: principal => principal === this.apiPrincipal || (principal.startsWith('oauth:') && this.oauth.isGrantActive(principal.slice(6))),
      ...(post ? { post } : {}),
    });
    this.stopJobEvents = this.jobs.onTerminal(job => { void this.events.record(jobForObservation(job)).catch(() => { /* Retained in Events diagnostics. */ }); });
  }
  async initializeWatchers(): Promise<void> {
    this.watchers = await WatchService.open({
      stateDir: this.store.stateDir, secretKey: this.store.secrets.apiToken,
      getJob: (principal, id) => jobForObservation(this.getJobForClient(id, principal)),
      isAuthorized: principal => principal === this.apiPrincipal || (principal.startsWith('oauth:') && this.oauth.isGrantActive(principal.slice(6))),
      isPaused: () => this.jobs.paused,
    });
    this.stopJobWatchers = this.jobs.onTerminal(job => { void this.watchers.recordJob(jobForObservation(job)).catch(() => { /* Durable refresh retries and exposes a safe diagnostic. */ }); });
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
  getTools(): ToolDefinition[] { return [...createLocalTools(() => this.store.config, this.store.stateDir), ...(this.watchers ? [createWatcherTool(this.watchers, () => this.store.config.publicUrl ?? this.apiUrl)] : []), ...this.mcpManagement.definitions(), ...this.hub.tools()]; }
  publicStatus() {
    return {
      name: 'Ponte MCP', version: '0.7.0', paused: this.jobs.paused, approvalMode: this.store.config.approvalMode,
      projects: this.store.config.projects.map(({ id, name, allowWrite, allowExec }) => ({ id, name, allowWrite, allowExec })),
      servers: this.hub.statuses(), toolCount: this.getTools().length,
      mcpManagement: { supported: true, tools: ['bridge_mcp_list', 'bridge_mcp_add', 'bridge_mcp_reconnect'], approvalPolicy: this.store.config.approvalMode, canReplaceExisting: false, credentials: 'environment_references' },
      events: { supported: Boolean(this.events), protocolVersion: '2026-07-28', event: 'ponte.job.completed', subscriptionRequired: true },
      watchers: { supported: Boolean(this.watchers), triggers: ['signal', 'job'], monitorDurable: true, nativeSchedulerRequired: false, canWakeClosedConversation: false, defaultWaitMs: 25000, maxWaitMs: 300000 },
      note: 'O chat precisa suportar ferramentas. Cotas e custos dos provedores permanecem válidos.',
    };
  }
  state() {
    const jobs = this.jobs.list(200);
    const config = this.store.publicConfig();
    const tools = this.getTools();
    const counts = (status: string) => jobs.filter(job => job.status === status).length;
    return {
      name: 'Ponte MCP', version: '0.7.0', paused: this.jobs.paused, startedAt: this.startedAt,
      config, servers: this.hub.statuses(),
      jobs: jobs.slice(0, 50).map(({ result: _result, preview: _preview, arguments: _arguments, ...job }) => ({ ...job, arguments: {} })),
      stats: { tools: tools.length, projects: config.projects.length, pending: counts('pending_approval'), running: counts('running') + counts('queued'), succeeded: counts('succeeded'), failed: counts('failed') },
      ...(this.audit.error ? { auditError: this.audit.error } : {}),
      events: this.events?.snapshot(),
      watchers: this.watchers?.snapshot(),
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
    this.closed = true;
    const managementClosed = this.mcpManagement.close();
    this.stopJobWatchers?.();
    await this.watchers?.close();
    this.jobs.close();
    this.stopJobEvents?.();
    await this.events?.close();
    await managementClosed;
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
    await application.initializeWatchers();
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
