import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { validateHeaderName, validateHeaderValue, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';

export type WebhookPost = (url: string, body: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; body: string }>;

const MAX_BODY = 262_144;
const MAX_RESPONSE = 65_536;
const TIMEOUT_MS = 10_000;
const REASONS: Record<string, string> = {
  invalid_url: 'O callback precisa ter uma URL HTTPS válida.',
  blocked_address: 'O callback precisa apontar para um endereço público permitido.',
  invalid_secret: 'A chave de assinatura do callback é inválida.',
  invalid_headers: 'Os cabeçalhos do webhook são inválidos.',
  payload_too_large: 'O evento excede o limite de 256 KiB.',
  response_too_large: 'A resposta do callback excedeu o limite permitido.',
  dns_error: 'Não foi possível resolver o endereço do callback.',
  tls_error: 'Não foi possível verificar a conexão TLS do callback.',
  timeout: 'O callback não respondeu dentro do prazo.',
  aborted: 'A entrega do webhook foi interrompida.',
  network_error: 'Não foi possível concluir a conexão com o callback.',
  challenge_failed: 'O callback não confirmou o desafio de verificação.',
  http_redirect: 'O callback respondeu com um redirecionamento não permitido.',
  http_4xx: 'O callback recusou a solicitação.',
  http_5xx: 'O callback apresentou uma falha temporária.',
  http_error: 'O callback devolveu uma resposta HTTP inesperada.',
};

export class CallbackError extends Error {
  readonly code = -32015;
  readonly reason: string;
  readonly data: { reason: string };
  constructor(reason: string) {
    const safeReason = Object.hasOwn(REASONS, reason) ? reason : 'network_error';
    super(REASONS[safeReason]);
    this.name = 'CallbackError';
    this.reason = safeReason;
    this.data = { reason: safeReason };
  }
}

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(address, prefix, 'ipv6');

/** Conservative public-unicast policy; special-purpose/translation ranges are excluded. */
export function isPublicAddress(address: string): boolean {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ''); }

export function validateCallbackUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > 4096 || !/^https:\/\//i.test(input) || /[\x00-\x20\x7f\\]/.test(input) || input.includes('#')) throw new CallbackError('invalid_url');
  let url: URL;
  try { url = new URL(input); } catch { throw new CallbackError('invalid_url'); }
  const authority = input.slice(input.indexOf('://') + 3).split(/[/?#]/, 1)[0]!;
  if (url.protocol !== 'https:' || !url.hostname || authority.includes('@') || url.username || url.password || (url.port && Number(url.port) < 1)) throw new CallbackError('invalid_url');
  const host = hostname(url).toLowerCase().replace(/\.$/, '');
  if (/^(localhost|localhost\.localdomain)$/.test(host) || /\.(localhost|local|localdomain|internal|home\.arpa)$/.test(host) || host === 'home.arpa') throw new CallbackError('blocked_address');
  if (isIP(host) && !isPublicAddress(host)) throw new CallbackError('blocked_address');
  return url;
}

export function decodeWebhookSecret(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_') || secret.length > 94) throw new CallbackError('invalid_secret');
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new CallbackError('invalid_secret');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new CallbackError('invalid_secret');
  // Padding, when present, must be canonical rather than ignored by Buffer.
  if (encoded.includes('=') && decoded.toString('base64') !== encoded) throw new CallbackError('invalid_secret');
  return decoded;
}

export function webhookHeaders(subscriptionId: string, eventId: string, body: string, secrets: string[], nowMs = Date.now()): Record<string, string> {
  if (![subscriptionId, eventId].every(id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id)) || !Number.isFinite(nowMs) || nowMs < 0) throw new CallbackError('invalid_headers');
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) throw new CallbackError('payload_too_large');
  if (secrets.length < 1 || secrets.length > 2) throw new CallbackError('invalid_secret');
  const timestamp = String(Math.floor(nowMs / 1000));
  const signed = `${eventId}.${timestamp}.${body}`;
  const signatures = secrets.map(secret => 'v1,' + createHmac('sha256', decodeWebhookSecret(secret)).update(signed, 'utf8').digest('base64'));
  return {
    'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscriptionId,
  };
}

