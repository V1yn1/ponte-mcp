import { createHash, timingSafeEqual } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';

export const REQUEST_LIMIT = 1024 * 1024;
export const RESPONSE_LIMIT = 8 * 1024 * 1024;
export const ENVELOPE_LIMIT = Math.ceil(RESPONSE_LIMIT * 4 / 3) + 32768;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const requestHeaders = new Set(['authorization', 'accept', 'content-type', 'origin', 'user-agent', 'accept-language', 'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'last-event-id', 'idempotency-key']);
const responseHeaders = new Set(['allow', 'content-type', 'location', 'www-authenticate', 'retry-after', 'cache-control', 'content-security-policy', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'etag', 'last-modified']);
const reads = new Set(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/oauth/consent', '/oauth/consent/status', '/oauth/complete', '/oauth/consent.js', '/oauth/consent.css', '/assets/ponte-mark.png', '/openapi.json', '/v1/status', '/v1/tools', '/v1/watchers', '/v1/mcp/tools']);
const writes = new Set(['/mcp', '/authorize', '/register', '/token', '/revoke', '/v1/jobs', '/v1/mcp/call']);
const uuidPath = '[a-fA-F0-9-]{36}';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function validateToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9+/_=-]{43,128}$/.test(token)) throw new Error('Configure um segredo exclusivo do relay, gerado com pelo menos 32 bytes aleatórios.');
  return token;
}
export function authorized(header, token) {
  if (typeof header !== 'string' || header.length > 256) return false;
  const expected = createHash('sha256').update('Bearer ' + token).digest();
  return timingSafeEqual(createHash('sha256').update(header).digest(), expected);
}
export function relayOrigin(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error('URL do relay inválida.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('Use somente a origem HTTPS do relay, sem /mcp. HTTP é permitido apenas em 127.0.0.1 para testes locais.');
  }
  return url.origin;
}
export function allowedRoute(method, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length > 8192 || !rawPath.startsWith('/') || rawPath.startsWith('//') || /[\x00-\x20\x7f\\#]/.test(rawPath)) return false;
  const pathname = rawPath.split('?')[0];
  // Do not normalize untrusted paths: encoded paths and dot-segments are not needed.
  if (pathname.includes('%') || pathname.split('/').some(part => part === '.' || part === '..')) return false;
  if (pathname === '/mcp' && ['GET', 'HEAD', 'DELETE', 'POST'].includes(method)) return true;
  if (method === 'GET' || method === 'HEAD') return reads.has(pathname) || new RegExp(`^/v1/(?:jobs|watchers)/${uuidPath}$`).test(pathname);
  if (method !== 'POST') return false;
  return writes.has(pathname) || new RegExp(`^/v1/jobs/${uuidPath}/cancel$`).test(pathname) ||
    new RegExp(`^/v1/watchers/${uuidPath}/(?:wait|cancel)$`).test(pathname) || new RegExp(`^/hooks/watchers/${uuidPath}/signal$`).test(pathname);
}
export function filterHeaders(input, direction) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Cabeçalhos inválidos.');
  const allow = direction === 'request' ? requestHeaders : responseHeaders;
  const out = {};
  let size = 0;
  for (const [raw, value] of Object.entries(input)) {
    const key = raw.toLowerCase();
    if (!allow.has(key)) continue;
    if (typeof value !== 'string') throw new HttpError(400, 'Cabeçalho inválido.');
    try { validateHeaderName(key); validateHeaderValue(key, value); } catch { throw new HttpError(400, 'Cabeçalho inválido.'); }
    size += Buffer.byteLength(key + value);
    if (size > 16384) throw new HttpError(431, 'Cabeçalhos muito grandes.');
    out[key] = value;
  }
  return out;
}
export function decodeBody(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0) throw new HttpError(400, 'Corpo inválido.');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new HttpError(400, 'Corpo inválido.');
  if (decoded.length > limit) throw new HttpError(413, 'Corpo acima do limite.');
  return decoded;
}
export function readRequest(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort); };
    const onError = () => { cleanup(); reject(new HttpError(400, 'Leitura interrompida.')); };
    const onAbort = onError;
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) { cleanup(); req.resume(); reject(new HttpError(413, 'Corpo acima do limite.')); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    if (Number(req.headers['content-length']) > limit) { req.resume(); reject(new HttpError(413, 'Corpo acima do limite.')); return; }
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}
export async function readResponse(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new HttpError(413, 'Resposta acima do limite.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}
export function transportFailure(error, sent = false) {
  return { error, executionState: sent ? 'unknown' : 'not_sent',
    message: sent ? 'A comunicação foi interrompida. A tarefa pode ter sido executada. Consulte o mesmo jobId/watcherId e confira o executor; não reenvie a demanda.'
      : 'A requisição não foi encaminhada. Confira se a Ponte e o agente local estão conectados.' };
}
