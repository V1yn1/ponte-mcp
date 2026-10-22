import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import {
  CallbackError, createWebhookPost, decodeWebhookSecret, isPublicAddress,
  validateCallbackUrl, verifyCallback, webhookHeaders,
} from '../src/events/webhook.js';

const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OLD_SECRET = 'whsec_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';
const BODY = '{"eventId":"evt_fixed","data":{"status":"succeeded"}}';
const NOW = 1792656000000;
const HEADERS = () => webhookHeaders('sub_fixed', 'evt_fixed', BODY, [SECRET], NOW);
const callback = 'https://receiver.example.com/events/private-routing-value';

function reason(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CallbackError);
    assert.equal(error.code, -32015);
    assert.equal(error.reason, expected);
    assert.deepEqual(error.data, { reason: expected });
    assert.ok(!String(error).includes('private-routing-value'));
    assert.ok(!String(error).includes(SECRET));
    return true;
  };
}

function networkFixture(status = 200, responseBody = '{}', options: { stall?: boolean; declaredLength?: string; chunks?: Buffer[]; error?: Error; connected?: boolean } = {}) {
  const requests: RequestOptions[] = [];
  const bodies: string[] = [];
  const destroyed: Error[] = [];
  const request = ((requestOptions: RequestOptions, responseCallback: (response: IncomingMessage) => void) => {
    requests.push(requestOptions);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = ((error?: Error) => {
      if (error) destroyed.push(error);
      queueMicrotask(() => outgoing.emit('error', error ?? new Error('destroyed')));
      return outgoing;
    }) as ClientRequest['destroy'];
    outgoing.end = ((body: string) => {
      bodies.push(body);
      queueMicrotask(() => {
        if (options.connected) { const socket = new EventEmitter(); outgoing.emit('socket', socket); socket.emit('secureConnect'); }
        if (options.error) { outgoing.emit('error', options.error); return; }
        const incoming = new PassThrough() as IncomingMessage;
        incoming.statusCode = status;
        incoming.headers = options.declaredLength ? { 'content-length': options.declaredLength } : {};
        responseCallback(incoming);
        if (options.stall) return;
        for (const chunk of options.chunks ?? [Buffer.from(responseBody)]) incoming.write(chunk);
        incoming.end();
      });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  }) as NonNullable<Parameters<typeof createWebhookPost>[0]>['request'];
  return { request, requests, bodies, destroyed };
}

test('webhook signing matches an independently generated Standard Webhooks HMAC vector and rotates keys', () => {
  // Expected HMAC bytes were generated with Python hmac/hashlib from bytes(range(32)).
  const headers = webhookHeaders('sub_fixed', 'evt_fixed', BODY, [SECRET, OLD_SECRET], NOW);
  assert.equal(headers['webhook-signature'], 'v1,6DU8VJBxKSaPoXpMfUgVAC/9RGMQ0v75249y5IvOjyU= v1,s5De2fT8Ywh21caKQLWSa4NHgKTgfJKFjCyhdtEVHe0=');
  assert.equal(headers['webhook-id'], 'evt_fixed');
  assert.equal(headers['webhook-timestamp'], '1792656000');
  assert.equal(headers['X-MCP-Subscription-Id'], 'sub_fixed');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.notEqual(webhookHeaders('sub_fixed', 'evt_fixed', BODY + ' ', [SECRET], NOW)['webhook-signature'], headers['webhook-signature'].split(' ')[0]);
});

test('signing keys strictly decode 24–64 bytes and reject malformed or ambiguous input', () => {
  assert.deepEqual(decodeWebhookSecret(SECRET), Buffer.from(Array.from({ length: 32 }, (_, n) => n)));
  assert.equal(decodeWebhookSecret('whsec_' + Buffer.alloc(24).toString('base64')).length, 24);
  assert.equal(decodeWebhookSecret('whsec_' + Buffer.alloc(64).toString('base64')).length, 64);
  assert.equal(decodeWebhookSecret(SECRET.replace(/=$/, '')).length, 32);
  for (const secret of ['', 'abc', SECRET + '=', SECRET + '\n', SECRET.replace('whsec_', ''), 'whsec_@@@@', 'whsec_' + Buffer.alloc(23).toString('base64'), 'whsec_' + Buffer.alloc(65).toString('base64')]) {
    assert.throws(() => decodeWebhookSecret(secret), reason('invalid_secret'));
  }
});

test('callback URLs reject local address spellings, user information, fragments, controls, and non-HTTPS schemes', () => {
  assert.equal(validateCallbackUrl(callback).href, callback);
  assert.equal(validateCallbackUrl('https://[2606:4700:4700::1111]/hook').protocol, 'https:');
  for (const url of ['http://example.com/hook', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com/#secret', ' https://example.com/', 'https://example.com/\nheader', 'https://example.com\\@127.0.0.1', 'https://localhost/', 'https://localhost./', 'https://service.local/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/latest/meta-data', 'https://[fe80::1%25eth0]/', 'https://example.com/' + 'a'.repeat(4096)]) {
    assert.throws(() => validateCallbackUrl(url), (error: unknown) => error instanceof CallbackError && ['invalid_url', 'blocked_address'].includes(error.reason), url);
  }
});

test('public-address filtering rejects private and special IPv4/IPv6 networks including translation bypasses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.2', '169.254.1.1', '172.16.1.1', '172.31.255.254', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.254', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', '::ffff:192.168.1.1', '64:ff9b::a00:1', '64:ff9b:1::1', '100::1', '2001::1', '2001:2::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', '5f00::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', 'garbage']) assert.equal(isPublicAddress(address), false, address);
});