interface Address { address: string; family: number }
interface WebhookNetwork {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: typeof httpsRequest;
}

class ConnectionFailure extends CallbackError {
  constructor() { super('network_error'); }
}
const CONNECT_ERRORS = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'EADDRNOTAVAIL', 'ECONNRESET', 'ETIMEDOUT']);

function cleanHeaders(headers: Record<string, string>): Record<string, string> {
  const allowed = new Set(['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']);
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!allowed.has(lower) || seen.has(lower) || typeof value !== 'string' || value.length > 1024) throw new CallbackError('invalid_headers');
    try { validateHeaderName(name); validateHeaderValue(name, value); } catch { throw new CallbackError('invalid_headers'); }
    seen.add(lower);
    if (lower === 'content-type' && value !== 'application/json') throw new CallbackError('invalid_headers');
  }
  if (seen.size !== allowed.size) throw new CallbackError('invalid_headers');
  return { ...headers };
}

function networkError(error: unknown, signal: AbortSignal): CallbackError {
  if (signal.aborted) return signal.reason instanceof CallbackError ? signal.reason : new CallbackError('aborted');
  if (error instanceof CallbackError) return error;
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  if (code === 'ERR_CALLBACK_ADDRESS_BLOCKED') return new CallbackError('blocked_address');
  return new CallbackError(/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code) ? 'tls_error' : 'network_error');
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** The injectable network boundary is used by tests; address validation cannot be disabled. */
export function createWebhookPost(network: WebhookNetwork = {}): WebhookPost {
  const resolve = network.resolve ?? (async host => dnsLookup(host, { all: true, verbatim: true }));
  const request = network.request ?? httpsRequest;
  return async (input, body, headers, externalSignal) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new CallbackError('timeout')), TIMEOUT_MS);
    const cancel = () => controller.abort(new CallbackError('aborted'));
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const url = validateCallbackUrl(input);
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) throw new CallbackError('payload_too_large');
      const outgoingHeaders = cleanHeaders(headers);
      const host = hostname(url);
      const literalFamily = isIP(host);
      const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await withAbort(resolve(host).catch(() => { throw new CallbackError('dns_error'); }), controller.signal);
      if (!addresses.length || addresses.length > 64) throw new CallbackError('dns_error');
      if (addresses.some(address => !isPublicAddress(address.address) || isIP(address.address) !== address.family)) throw new CallbackError('blocked_address');
      const candidates = addresses.filter((entry, index) => addresses.findIndex(other => other.address === entry.address && other.family === entry.family) === index).slice(0, 8);
      for (const selected of candidates) {
        if (controller.signal.aborted) throw controller.signal.reason;
        try { return await new Promise<{ status: number; body: string }>((accept, reject) => {
          let settled = false;
          let secureConnected = false;
          let responseReceived = false;
          let incoming: IncomingMessage | undefined;
          const finish = (error?: unknown, value?: { status: number; body: string }) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', abort);
            const code = (error as { code?: string } | undefined)?.code;
            if (error && !secureConnected && !responseReceived && !controller.signal.aborted && code && CONNECT_ERRORS.has(code)) reject(new ConnectionFailure());
            else if (error) reject(networkError(error, controller.signal));
            else accept(value!);
          };
          const options: RequestOptions & { autoSelectFamily: boolean } = {
            protocol: 'https:', hostname: host, port: Number(url.port || 443), path: url.pathname + url.search,
            method: 'POST', agent: false, family: selected.family, autoSelectFamily: false,
            rejectUnauthorized: true, ...(literalFamily ? {} : { servername: host }), maxHeaderSize: 16_384,
            headers: { ...outgoingHeaders, Host: url.host, 'Content-Length': Buffer.byteLength(body) },
            lookup: (requestedHost, options, callback) => {
              if (requestedHost !== host) { callback(Object.assign(new Error('Callback address blocked'), { code: 'ERR_CALLBACK_ADDRESS_BLOCKED' }), '', 0); return; }
              if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
              else callback(null, selected.address, selected.family);
            },
          };
          const outgoing = request(options, response => {
            responseReceived = true;
            incoming = response;
            const chunks: Buffer[] = [];
            let bytes = 0;
            const fail = (error: CallbackError) => { finish(error); response.destroy(); outgoing.destroy(error); };
            response.once('error', error => finish(error));
            response.once('aborted', () => finish(new CallbackError('network_error')));
            const contentLength = response.headers['content-length'];
            if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE)) { fail(new CallbackError('response_too_large')); return; }
            response.on('data', (chunk: Buffer | string) => {
              if (settled) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > MAX_RESPONSE) { fail(new CallbackError('response_too_large')); return; }
              chunks.push(buffer);
            });
            response.once('end', () => {
              if (!response.statusCode) { finish(new CallbackError('network_error')); return; }
              // Native https never follows Location. Returning 3xx leaves policy to the caller.
              finish(undefined, { status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            });
          });
          const abort = () => {
            finish(controller.signal.reason);
            incoming?.destroy();
            outgoing.destroy(new CallbackError(controller.signal.reason?.reason ?? 'aborted'));
          };
          controller.signal.addEventListener('abort', abort, { once: true });
          outgoing.once('socket', socket => socket.once('secureConnect', () => { secureConnected = true; }));
          outgoing.once('error', error => finish(error));
          if (controller.signal.aborted) abort();
          else outgoing.end(body, 'utf8');
        }); }
        catch (error) { if (!(error instanceof ConnectionFailure)) throw error; }
      }
      throw new CallbackError('network_error');
    } catch (error) { throw networkError(error, controller.signal); }
    finally { clearTimeout(timeout); externalSignal?.removeEventListener('abort', cancel); }
  };
}

