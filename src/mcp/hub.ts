import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError, ToolListChangedNotificationSchema,
  type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolDefinition, UpstreamConfig, UpstreamStatus } from '../types.js';

const MAX_TOOLS = 500;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Only messages created here may be exposed as connection diagnostics. */
class HubError extends Error {}

interface Connection {
  config: UpstreamConfig;
  configKey: string;
  connectionKey?: string;
  status: UpstreamStatus['status'];
  error?: string;
  definitions: Map<string, ToolDefinition>;
  abort: AbortController;
  client?: Client;
  transport?: Transport;
  connecting?: Promise<void>;
  refreshing?: Promise<void>;
  refreshRequested: boolean;
  disposed: boolean;
  disposing?: Promise<void>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function toolName(upstreamId: string, originalName: string): string {
  // Hash the tuple, not its joined spelling: a/b__c and a__b/c must stay distinct.
  const suffix = digest([upstreamId, originalName]).slice(0, 16);
  const prefix = (upstreamId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'upstream').slice(0, 20);
  const available = 64 - prefix.length - suffix.length - 4;
  const name = (originalName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool').slice(0, available);
  return `${prefix}__${name}__${suffix}`;
}

function timeoutFor(config: UpstreamConfig): number {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new HubError('O tempo limite deve ser um número positivo.');
  return Math.min(Math.floor(timeout), MAX_TIMEOUT_MS);
}

function resolveReferences(value: string): string {
  const pattern = /\$\{([^}]*)\}/g;
  if (value.replace(pattern, '').includes('${')) throw new HubError('Referência de variável de ambiente incompleta. Use ${NOME}.');
  return value.replace(pattern, (_match, name: string) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new HubError('Referência de variável de ambiente inválida. Use ${NOME}.');
    const resolved = process.env[name];
    if (resolved === undefined) throw new HubError(`Variável de ambiente não definida: ${name}.`);
    return resolved;
  });
}

function resolveRecord(values: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolveReferences(value)]));
}

function childEnvironment(configured: Record<string, string>): Record<string, string> {
  const environment = getDefaultEnvironment();
  // The SDK's minimal Windows environment includes LOCALAPPDATA, PATH and SYSTEMROOT.
  // Never spread process.env: it may include Ponte credentials and NODE_OPTIONS.
  for (const [key, value] of Object.entries(configured)) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(environment)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete environment[existing];
      }
    }
    environment[key] = value;
  }
  return environment;
}

function endpoint(value: string | undefined): URL {
  if (!value) throw new HubError('Informe a URL do servidor MCP.');
  let url: URL;
  try { url = new URL(resolveReferences(value)); } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError('A URL do servidor MCP é inválida.');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === 'localhost.' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new HubError('Use HTTPS para servidores remotos; HTTP é permitido somente em loopback.');
  }
  if (url.username || url.password || url.hash) throw new HubError('A URL MCP não pode conter credenciais ou fragmentos; use headers para autenticação.');
  return url;
}