test('callback verification uses fresh signed challenges and accepts only a matching successful echo', async () => {
  const sent: { body: string; headers: Record<string, string> }[] = [];
  const post = async (_url: string, body: string, headers: Record<string, string>) => {
    sent.push({ body, headers });
    const parsed = JSON.parse(body);
    assert.equal(parsed.type, 'verification');
    assert.equal(typeof parsed.challenge, 'string');
    assert.ok(parsed.challenge.length >= 32);
    assert.equal(headers['webhook-signature'], webhookHeaders('sub_fixed', headers['webhook-id']!, body, [SECRET], Number(headers['webhook-timestamp']) * 1000)['webhook-signature']);
    return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
  };
  await verifyCallback({ url: callback, secret: SECRET, subscriptionId: 'sub_fixed' }, post);
  await verifyCallback({ url: callback, secret: SECRET, subscriptionId: 'sub_fixed' }, post);
  assert.notEqual(sent[0]!.body, sent[1]!.body);
  assert.notEqual(sent[0]!.headers['webhook-id'], sent[1]!.headers['webhook-id']);
  for (const reply of [{ status: 200, body: '{"challenge":"wrong"}' }, { status: 200, body: 'not json' }, { status: 204, body: '' }]) {
    await assert.rejects(verifyCallback({ url: callback, secret: SECRET, subscriptionId: 'sub_fixed' }, async () => reply), reason('challenge_failed'));
  }
  await assert.rejects(verifyCallback({ url: callback, secret: SECRET, subscriptionId: 'sub_fixed' }, async (_url, body) => ({ status: 500, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) })), reason('http_5xx'));
});

test('verification validates callback URL and secret before invoking an injected transport', async () => {
  let called = false;
  const post = async () => { called = true; return { status: 200, body: '{}' }; };
  await assert.rejects(verifyCallback({ url: 'https://127.0.0.1/', secret: SECRET, subscriptionId: 'sub_fixed' }, post), reason('blocked_address'));
  await assert.rejects(verifyCallback({ url: callback, secret: 'bad', subscriptionId: 'sub_fixed' }, post), reason('invalid_secret'));
  assert.equal(called, false);
});

