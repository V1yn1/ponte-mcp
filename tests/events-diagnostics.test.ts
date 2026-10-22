import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { EventService } from '../src/events/service.js';
import { handleModernMcp } from '../src/mcp/modern.js';
import type { WebhookPost } from '../src/events/webhook.js';
import type { Job } from '../src/types.js';

const BASE = Date.parse('2026-10-22T12:00:00Z');
const PRINCIPAL = 'oauth:private-principal';
const CALLBACK = 'https://receiver.example/private-callback?token=private-routing';
const SECRET = 'whsec_' + Buffer.alloc(32, 17).toString('base64');
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
type MockRequest = { method: string; headers: Record<string, string | undefined>; body: any };

async function fixture(t: TestContext, post?: WebhookPost) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-event-diagnostics-'));
  let clock = BASE;
  const job: Job = { id: randomUUID(), tool: 'local_read_file', source: 'local', risk: 'read', status: 'running',
    arguments: { path: 'private-argument' }, createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString() };
  const options = { stateDir: root, now: () => clock,
    getJob: (principal: string, id: string) => {
      assert.equal(principal, PRINCIPAL); assert.equal(id, job.id); return structuredClone(job);
    },
    isAuthorized: (principal: string) => principal === PRINCIPAL,
    post: post ?? (async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) })),
  };
  let service = await EventService.open(options);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const params = { name: 'ponte.job.completed', arguments: { jobId: job.id }, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET } };
  const invoke = async (method: string, input: Record<string, unknown> = {}, edit?: (request: MockRequest) => void) => {
    const req: MockRequest = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method }, body: { jsonrpc: '2.0', id: 1, method, params: { ...input, _meta: meta } } };
    edit?.(req);
    let status = 200; let body: any;
    const res = { status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; }, set() { return this; } };
    assert.equal(await handleModernMcp(req as unknown as Request, res as unknown as Response, {
      events: service, principal: PRINCIPAL, version: '0.4.0', instructions: '', getTools: () => [], call: async () => ({ content: [] }),
    }), true);
    return { status, body };
  };
  return { root, job, params, invoke, service: () => service, advance: (milliseconds: number) => { clock += milliseconds; },
    reopen: async () => { await service.close(); service = await EventService.open(options); } };
}

test('Events diagnostics distinguish discovery without a subscription and reset after restart', async t => {
  const f = await fixture(t);
  await f.invoke('server/discover'); await f.invoke('tools/list'); await f.invoke('events/list');
  assert.deepEqual(f.service().snapshot().diagnostics, {
    since: new Date(BASE).toISOString(), eventsListRequests: 1, subscribeRequests: 0, acceptedSubscriptions: 0, rejectedSubscriptions: 0,
    callbackVerificationAttempts: 0, callbackVerificationSucceeded: 0, callbackVerificationFailed: 0,
  });
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'events.json'), 'utf8')).diagnostics, undefined);
  f.advance(1000); await f.reopen();
  assert.equal(f.service().snapshot().diagnostics.since, new Date(BASE + 1000).toISOString());
  assert.equal(f.service().snapshot().diagnostics.eventsListRequests, 0);
  assert.equal(f.service().snapshot().diagnostics.subscribeRequests, 0);
});

test('Events diagnostics count malformed subscription requests before envelope and parameter validation', async t => {
  const f = await fixture(t);
  const missingMeta = await f.invoke('events/subscribe', f.params, req => { delete req.body.params._meta; });
  assert.equal(missingMeta.body.error.code, -32602);
  const wrongHeader = await f.invoke('events/subscribe', f.params, req => { req.headers['mcp-method'] = 'events/list'; });
  assert.equal(wrongHeader.body.error.code, -32020);
  const invalidParams = await f.invoke('events/subscribe', { ...f.params, arguments: { jobId: 'private-invalid-job-id' } });
  assert.equal(invalidParams.body.error.code, -32602);
  const diagnostics = f.service().snapshot().diagnostics;
  assert.equal(diagnostics.subscribeRequests, 3);
  assert.equal(diagnostics.acceptedSubscriptions, 0);
  assert.equal(diagnostics.rejectedSubscriptions, 3);
  assert.equal(diagnostics.lastSubscribeAt, new Date(BASE).toISOString());
  assert.deepEqual(diagnostics.lastSubscribeError, { code: -32602 });
  assert.equal(diagnostics.callbackVerificationAttempts, 0);
  for (const value of [SECRET, CALLBACK, PRINCIPAL, f.job.id, 'private-invalid-job-id']) assert.ok(!JSON.stringify(diagnostics).includes(value));
});

