import type { Request, Response } from 'express';
import { SUPPORTED_PROTOCOL_VERSIONS, type Tool, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const supportedVersions = [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];
const legacyVersions = new Set(SUPPORTED_PROTOCOL_VERSIONS);

export interface ModernMcpDependencies {
  getTools(): Tool[] | Promise<Tool[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  events: {
    observeRequest?(method: string): { accepted(): void; rejected(error: unknown): void } | undefined;
    list(principal: string, params: unknown): unknown | Promise<unknown>;
    subscribe(principal: string, params: unknown): Promise<unknown>;
    unsubscribe(principal: string, params: unknown): Promise<unknown>;
  };
  principal: string;
  version: string;
  instructions: string;
}

class ProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly status = 400, readonly data?: Record<string, unknown>) { super(message); }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validId(value: unknown): value is string | number { return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value)); }
function invalid(message: string): never { throw new ProtocolError(-32602, message); }
function mismatch(message: string): never { throw new ProtocolError(-32020, message); }
function safeHeader(value: unknown): value is string { return typeof value === 'string' && /^[\x20-\x7e\t]*$/.test(value) && value.trim() === value; }

function isModern(req: Request): boolean {
  const header = req.headers['mcp-protocol-version'];
  const body = req.body as unknown;
  const params = object(body) && object(body.params) ? body.params : undefined;
  const meta = params && object(params._meta) ? params._meta : undefined;
  const hasVersion = meta !== undefined && Object.hasOwn(meta, VERSION_KEY);
  const version = meta?.[VERSION_KEY];
  if (header !== undefined && (typeof header !== 'string' || !legacyVersions.has(header))) return true;
  if (hasVersion && (typeof version !== 'string' || !legacyVersions.has(version))) return true;
  // A modern method without a version is malformed, rather than an SDK1 request.
  return header === undefined && !hasVersion && object(body) && typeof body.method === 'string'
    && (body.method === 'server/discover' || body.method.startsWith('events/'));
}

function validateMedia(req: Request): void {
  if (req.method !== 'POST') throw new ProtocolError(-32600, 'O endpoint MCP aceita POST.', 405);
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ProtocolError(-32600, 'Content-Type deve ser application/json.', 415);
  }
  const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  if (charset && !['utf-8', 'utf8'].includes((charset[1] ?? charset[2] ?? '').toLowerCase())) {
    throw new ProtocolError(-32600, 'O corpo JSON deve usar UTF-8.', 415);
  }
  const accept = req.headers.accept;
  const accepted = new Set(typeof accept === 'string' ? accept.split(',').flatMap(entry => {
    const [media, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='))?.trim().slice(2);
    return media && (quality === undefined || (Number(quality) > 0 && Number(quality) <= 1)) ? [media.trim()] : [];
  }) : []);
  if (!accepted.has('application/json') || !accepted.has('text/event-stream')) {
    throw new ProtocolError(-32600, 'Accept deve incluir application/json e text/event-stream.', 406);
  }
}

