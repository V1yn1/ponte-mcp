import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const token = randomBytes(32).toString('base64url');
const id = randomUUID();
const json = value => JSON.stringify(value);
const headers = { authorization: `Bearer ${token}`, 'x-ponte-agent-id': id };
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function makeRelay(t, options = {}) {
  const { createRelay } = await import('../server.mjs');
  const relay = createRelay({ token, pollMs: 100, leaseMs: 1000, requestMs: 1000, ...options });
  const origin = await listen(relay.server);
  t.after(() => relay.close());
  return { ...relay, origin };
}
async function register(origin, agentId = id) {
  return fetch(origin + '/relay/connect', { method: 'POST', headers: { ...headers, 'x-ponte-agent-id': agentId } });
}
async function next(origin) { return fetch(origin + '/relay/poll', { headers }); }
async function result(origin, job, status = 200, body = 'ok', responseHeaders = {}) {
  return fetch(origin + '/relay/results/' + job.id, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: json({ status, headers: responseHeaders, body: Buffer.from(body).toString('base64') }) });
}
async function raw(origin, path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, method, headers: body ? { 'content-length': Buffer.byteLength(body) } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  });
}

test('health is independent; offline MCP returns not_sent and no queue', async t => {
  const { origin } = await makeRelay(t);
  const health = await fetch(origin + '/healthz'); assert.equal(health.status, 200);
  assert.equal((await health.json()).pcOnline, false);
  const response = await fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(response.status, 503); assert.equal((await response.json()).executionState, 'not_sent');
  assert.equal((await register(origin)).status, 200);
  assert.equal((await next(origin)).status, 204);
});