function cancelled(): Error { return new DOMException('Chamada cancelada.', 'AbortError'); }

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<T> {
  if (parent.aborted) throw cancelled();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadline.signal.aborted ? new HubError('Tempo limite da operação MCP excedido.') : cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(signal), aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function connectionError(error: unknown): string {
  if (error instanceof HubError) return error.message;
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return 'Tempo limite ao conectar ou consultar o servidor MCP.';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') return 'Executável ou diretório do servidor MCP não encontrado. Confira comando e pasta de trabalho.';
  if (code === 'EACCES' || code === 'EPERM') return 'Sem permissão para iniciar o servidor MCP.';
  if (code === 'ECONNREFUSED') return 'O servidor MCP não está aceitando conexões no endereço configurado.';
  if (code === 401 || code === 403 || (error instanceof Error && error.name === 'UnauthorizedError')) {
    return 'O servidor MCP recusou a autenticação. Confira os headers e as variáveis de ambiente configurados.';
  }
  return 'Falha na comunicação MCP. Confira o comando ou endereço, a disponibilidade do servidor e as credenciais configuradas.';
}

function makeConnection(config: UpstreamConfig): Connection {
  const snapshot = structuredClone(config);
  return {
    config: snapshot, configKey: digest(snapshot), status: snapshot.enabled ? 'connecting' : 'disabled',
    definitions: new Map(), abort: new AbortController(), refreshRequested: false, disposed: false,
  };
}

function configMap(configs: UpstreamConfig[]): Map<string, Connection> {
  const result = new Map<string, Connection>();
  for (const config of configs) {
    if (!config.id || result.has(config.id)) throw new HubError('Cada conexão MCP deve ter um identificador único e não vazio.');
    result.set(config.id, makeConnection(config));
  }
  return result;
}

/** Long-lived upstream clients; transport failures never replay tool calls. */
export class McpHub {
  private connections: Map<string, Connection>;
  private closed = false;

  constructor(configs: UpstreamConfig[]) { this.connections = configMap(configs); }

  async connectAll(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled([...this.connections.values()].map(connection => this.connect(connection)));
  }

  async reconnect(id: string): Promise<void> {
    if (this.closed) throw new HubError('O agregador MCP está encerrado.');
    const previous = this.connections.get(id);
    if (!previous) throw new HubError('Conexão MCP não encontrada.');
    const replacement = makeConnection(previous.config);
    this.connections.set(id, replacement);
    await this.dispose(previous);
    await this.connect(replacement);
  }

  async replaceConfigs(configs: UpstreamConfig[]): Promise<void> {
    if (this.closed) throw new HubError('O agregador MCP está encerrado.');
    const next = configMap(configs);
    const previous = this.connections;
    for (const [id, candidate] of next) {
      const existing = previous.get(id);
      if (existing?.configKey === candidate.configKey) next.set(id, existing);
    }
    // Remove obsolete definitions synchronously before awaiting process cleanup.
    this.connections = next;
    await Promise.allSettled([...previous].filter(([id, entry]) => next.get(id) !== entry).map(([, entry]) => this.dispose(entry)));
    await this.connectAll();
  }

  tools(): ToolDefinition[] {
    return [...this.connections.values()].flatMap(connection => connection.status === 'connected'
      ? [...connection.definitions.values()].map(definition => ({ ...definition, tool: structuredClone(definition.tool) }))
      : []);
  }

  statuses(): UpstreamStatus[] {
    return [...this.connections.values()].map(connection => ({
      id: connection.config.id, name: connection.config.name, transport: connection.config.transport,
      status: connection.status, toolCount: connection.status === 'connected' ? connection.definitions.size : 0,
      ...(connection.error ? { error: connection.error } : {}),
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.connections.values()].map(connection => {
      connection.status = connection.config.enabled ? 'error' : 'disabled';
      if (connection.config.enabled) connection.error = 'Conexão MCP encerrada.';
      return this.dispose(connection);
    }));
  }

  private current(connection: Connection): boolean {
    return !this.closed && !connection.disposed && this.connections.get(connection.config.id) === connection;
  }

  private async connect(connection: Connection): Promise<void> {
    if (!this.current(connection) || !connection.config.enabled || connection.status === 'connected') return;
    if (connection.connecting) return connection.connecting;
    connection.connecting = this.establish(connection).finally(() => { connection.connecting = undefined; });
    return connection.connecting;
  }

  private async establish(connection: Connection): Promise<void> {
    connection.status = 'connecting';
    connection.error = undefined;
    try {
      const timeout = timeoutFor(connection.config);
      const client = new Client({ name: 'ponte-mcp', version: '0.2.1' }, { capabilities: {} });
      connection.client = client;
      client.onclose = () => { if (this.current(connection)) void this.fail(connection, new HubError('Conexão MCP encerrada pelo servidor. Reconecte para continuar.')); };
      client.onerror = error => { if (this.current(connection)) void this.fail(connection, error); };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (!this.current(connection)) return;
        connection.refreshRequested = true;
        connection.definitions.clear();
        if (connection.status === 'connected' || connection.refreshing) {
          void this.refresh(connection).catch(error => this.fail(connection, error));
        }
      });
      connection.transport = this.transport(connection);
      await bounded(signal => client.connect(connection.transport!, { signal, timeout, maxTotalTimeout: timeout }), timeout, connection.abort.signal);
      if (!this.current(connection)) return;
      await this.refresh(connection);
    } catch (error) {
      await this.fail(connection, error);
    }
  }

  private transport(connection: Connection): Transport {
    const config = connection.config;
    if (config.transport === 'stdio') {
      if (!config.command) throw new HubError('Informe o executável do servidor MCP.');
      const parameters = {
        command: resolveReferences(config.command),
        args: (config.args ?? []).map(resolveReferences),
        ...(config.cwd ? { cwd: resolveReferences(config.cwd) } : {}),
        env: childEnvironment(resolveRecord(config.env)),
      };
      connection.connectionKey = digest(parameters);
      return new StdioClientTransport({ ...parameters, stderr: 'ignore', maxBufferSize: 16 * 1024 * 1024 });
    }
    const url = endpoint(config.url);
    const headers = resolveRecord(config.headers);
    try { new Headers(headers); } catch { throw new HubError('Os headers HTTP configurados são inválidos.'); }
    connection.connectionKey = digest({ transport: config.transport, url: url.href, headers });
    const safeFetch: typeof fetch = (input, init) => {
      const requested = new URL(input instanceof Request ? input.url : String(input));
      if (requested.origin !== url.origin) throw new HubError('O servidor MCP tentou acessar uma origem HTTP diferente da configurada.');
      const signals = [connection.abort.signal];
      if (init?.signal) signals.push(init.signal);
      return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    };
    const options = { requestInit: { headers, redirect: 'error' as const }, fetch: safeFetch, redirectPolicy: 'same-origin' as const };
    if (config.transport === 'sse') return new SSEClientTransport(url, options);
    if (config.transport !== 'http') throw new HubError('Transporte MCP não suportado.');
    return new StreamableHTTPClientTransport(url, {
      ...options,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    });
  }

  private async discover(connection: Connection, signal: AbortSignal): Promise<Tool[]> {
    const client = connection.client!;
    if (!client.getServerCapabilities()?.tools) return [];
    const collected: Tool[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOLS; page += 1) {
      // request() avoids the SDK v1 listTools cache being replaced by each page.
      const result = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema,
        { signal, timeout: timeoutFor(connection.config), resetTimeoutOnProgress: false, maxTotalTimeout: MAX_TIMEOUT_MS });
      if (collected.length + result.tools.length > MAX_TOOLS) throw new HubError('O catálogo MCP excede o limite de 500 ferramentas.');
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new HubError('O catálogo MCP contém nomes de ferramentas duplicados ou paginação circular.');
        names.add(tool.name);
        collected.push(tool);
      }
      if (result.nextCursor === undefined) return collected;
      if (cursors.has(result.nextCursor)) throw new HubError('Paginação MCP inválida: cursor repetido.');
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new HubError('Paginação MCP excede o limite de 500 páginas.');
  }

  private async refresh(connection: Connection): Promise<void> {
    connection.refreshRequested = true;
    if (connection.refreshing) return connection.refreshing;
    connection.status = 'connecting';
    connection.definitions.clear();
    const timeout = timeoutFor(connection.config);
    connection.refreshing = bounded(async signal => {
      let tools: Tool[] = [];
      do {
        connection.refreshRequested = false;
        tools = await this.discover(connection, signal);
      } while (connection.refreshRequested);
      if (!this.current(connection)) return;
      const definitions = this.definitions(connection, tools);
      connection.definitions = new Map(definitions.map(definition => [definition.tool.name, definition]));
      connection.status = 'connected';
      connection.error = undefined;
    }, timeout, connection.abort.signal).finally(() => { connection.refreshing = undefined; });
    return connection.refreshing;
  }

  private definitions(connection: Connection, tools: Tool[]): ToolDefinition[] {
    const config = connection.config;
    const allow = config.allowedTools === undefined ? undefined : new Set(config.allowedTools);
    const read = new Set(config.readOnlyTools ?? []);
    const exported = new Set<string>();
    return tools.filter(tool => !allow || allow.has(tool.name)).map(original => {
      const name = toolName(config.id, original.name);
      if (exported.has(name)) throw new HubError('Colisão de nomes no catálogo MCP. Altere o identificador da conexão.');
      exported.add(name);
      const risk = read.has(original.name) ? 'read' : 'execute';
      const fingerprint = digest({ config: config, connection: connection.connectionKey, tool: original });
      const { outputSchema: _output, execution: _execution, ...forwarded } = structuredClone(original);
      return {
        tool: {
          ...forwarded, name,
          annotations: { ...forwarded.annotations, readOnlyHint: risk === 'read', destructiveHint: risk !== 'read', idempotentHint: false },
        },
        risk, source: `mcp:${config.id}`, fingerprint,
        execute: (args, context) => this.call(connection, original.name, name, fingerprint, args, context),
      } satisfies ToolDefinition;
    });
  }

  private async call(connection: Connection, originalName: string, name: string, fingerprint: string, args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult> {
    if (context.signal.aborted) throw cancelled();
    if (!this.current(connection) || connection.status !== 'connected' || connection.definitions.get(name)?.fingerprint !== fingerprint) {
      throw new HubError('Ferramenta MCP alterada ou indisponível. Atualize o catálogo e revise a nova chamada.');
    }
    const timeout = timeoutFor(connection.config);
    try {
      const signal = AbortSignal.any([context.signal, connection.abort.signal]);
      // Keep the upstream CallToolResult intact, including binary blocks and isError.
      return await bounded(requestSignal => connection.client!.request({ method: 'tools/call', params: { name: originalName, arguments: args } }, CallToolResultSchema,
        { signal: requestSignal, timeout, resetTimeoutOnProgress: false, maxTotalTimeout: timeout }), timeout, signal);
    } catch (error) {
      if (context.signal.aborted) throw cancelled();
      if (connection.abort.signal.aborted || !this.current(connection)) {
        throw new HubError('Chamada interrompida por desconexão MCP. Confira o resultado no servidor antes de tentar novamente.');
      }
      if (error instanceof HubError || (error instanceof McpError && error.code === ErrorCode.RequestTimeout)) {
        throw new HubError('Tempo limite da chamada MCP excedido. A operação pode continuar no servidor; confira o resultado antes de tentar novamente.');
      }
      if (error instanceof McpError) throw new HubError(`Falha de protocolo MCP na chamada (código ${error.code}).`);
      throw new HubError('Falha ao executar a ferramenta MCP. A chamada não foi reenviada; confira o resultado no servidor.');
    }
  }

  private async fail(connection: Connection, error: unknown): Promise<void> {
    if (!this.current(connection)) return;
    connection.status = 'error';
    connection.error = connectionError(error);
    await this.dispose(connection);
  }

  private async dispose(connection: Connection): Promise<void> {
    if (connection.disposing) return connection.disposing;
    connection.disposed = true;
    connection.definitions.clear();
    connection.abort.abort();
    connection.disposing = (async () => {
      await Promise.allSettled([connection.client?.close() ?? connection.transport?.close()]);
    })();
    return connection.disposing;
  }
}