test('Events diagnostics separate subscription acceptance, cached verification and verification failure', async t => {
  let fail = false;
  const f = await fixture(t, async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: fail ? 'wrong-private-challenge' : JSON.parse(body).challenge }) }));
  assert.equal((await f.invoke('events/subscribe', f.params)).status, 200);
  assert.equal((await f.invoke('events/subscribe', f.params)).status, 200);
  let diagnostics = f.service().snapshot().diagnostics;
  assert.equal(diagnostics.subscribeRequests, 2);
  assert.equal(diagnostics.acceptedSubscriptions, 2);
  assert.equal(diagnostics.rejectedSubscriptions, 0);
  assert.equal(diagnostics.callbackVerificationAttempts, 1);
  assert.equal(diagnostics.callbackVerificationSucceeded, 1);
  assert.equal(diagnostics.lastCallbackVerificationOutcome, 'succeeded');
  assert.equal(diagnostics.lastSubscribeError, undefined);
  fail = true; f.advance(1000);
  const rejected = await f.invoke('events/subscribe', { ...f.params, delivery: { ...f.params.delivery, url: CALLBACK + '-new' } });
  assert.equal(rejected.body.error.code, -32015);
  diagnostics = f.service().snapshot().diagnostics;
  assert.equal(diagnostics.subscribeRequests, 3);
  assert.equal(diagnostics.acceptedSubscriptions, 2);
  assert.equal(diagnostics.rejectedSubscriptions, 1);
  assert.equal(diagnostics.callbackVerificationAttempts, 2);
  assert.equal(diagnostics.callbackVerificationSucceeded, 1);
  assert.equal(diagnostics.callbackVerificationFailed, 1);
  assert.equal(diagnostics.lastCallbackVerificationAt, new Date(BASE + 1000).toISOString());
  assert.equal(diagnostics.lastCallbackVerificationOutcome, 'failed');
  assert.deepEqual(diagnostics.lastSubscribeError, { code: -32015, reason: 'challenge_failed' });
  assert.deepEqual(diagnostics.lastCallbackVerificationError, { code: -32015, reason: 'challenge_failed' });
  for (const value of [SECRET, CALLBACK, PRINCIPAL, f.job.id, 'wrong-private-challenge']) assert.ok(!JSON.stringify(diagnostics).includes(value));
});

test('Events diagnostic errors allow only known categories and return independent snapshots', async t => {
  const f = await fixture(t);
  f.service().observeRequest('events/subscribe')!.rejected(Object.assign(new Error(SECRET), { code: -32025, data: { reason: CALLBACK } }));
  const first = f.service().snapshot().diagnostics;
  assert.deepEqual(first.lastSubscribeError, { code: -32025 });
  first.lastSubscribeError!.reason = 'timeout';
  first.subscribeRequests = 999;
  assert.deepEqual(f.service().snapshot().diagnostics.lastSubscribeError, { code: -32025 });
  assert.equal(f.service().snapshot().diagnostics.subscribeRequests, 1);
  f.service().observeRequest('events/subscribe')!.rejected(new Error(SECRET));
  assert.deepEqual(f.service().snapshot().diagnostics.lastSubscribeError, { code: -32603 });
  assert.ok(!JSON.stringify(f.service().snapshot().diagnostics).includes(SECRET));
});

test('a late subscription completion does not overwrite the latest rejection diagnostic', async t => {
  let started!: () => void; const verifying = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (_url, body) => { started(); await gate; return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }; });
  const first = f.invoke('events/subscribe', f.params);
  try {
    await verifying;
    f.advance(1000);
    const second = await f.invoke('events/subscribe', f.params);
    assert.equal(second.body.error.code, -32025);
  } finally { release(); }
  assert.equal((await first).status, 200);
  const diagnostics = f.service().snapshot().diagnostics;
  assert.equal(diagnostics.subscribeRequests, 2);
  assert.equal(diagnostics.acceptedSubscriptions, 1);
  assert.equal(diagnostics.rejectedSubscriptions, 1);
  assert.equal(diagnostics.lastSubscribeAt, new Date(BASE + 1000).toISOString());
  assert.deepEqual(diagnostics.lastSubscribeError, { code: -32025, reason: 'subscription_busy' });
});