test('agent endpoints require the separate secret and one current identity', async t => {
  const { origin } = await makeRelay(t);
  assert.equal((await fetch(origin + '/relay/connect', { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await register(origin)).status, 200);
  assert.equal((await register(origin, randomUUID())).status, 409);
  assert.equal((await fetch(origin + '/relay/poll', { headers: { ...headers, 'x-ponte-agent-id': randomUUID() } })).status, 409);
  const request = fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  const job = await (await next(origin)).json();
  assert.equal((await result(origin, job, 401, '{}', { 'www-authenticate': 'Bearer realm="ponte"' })).status, 200);
  const response = await request; assert.equal(response.status, 401); assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="ponte"');
});

test('admin, arbitrary URLs, encoded traversal and unsupported methods never enter queue', async t => {
  const { origin } = await makeRelay(t); await register(origin);
  for (const path of ['/admin/state', '/admin/oauth/requests/abc/approve', '/v1/../admin/state', '/%61dmin/state', '/v1/%2e%2e/admin', '//example.com/mcp', 'https://example.com/mcp', '/mcp/../admin', '/mcp\\..\\admin']) {
    assert.ok([400, 404].includes((await raw(origin, path)).status), path);
  }
  assert.equal((await raw(origin, '/mcp', 'PATCH')).status, 404);
  assert.equal((await next(origin)).status, 204);
});

test('forwarding preserves body, client authorization and public redirects without replay', async t => {
  const { origin } = await makeRelay(t); await register(origin);
  const body = 'client_id=hello&code=A%2BB';
  const waiting = fetch(origin + '/token', { method: 'POST', headers: { authorization: 'Bearer client-token', 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-host': 'evil.example' }, body });
  const job = await (await next(origin)).json();
  assert.equal(job.path, '/token'); assert.equal(Buffer.from(job.body, 'base64').toString(), body);
  assert.equal(job.headers.authorization, 'Bearer client-token');
  assert.equal(job.headers['x-forwarded-host'], undefined);
  assert.ok(!json(job).includes(token));
  assert.equal((await result(origin, job, 200, '{"access_token":"test"}', { 'content-type': 'application/json', 'cache-control': 'no-store' })).status, 200);
  const returned = await waiting; assert.equal(returned.status, 200); assert.equal((await returned.json()).access_token, 'test');
  assert.equal((await result(origin, job)).status, 410);
  assert.equal((await next(origin)).status, 204);
  const redirect = fetch(origin + '/oauth/complete?request=example', { redirect: 'manual' });
  const redirectJob = await (await next(origin)).json();
  await result(origin, redirectJob, 302, '', { location: 'https://chatgpt.com/example?code=example', 'content-security-policy': "default-src 'self'" });
  const received = await redirect; assert.equal(received.status, 302); assert.equal(received.headers.get('location'), 'https://chatgpt.com/example?code=example');
});

test('request body and pending count are bounded', async t => {
  const { origin } = await makeRelay(t, { maxPending: 1 }); await register(origin);
  const over = await raw(origin, '/mcp', 'POST', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(over.status, 413);
  const first = fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  const job = await (await next(origin)).json();
  const extra = await fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(extra.status, 429); assert.equal((await extra.json()).executionState, 'not_sent');
  await result(origin, job); assert.equal((await first).status, 200);
});

test('timeout after dispatch is unknown and not automatically requeued', async t => {
  const { origin } = await makeRelay(t, { requestMs: 100 }); await register(origin);
  const call = fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  const job = await (await next(origin)).json();
  const response = await call; assert.equal(response.status, 504);
  assert.equal((await response.json()).executionState, 'unknown');
  assert.equal((await result(origin, job)).status, 410);
  assert.equal((await next(origin)).status, 204);
});

test('timeout before dispatch is not_sent; stale agent cannot claim results', async t => {
  const { origin } = await makeRelay(t, { requestMs: 80, leaseMs: 150 }); await register(origin);
  const response = await fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(response.status, 504); assert.equal((await response.json()).executionState, 'not_sent');
  await delay(100);
  assert.equal((await register(origin, randomUUID())).status, 200);
  assert.equal((await next(origin)).status, 409);
});

test('malformed result is rejected; the original request can still receive a valid result', async t => {
  const { origin } = await makeRelay(t); await register(origin);
  const pending = fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  const job = await (await next(origin)).json();
  const malformed = await fetch(origin + '/relay/results/' + job.id, { method: 'POST', headers, body: json({ status: 200, body: '!!!', headers: {} }) });
  assert.equal(malformed.status, 400);
  await result(origin, job); assert.equal(await (await pending).text(), 'ok');
});

async function integrated(t, options = {}) {
  const { origin, ...relay } = await makeRelay(t, { requestMs: 2000 });
  const calls = [];
  const core = createServer(async (req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') { res.setHeader('content-type', 'application/json'); res.end(json({ issuer: origin })); return; }
    if (req.url === '/health') { res.end('{"ok":true}'); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks); calls.push({ path: req.url, method: req.method, headers: req.headers, body });
    if (req.url === '/mcp') {
      if (req.headers.authorization !== 'Bearer client-token') { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); res.end('{}'); return; }
      const input = JSON.parse(body);
      if (input.delay) await delay(input.delay);
      res.setHeader('content-type', 'application/json'); res.end(json({ jsonrpc: '2.0', id: input.id, result: input.params ?? { status: 'ok' } })); return;
    }
    if (req.url === '/assets/ponte-mark.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from([0, 255, 12, 128])); return; }
    if (req.url.startsWith('/hooks/watchers/')) { res.setHeader('content-type', 'application/json'); res.end(body); return; }
    if (req.url.startsWith('/authorize')) { res.writeHead(302, { location: origin + '/oauth/consent?request=example' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  const localUrl = await listen(core); t.after(() => close(core));
  const { startAgent } = await import('../agent.mjs');
  const agent = await startAgent({ relayUrl: origin, token, apiPort: Number(new URL(localUrl).port), heartbeatMs: 100, localTimeoutMs: 1000, ...options });
  t.after(() => agent.close());
  return { origin, calls, core, agent, relay };
}

test('outbound PC agent executes through sockets; never injects agent token into local API', async t => {
  const { origin, calls } = await integrated(t);
  const response = await fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer client-token', 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' }, body: json({ jsonrpc: '2.0', id: 4, params: { status: 'succeeded' } }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).result.status, 'succeeded');
  assert.equal(calls.length, 1); assert.equal(calls[0].headers.authorization, 'Bearer client-token');
  assert.equal(calls[0].headers['mcp-protocol-version'], '2025-03-26');
  assert.ok(!json(calls).includes(token));
  const unauthorized = await fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata/);
});

test('agent passes OAuth redirects without following and returns exact image bytes', async t => {
  const { origin, calls } = await integrated(t);
  const response = await fetch(origin + '/authorize?client_id=test', { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), origin + '/oauth/consent?request=example');
  assert.equal(calls.length, 1);
  const asset = await fetch(origin + '/assets/ponte-mark.png');
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), Buffer.from([0, 255, 12, 128]));
});

for (const status of ['succeeded', 'failed', 'needs_input']) {
  test(`watcher callback transport preserves ${status}, identity and body`, async t => {
    const { origin, calls } = await integrated(t);
    const payload = { eventId: randomUUID(), runId: 'controlled-test', status, summary: 'controlled transport test' };
    const response = await fetch(origin + `/hooks/watchers/${randomUUID()}/signal`, { method: 'POST', headers: { authorization: 'Bearer watcher-secret', 'content-type': 'application/json' }, body: json(payload) });
    assert.deepEqual(await response.json(), payload); assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, 'Bearer watcher-secret');
  });
}

test('local timeout reports unknown and never repeats the tool', async t => {
  const { origin, calls } = await integrated(t, { localTimeoutMs: 100 });
  const response = await fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer client-token' }, body: json({ id: 1, delay: 200 }) });
  assert.equal(response.status, 502); assert.equal((await response.json()).executionState, 'unknown');
  await delay(250); assert.equal(calls.length, 1);
});

test('public disconnect does not replay a dispatched operation', async t => {
  const { origin, calls } = await integrated(t);
  const controller = new AbortController();
  const response = fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer client-token' }, body: json({ id: 1, delay: 150 }), signal: controller.signal });
  void response.catch(() => {});
  for (let i = 0; i < 50 && calls.length === 0; i++) await delay(5);
  assert.equal(calls.length, 1); controller.abort(); await assert.rejects(response);
  await delay(200); assert.equal(calls.length, 1);
});

test('agent rejects admin port and mismatched issuer before pairing', async t => {
  const { startAgent } = await import('../agent.mjs');
  await assert.rejects(startAgent({ relayUrl: 'https://relay.example.com', token, apiPort: 4317 }), /porta/i);
  const relay = await makeRelay(t);
  const core = createServer((_req, res) => res.end('{"issuer":"https://wrong.example.com"}'));
  const localUrl = await listen(core); t.after(() => close(core));
  await assert.rejects(startAgent({ relayUrl: relay.origin, token, apiPort: Number(new URL(localUrl).port) }), /origem|URL/i);
  assert.equal((await (await fetch(relay.origin + '/healthz')).json()).pcOnline, false);
});

test('maximum-size binary results decode without stack overflow or silent truncation', async () => {
  const { decodeBody, RESPONSE_LIMIT } = await import('../protocol.mjs');
  const bytes = Buffer.alloc(RESPONSE_LIMIT, 0x7e);
  assert.deepEqual(decodeBody(bytes.toString('base64'), RESPONSE_LIMIT), bytes);
  for (const input of ['!!!', 'YQ=', 'YQ===', '====', 'YQ==ZQ==', 'Zh==']) assert.throws(() => decodeBody(input, 100), /Corpo/);
});

test('agent lease expiry closes pending work and leaves its state uncertain, without replay', async t => {
  const { origin } = await makeRelay(t, { leaseMs: 80, requestMs: 400 }); await register(origin);
  const call = fetch(origin + '/mcp', { method: 'POST', body: '{}' });
  const job = await (await next(origin)).json(); await delay(100);
  const newId = randomUUID(); assert.equal((await register(origin, newId)).status, 200);
  const response = await call; assert.equal(response.status, 503); assert.equal((await response.json()).executionState, 'unknown');
  assert.equal((await result(origin, job)).status, 409);
});

test('agent reconnects after relay restart without repeating the completed operation', async t => {
  const { createRelay } = await import('../server.mjs');
  const { origin, calls, relay } = await integrated(t);
  const call = () => fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer client-token' }, body: json({ id: 1 }) });
  assert.equal((await call()).status, 200); assert.equal(calls.length, 1);
  await relay.close();
  const replacement = createRelay({ token, pollMs: 100, requestMs: 1000, leaseMs: 1000 });
  replacement.server.listen(Number(new URL(origin).port), '127.0.0.1'); await once(replacement.server, 'listening');
  t.after(() => replacement.close());
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { healthy = (await (await fetch(origin + '/healthz')).json()).pcOnline; }
    catch { healthy = false; } // A reused socket can close during the deliberate restart.
    if (healthy) break; await delay(50);
  }
  assert.equal(healthy, true); assert.equal((await call()).status, 200); assert.equal(calls.length, 2);
});

test('MCP lifecycle methods reach the core so it can return its own 405 and Allow', async t => {
  const { origin } = await makeRelay(t); await register(origin);
  for (const method of ['GET', 'DELETE']) {
    const waiting = fetch(origin + '/mcp', { method });
    const poll = await next(origin);
    assert.equal(poll.status, 200);
    const job = await poll.json(); assert.equal(job.method, method);
    await result(origin, job, 405, '{}', { allow: 'POST' });
    const response = await waiting; assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST');
  }
});

test('uncertain errors request observation, never suggest retrying a possibly lost execution', async () => {
  const { transportFailure } = await import('../protocol.mjs');
  const value = transportFailure('disconnected', true);
  assert.equal(value.executionState, 'unknown');
  assert.doesNotMatch(value.message, /mesma chave/i);
  assert.match(value.message, /não reenvie/i);
});