export const postWebhook: WebhookPost = createWebhookPost();

export async function verifyCallback(options: { url: string; secret: string; subscriptionId: string }, post: WebhookPost = postWebhook, signal?: AbortSignal): Promise<void> {
  validateCallbackUrl(options.url);
  decodeWebhookSecret(options.secret);
  if (signal?.aborted) throw new CallbackError('aborted');
  const challenge = randomBytes(32).toString('base64url');
  const body = JSON.stringify({ type: 'verification', challenge });
  const eventId = 'msg_verification_' + randomUUID();
  const started = Date.now();
  let response: { status: number; body: string };
  try { response = await post(options.url, body, webhookHeaders(options.subscriptionId, eventId, body, [options.secret], started), signal); }
  catch (error) {
    if (signal?.aborted) throw new CallbackError('aborted');
    throw error instanceof CallbackError ? error : new CallbackError('network_error');
  }
  if (signal?.aborted) throw new CallbackError('aborted');
  if (Date.now() - started > TIMEOUT_MS) throw new CallbackError('timeout');
  if (response.status < 200 || response.status > 299) throw new CallbackError(response.status >= 300 && response.status < 400 ? 'http_redirect' : response.status >= 400 && response.status < 500 ? 'http_4xx' : response.status >= 500 && response.status < 600 ? 'http_5xx' : 'http_error');
  let echoed: unknown;
  try { echoed = JSON.parse(response.body)?.challenge; } catch { throw new CallbackError('challenge_failed'); }
  if (typeof echoed !== 'string' || echoed.length !== challenge.length) throw new CallbackError('challenge_failed');
  const expected = Buffer.from(challenge); const actual = Buffer.from(echoed);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CallbackError('challenge_failed');
}