test('each connection resolves DNS once, pins the validated address, and preserves TLS and Host identity', async () => {
  let resolutions = 0;
  const fixture = networkFixture(202, '{"accepted":true}');
  const post = createWebhookPost({ resolve: async host => {
    assert.equal(host, 'receiver.example.com'); resolutions++;
    return [{ address: '93.184.216.34', family: 4 }];
  }, request: fixture.request });
  assert.deepEqual(await post(callback, BODY, HEADERS()), { status: 202, body: '{"accepted":true}' });
  const options = fixture.requests[0]!;
  assert.equal(options.hostname, 'receiver.example.com');
  assert.equal(options.servername, 'receiver.example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.method, 'POST');
  assert.equal((options.headers as Record<string, string>).Host, 'receiver.example.com');
  assert.equal(options.path, '/events/private-routing-value');
  const address = await new Promise((resolve, reject) => (options.lookup as Function)('receiver.example.com', {}, (error: Error | null, ip: string, family: number) => error ? reject(error) : resolve({ ip, family })));
  assert.deepEqual(address, { ip: '93.184.216.34', family: 4 });
  const all = await new Promise((resolve, reject) => (options.lookup as Function)('receiver.example.com', { all: true }, (error: Error | null, addresses: unknown) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(resolutions, 1, 'socket lookup must not resolve DNS a second time');
  assert.deepEqual(fixture.bodies, [BODY]);
  await post(callback, BODY, HEADERS());
  assert.equal(resolutions, 2, 'new deliveries must revalidate DNS');
});

test('mixed or newly private DNS answers are blocked before a connection is created', async () => {
  let resolutions = 0;
  const fixture = networkFixture();
  const post = createWebhookPost({ resolve: async () => ++resolutions === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }], request: fixture.request });
  await post(callback, BODY, HEADERS());
  await assert.rejects(post(callback, BODY, HEADERS()), reason('blocked_address'));
  assert.equal(fixture.requests.length, 1);
  for (const answers of [[], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::ffff:127.0.0.1', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const blocked = createWebhookPost({ resolve: async () => answers, request: fixture.request });
    await assert.rejects(blocked(callback, BODY, HEADERS()), (error: unknown) => error instanceof CallbackError && ['dns_error', 'blocked_address'].includes(error.reason));
  }
  assert.equal(fixture.requests.length, 1);
});

test('an unreachable public IPv6 address falls back to validated IPv4 within the same delivery', async () => {
  const failed = networkFixture(200, '', { error: Object.assign(new Error('connect failed'), { code: 'ENETUNREACH' }) });
  const successful = networkFixture(202, '{"accepted":true}');
  let requests = 0;
  const request = ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    requests++;
    return (requests === 1 ? failed.request! : successful.request!)(options, callback);
  }) as NonNullable<Parameters<typeof createWebhookPost>[0]>['request'];
  const post = createWebhookPost({ resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }], request });
  assert.deepEqual(await post(callback, BODY, HEADERS()), { status: 202, body: '{"accepted":true}' });
  assert.equal(requests, 2);
  const pinned = await new Promise((resolve, reject) => (successful.requests[0]!.lookup as Function)('receiver.example.com', {}, (error: Error | null, ip: string) => error ? reject(error) : resolve(ip)));
  assert.equal(pinned, '8.8.8.8');
  assert.deepEqual(successful.bodies, [BODY]);
});

test('fallback never repeats a delivery after an HTTP response or after TLS connected', async () => {
  const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
  const response = networkFixture(503, '{}');
  const post = createWebhookPost({ resolve: async () => addresses, request: response.request });
  assert.equal((await post(callback, BODY, HEADERS())).status, 503);
  assert.equal(response.requests.length, 1);
  const disconnected = networkFixture(200, '', { connected: true, error: Object.assign(new Error('response uncertain'), { code: 'ECONNRESET' }) });
  await assert.rejects(createWebhookPost({ resolve: async () => addresses, request: disconnected.request })(callback, BODY, HEADERS()), reason('network_error'));
  assert.equal(disconnected.requests.length, 1);
});