function validateRequest(req: Request): { id: string | number; method: string; params: Record<string, unknown> } {
  const body: unknown = req.body;
  if (!object(body) || body.jsonrpc !== '2.0' || !validId(body.id) || typeof body.method !== 'string' || !body.method) {
    throw new ProtocolError(-32600, 'Solicitação JSON-RPC inválida; esta versão não aceita notificações independentes.');
  }
  const params = body.params;
  if (!object(params) || !object(params._meta)) invalid('Metadados MCP obrigatórios ausentes.');
  const meta = params._meta;
  const version = meta[VERSION_KEY];
  if (typeof version !== 'string' || !version || !object(meta[CAPABILITIES_KEY])) invalid('Versão e capacidades do cliente são obrigatórias em _meta.');
  const clientInfo = meta[CLIENT_INFO_KEY];
  if (clientInfo !== undefined && (!object(clientInfo) || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string')) invalid('clientInfo inválido.');
  const logLevel = meta['io.modelcontextprotocol/logLevel'];
  if (logLevel !== undefined && (typeof logLevel !== 'string' || !['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(logLevel))) invalid('logLevel inválido.');
  const header = req.headers['mcp-protocol-version'];
  if (!safeHeader(header) || header !== version) mismatch('MCP-Protocol-Version ausente ou divergente de _meta.');
  if (!safeHeader(req.headers['mcp-method']) || req.headers['mcp-method'] !== body.method) mismatch('Mcp-Method ausente ou divergente do método.');
  if (version !== MODERN_PROTOCOL_VERSION) {
    throw new ProtocolError(-32022, 'Versão de protocolo não suportada nesta requisição.', 400, { supported: supportedVersions, requested: version });
  }
  const { _meta: _transportMetadata, ...applicationParams } = params;
  return { id: body.id, method: body.method, params: applicationParams };
}

function decodeHeader(value: unknown): string {
  if (!safeHeader(value)) mismatch('Cabeçalho MCP obrigatório ausente ou malformado.');
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) mismatch('Base64 inválido no cabeçalho MCP.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) mismatch('Base64 não canônico no cabeçalho MCP.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return mismatch('UTF-8 inválido no cabeçalho MCP.'); }
}

interface Mirror { header: string; path: string[]; type: 'string' | 'integer' | 'boolean' }
const schemaMaps = new Set(['patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaChildren = new Set(['items', 'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function headerMirrors(schema: unknown): Mirror[] {
  const mirrors: Mirror[] = []; const names = new Set<string>(); let visited = 0;
  function visit(node: unknown, propertyPath: string[] | null, depth: number): void {
    if (!object(node)) return;
    if (++visited > 4096 || depth > 64) throw new Error('Schema excede limite de inspeção.');
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      if (!propertyPath?.length || typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
        || typeof node.type !== 'string' || !['string', 'integer', 'boolean'].includes(node.type) || names.has(name.toLowerCase())) throw new Error('Anotação x-mcp-header inválida.');
      names.add(name.toLowerCase());
      mirrors.push({ header: `mcp-param-${name.toLowerCase()}`, path: propertyPath, type: node.type as Mirror['type'] });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && object(value)) {
        for (const [property, child] of Object.entries(value)) visit(child, propertyPath === null ? null : [...propertyPath, property], depth + 1);
      } else if (schemaMaps.has(key) && object(value)) {
        for (const child of Object.values(value)) visit(child, null, depth + 1);
      } else if (schemaChildren.has(key)) {
        if (Array.isArray(value)) for (const child of value) visit(child, null, depth + 1);
        else visit(value, null, depth + 1);
      } else if (schemaArrays.has(key) && Array.isArray(value)) {
        for (const child of value) visit(child, null, depth + 1);
      }
    }
  }
  visit(schema, [], 0);
  return mirrors;
}

async function availableTools(deps: ModernMcpDependencies): Promise<Array<{ tool: Tool; mirrors: Mirror[] }>> {
  const tools = await deps.getTools();
  return tools.flatMap(tool => {
    try { return [{ tool, mirrors: headerMirrors(tool.inputSchema) }]; }
    catch { return []; } // A malformed upstream definition must not advertise an unusable mirrored header.
  });
}

function validateMirrors(req: Request, mirrors: Mirror[], args: Record<string, unknown>): void {
  for (const mirror of mirrors) {
    let value: unknown = args;
    for (const property of mirror.path) value = object(value) && Object.hasOwn(value, property) ? value[property] : undefined;
    const header = req.headers[mirror.header];
    if (value === undefined || value === null) {
      if (header !== undefined) mismatch('Cabeçalho Mcp-Param deve ser omitido para um argumento ausente ou nulo.');
      continue;
    }
    const decoded = decodeHeader(header);
    const matches = mirror.type === 'integer'
      ? typeof value === 'number' && Number.isSafeInteger(value) && /^-?(?:0|[1-9]\d*)(?:\.0+)?$/.test(decoded) && Number(decoded) === value
      : typeof value === mirror.type && decoded === String(value);
    if (!matches) mismatch('Cabeçalho Mcp-Param divergente do argumento.');
  }
}

function complete(result: unknown, deps: ModernMcpDependencies): Record<string, unknown> {
  if (!object(result)) throw new Error('Resultado MCP interno inválido.');
  return { ...result, resultType: 'complete', _meta: { ...(object(result._meta) ? result._meta : {}), [SERVER_INFO_KEY]: { name: 'ponte-mcp', version: deps.version } } };
}

/** Called only after the endpoint's existing bearer and Origin checks. */
export async function handleModernMcp(req: Request, res: Response, deps: ModernMcpDependencies): Promise<boolean> {
  if (!isModern(req)) return false;
  const rawBody: unknown = req.body;
  const id = object(rawBody) && validId(rawBody.id) ? rawBody.id : undefined;
  const observedMethod = object(rawBody) && typeof rawBody.method === 'string' ? rawBody.method : req.headers['mcp-method'];
  const observation = typeof observedMethod === 'string' ? deps.events.observeRequest?.(observedMethod) : undefined;
  try {
    validateMedia(req);
    const request = validateRequest(req);
    const { method, params } = request;
    let result: unknown;
    if (method === 'server/discover') {
      if (Object.keys(params).length) invalid('server/discover não recebe argumentos além de _meta.');
      result = { supportedVersions, capabilities: { tools: {}, events: {} }, instructions: deps.instructions, ttlMs: 0, cacheScope: 'private' };
    } else if (method === 'tools/list') {
      if (Object.keys(params).some(key => key !== 'cursor')) invalid('Parâmetros de tools/list inválidos.');
      const cursor = params.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor))) invalid('Cursor inválido.');
      const offset = Number(cursor ?? 0);
      const tools = (await availableTools(deps)).map(item => item.tool);
      if (!Number.isSafeInteger(offset) || offset > tools.length) invalid('Cursor inválido ou expirado.');
      result = { tools: tools.slice(offset, offset + 100), ...(offset + 100 < tools.length ? { nextCursor: String(offset + 100) } : {}), ttlMs: 0, cacheScope: 'private' };
    } else if (method === 'tools/call') {
      if (typeof params.name !== 'string' || !params.name || (params.arguments !== undefined && !object(params.arguments))) invalid('Nome e argumentos da ferramenta inválidos.');
      if (decodeHeader(req.headers['mcp-name']) !== params.name) mismatch('Mcp-Name ausente ou divergente do nome da ferramenta.');
      const entry = (await availableTools(deps)).find(item => item.tool.name === params.name);
      if (!entry) invalid('Ferramenta desconhecida ou indisponível.');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      validateMirrors(req, entry.mirrors, args);
      result = await deps.call(params.name, args);
    } else if (method === 'events/list') {
      result = await deps.events.list(deps.principal, params);
    } else if (method === 'events/subscribe') {
      result = await deps.events.subscribe(deps.principal, params);
    } else if (method === 'events/unsubscribe') {
      result = await deps.events.unsubscribe(deps.principal, params);
    } else {
      throw new ProtocolError(-32601, 'Método MCP não implementado.', 404);
    }
    const response = { jsonrpc: '2.0', id: request.id, result: complete(result, deps) };
    observation?.accepted();
    res.status(200).json(response);
  } catch (error) {
    observation?.rejected(error);
    const protocol = error as { code?: unknown; message?: unknown; data?: unknown } | null;
    const known = typeof protocol?.code === 'number' && Number.isInteger(protocol.code);
    const code = known ? protocol.code as number : -32603;
    const status = error instanceof ProtocolError ? error.status : !known ? 500 : code === -32024 ? 403 : code === -32025 ? 429 : 400;
    if (status === 405) res.set('Allow', 'POST');
    res.status(status).json({
      jsonrpc: '2.0', ...(id !== undefined ? { id } : {}),
      error: { code, message: known && typeof protocol?.message === 'string' ? protocol.message.slice(0, 300) : 'Falha interna ao processar a solicitação MCP.', ...(known && protocol?.data !== undefined ? { data: protocol.data } : {}) },
    });
  }
  return true;
}