test('redirects are returned once and never followed to another destination', async () => {
  const fixture = networkFixture(302, 'do not expose this');
  const post = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fixture.request });
  const result = await post(callback, BODY, HEADERS());
  assert.equal(result.status, 302);
  assert.equal(fixture.requests.length, 1);
  await assert.rejects(verifyCallback({ url: callback, secret: SECRET, subscriptionId: 'sub_fixed' }, post), reason('http_redirect'));
  assert.equal(fixture.requests.length, 2);
});

test('request and response size limits stop excess data without returning endpoint-controlled errors', async () => {
  const fixture = networkFixture();
  const post = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fixture.request });
  await assert.rejects(post(callback, 'a'.repeat(262145), HEADERS()), reason('payload_too_large'));
  assert.equal(fixture.requests.length, 0);
  for (const setup of [{ declaredLength: '65537' }, { chunks: [Buffer.alloc(32768), Buffer.alloc(32769)] }]) {
    const large = networkFixture(200, '{}', setup);
    const bounded = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: large.request });
    await assert.rejects(bounded(callback, BODY, HEADERS()), reason('response_too_large'));
  }
});

test('network credentials cannot be added to webhook headers', async () => {
  const fixture = networkFixture();
  const post = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fixture.request });
  await assert.rejects(post(callback, BODY, { ...HEADERS(), Authorization: 'Bearer private-token' }), reason('invalid_headers'));
  await assert.rejects(post(callback, BODY, { ...HEADERS(), Host: 'localhost' }), reason('invalid_headers'));
  assert.equal(fixture.requests.length, 0);
});

test('an absolute deadline includes stalled DNS and response bodies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const noDns = createWebhookPost({ resolve: async () => new Promise(() => {}) });
  const pendingDns = assert.rejects(noDns(callback, BODY, HEADERS()), reason('timeout'));
  t.mock.timers.tick(10_000);
  await pendingDns;
  const fixture = networkFixture(200, '{}', { stall: true });
  const post = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fixture.request });
  const pendingResponse = assert.rejects(post(callback, BODY, HEADERS()), reason('timeout'));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  assert.equal(fixture.requests.length, 1, 'the response body must actually be pending before advancing the deadline');
  t.mock.timers.tick(10_000);
  await pendingResponse;
});

test('caller cancellation interrupts an active response body and destroys its connection', async () => {
  const controller = new AbortController();
  const fixture = networkFixture(200, '{}', { stall: true });
  const post = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fixture.request });
  const pending = assert.rejects(post(callback, BODY, HEADERS(), controller.signal), reason('aborted'));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  assert.equal(fixture.requests.length, 1);
  controller.abort(new Error('private cancellation reason'));
  await pending;
  assert.equal(fixture.destroyed.length, 1);
  assert.equal(fixture.destroyed[0]!.message.includes('private cancellation reason'), false);
});

test('caller cancellation and TLS/DNS failures are sanitized and never expose callback details', async () => {
  const controller = new AbortController();
  controller.abort(new Error(callback + SECRET));
  const fixture = networkFixture();
  const post = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: fixture.request });
  await assert.rejects(post(callback, BODY, HEADERS(), controller.signal), reason('aborted'));
  assert.equal(fixture.requests.length, 0);
  const noDns = createWebhookPost({ resolve: async () => { throw new Error(callback + SECRET); }, request: fixture.request });
  await assert.rejects(noDns(callback, BODY, HEADERS()), reason('dns_error'));
  const tlsFixture = networkFixture(200, '', { error: Object.assign(new Error(callback + SECRET), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  const tlsPost = createWebhookPost({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: tlsFixture.request });
  await assert.rejects(tlsPost(callback, BODY, HEADERS()), reason('tls_error'));
});
