import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from '../src/types.js';
import { EventService } from '../src/events/service.js';
import type { WebhookPost } from '../src/events/webhook.js';

const NAME = 'ponte.job.completed';
const CALLBACK = 'https://events.example.com/private-route?token=private-routing';
const SECRET = 'whsec_' + Buffer.alloc(32, 17).toString('base64');
const SECOND_SECRET = 'whsec_' + Buffer.alloc(32, 34).toString('base64');
const PRINCIPAL = 'oauth:grant-a';
const OTHER = 'oauth:grant-b';
const BASE = Date.parse('2026-10-22T12:00:00.000Z');

async function fixture(t: TestContext, customPost?: WebhookPost) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-event-service-'));
  const jobs = new Map<string, Job>();
  const owners = new Map<string, string>();
  const authorized = new Set([PRINCIPAL, OTHER]);
  let clock = BASE;
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let response = 204;
  const post: WebhookPost = async (url, body, headers, signal) => {
    calls.push({ url, body, headers });
    if (customPost) return customPost(url, body, headers, signal);
    const input = JSON.parse(body);
    return input.type === 'verification'
      ? { status: 200, body: JSON.stringify({ challenge: input.challenge }) }
      : { status: response, body: '' };
  };
  const options = {
    stateDir: root,
    getJob: (principal: string, id: string) => {
      if (owners.get(id) !== principal || !jobs.has(id)) throw new Error('Trabalho indisponível.');
      return structuredClone(jobs.get(id)!);
    },
    isAuthorized: (principal: string) => authorized.has(principal),
    post, now: () => clock,
  };
  const service = await EventService.open(options);
  const services = [service];
  t.after(async () => { await Promise.all(services.map(item => item.close())); await rm(root, { recursive: true, force: true }); });
  const job = (status: Job['status'] = 'pending_approval', principal = PRINCIPAL) => {
    const value: Job = { id: randomUUID(), tool: 'local_write_file', source: 'local', risk: 'write', status,
      arguments: { content: 'private arguments' }, createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(),
      ...(status === 'succeeded' ? { result: { content: [{ type: 'text' as const, text: 'complete result' }] } } : {}),
    };
    jobs.set(value.id, value); owners.set(value.id, principal); return value;
  };
  const params = (id: string, extra: Record<string, unknown> = {}) => ({ name: NAME, arguments: { jobId: id }, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET }, ...extra });
  const finish = async (value: Job, status: Job['status'] = 'succeeded') => {
    value.status = status; value.updatedAt = new Date(clock).toISOString();
    value.result = { content: [{ type: 'text', text: 'complete result' }] };
    await service.record(value);
  };
  const reopen = async () => { await service.close(); const opened = await EventService.open(options); services.push(opened); return opened; };
  return { root, jobs, owners, authorized, calls, options, service, services, job, params, finish, reopen,
    setResponse: (value: number) => { response = value; }, advance: (value: number) => { clock += value; }, now: () => clock,
    deliveries: () => calls.filter(call => !('type' in JSON.parse(call.body))),
    verifications: () => calls.filter(call => JSON.parse(call.body).type === 'verification'),
  };
}

test('Events exposes a webhook event requiring an explicit job and validates ownership before verification', async t => {
  const f = await fixture(t);
  const listed = await f.service.list(PRINCIPAL, {}) as { events: Array<{ name: string; delivery: string[]; inputSchema: { required: string[] } }> };
  assert.equal(listed.events[0]?.name, NAME);
  assert.deepEqual(listed.events[0]?.delivery, ['webhook']);
  assert.deepEqual(listed.events[0]?.inputSchema.required, ['jobId']);
  const foreign = f.job('running', OTHER);
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(foreign.id)));
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(randomUUID())));
  assert.equal(f.calls.length, 0);
  f.authorized.delete(PRINCIPAL);
  await assert.rejects(f.service.list(PRINCIPAL, {}));
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(f.job().id)));
});

test('Events verifies callback, persists terminal result, signs exact metadata bytes and delivers once', async t => {
  const f = await fixture(t);
  const job = f.job();
  const subscribed = await f.service.subscribe(PRINCIPAL, f.params(job.id));
  assert.equal(subscribed.cursor, null);
  assert.equal(subscribed.truncated, false);
  assert.equal(Date.parse(subscribed.refreshBefore), BASE + 24 * 3600_000);
  assert.equal(f.verifications().length, 1);
  assert.equal(f.deliveries().length, 0);
  await f.finish(job);
  await f.service.pump();
  await f.service.record(job);
  await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  const request = f.deliveries()[0]!;
  const event = JSON.parse(request.body);
  assert.equal(event.name, NAME);
  assert.equal(event.data.jobId, job.id);
  assert.equal(event.data.status, 'succeeded');
  assert.equal(event.cursor, null);
  assert.equal(request.headers['webhook-id'], event.eventId);
  const timestamp = request.headers['webhook-timestamp'];
  const signature = createHmac('sha256', Buffer.alloc(32, 17)).update(`${event.eventId}.${timestamp}.${request.body}`).digest('base64');
  assert.ok(request.headers['webhook-signature']!.split(' ').includes('v1,' + signature));
  assert.ok(!request.body.includes('private arguments'));
  assert.ok(!request.body.includes('complete result'));
  const archived = f.service.getArchivedJob(PRINCIPAL, job.id);
  assert.deepEqual(archived?.result, job.result);
  assert.equal(f.service.getArchivedJob(OTHER, job.id), undefined);
  assert.deepEqual(archived?.arguments, {});
  const snapshot = JSON.stringify(f.service.snapshot());
  for (const privateValue of [SECRET, CALLBACK, 'private-routing', PRINCIPAL, 'complete result', 'private arguments']) assert.ok(!snapshot.includes(privateValue));
  assert.equal(f.service.snapshot().delivered, 1);
});

test('Events handles completion before subscription and idempotent renewal without duplicate delivery', async t => {
  const f = await fixture(t);
  const job = f.job('succeeded');
  const original = await f.service.subscribe(PRINCIPAL, f.params(job.id, { ttlMs: 1000 }));
  await f.service.pump();
  f.advance(200);
  const renewed = await f.service.subscribe(PRINCIPAL, f.params(job.id, { ttlMs: 2000, maxAgeMs: 0 }));
  assert.equal(renewed.id, original.id);
  assert.equal(Date.parse(renewed.refreshBefore), BASE + 2200);
  await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.service.snapshot().subscriptionCount, 1);
});

test('Events observes completion during callback verification without losing or duplicating it', async t => {
  let finishVerification!: () => void;
  let verificationStarted!: () => void;
  const started = new Promise<void>(resolve => { verificationStarted = resolve; });
  const release = new Promise<void>(resolve => { finishVerification = resolve; });
  const f = await fixture(t, async (_url, body) => {
    const input = JSON.parse(body);
    if (input.type === 'verification') { verificationStarted(); await release; return { status: 200, body: JSON.stringify({ challenge: input.challenge }) }; }
    return { status: 204, body: '' };
  });
  const job = f.job();
  const subscription = f.service.subscribe(PRINCIPAL, f.params(job.id));
  await started;
  job.status = 'succeeded'; job.result = { content: [{ type: 'text', text: 'finished during verification' }] };
  const observed = f.service.record(job);
  finishVerification();
  await subscription; await observed; await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  assert.deepEqual(f.service.getArchivedJob(PRINCIPAL, job.id)?.result, job.result);
});

test('Events persists retry identity and archived result across restart', async t => {
  const f = await fixture(t);
  f.setResponse(503);
  const job = f.job('succeeded');
  await f.service.subscribe(PRINCIPAL, f.params(job.id));
  await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  const original = JSON.parse(f.deliveries()[0]!.body).eventId;
  f.jobs.clear(); f.owners.clear();
  const reopened = await f.reopen();
  assert.deepEqual(reopened.getArchivedJob(PRINCIPAL, job.id)?.result, job.result);
  f.setResponse(204); f.advance(1000);
  await reopened.pump();
  assert.equal(f.deliveries().length, 2);
  assert.equal(JSON.parse(f.deliveries()[1]!.body).eventId, original);
  assert.equal(reopened.snapshot().delivered, 1);
});

test('Events restores interrupted watched jobs as cancelled without running a tool again', async t => {
  const f = await fixture(t);
  const job = f.job('running');
  await f.service.subscribe(PRINCIPAL, f.params(job.id));
  f.jobs.clear(); f.owners.clear();
  const reopened = await f.reopen();
  const archived = reopened.getArchivedJob(PRINCIPAL, job.id);
  assert.equal(archived?.status, 'cancelled');
  assert.match(archived?.error ?? '', /reinício|interromp/i);
  await reopened.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(JSON.parse(f.deliveries()[0]!.body).data.status, 'cancelled');
});

test('Events rechecks grants before retries and unsubscribe never affects another owner', async t => {
  const f = await fixture(t);
  f.setResponse(503);
  const job = f.job('succeeded');
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(job.id));
  await f.service.unsubscribe(OTHER, { name: NAME, arguments: { jobId: job.id }, delivery: { mode: 'webhook', url: CALLBACK } });
  assert.equal(f.service.snapshot().subscriptionCount, 1);
  await f.service.pump();
  f.authorized.delete(PRINCIPAL); f.advance(1000);
  await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.service.snapshot().subscriptionCount, 0);
  assert.equal(await f.service.cancel(subscription.id), false);
});

test('Events cancellation aborts an in-flight delivery and does not resurrect the subscription', async t => {
  let announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const f = await fixture(t, async (_url, body, _headers, signal) => {
    const input = JSON.parse(body);
    if (input.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: input.challenge }) };
    announce();
    await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    return { status: 204, body: '' };
  });
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(f.job('succeeded').id));
  const delivery = f.service.pump();
  await started;
  assert.equal(await f.service.cancel(subscription.id), true);
  await delivery;
  assert.equal(f.service.snapshot().subscriptionCount, 0);
  f.advance(120_000); await f.service.pump();
  assert.equal(f.deliveries().length, 1);
});

test('Events caches verified keys by principal and rotates signatures with five-minute overlap', async t => {
  const f = await fixture(t);
  f.setResponse(503);
  const job = f.job();
  const first = await f.service.subscribe(PRINCIPAL, f.params(job.id));
  await f.service.subscribe(PRINCIPAL, f.params(f.job().id));
  assert.equal(f.verifications().length, 1);
  const rotated = await f.service.subscribe(PRINCIPAL, f.params(job.id, { delivery: { mode: 'webhook', url: CALLBACK, secret: SECOND_SECRET } }));
  assert.equal(first.id, rotated.id);
  assert.equal(f.verifications().length, 2);
  await f.finish(job); await f.service.pump();
  assert.equal(f.deliveries()[0]!.headers['webhook-signature']!.split(' ').length, 2);
  f.advance(5 * 60_000 + 1); await f.service.pump();
  assert.equal(f.deliveries()[1]!.headers['webhook-signature']!.split(' ').length, 1);
  await f.service.subscribe(OTHER, f.params(f.job('pending_approval', OTHER).id));
  assert.equal(f.verifications().length, 3);
  f.advance(10 * 60_000 + 1);
  await f.service.subscribe(PRINCIPAL, f.params(f.job().id));
  assert.equal(f.verifications().length, 4);
});

test('Events bounds delivery attempts and treats HTTP 410 and 413 as terminal delivery failures', async t => {
  const f = await fixture(t);
  f.setResponse(500);
  await f.service.subscribe(PRINCIPAL, f.params(f.job('succeeded').id));
  for (let i = 0; i < 9; i++) { await f.service.pump(); f.advance(120_000); }
  assert.equal(f.deliveries().length, 6);
  assert.equal(f.service.snapshot().failed, 1);
  for (const status of [410, 413]) {
    f.setResponse(status);
    const before = f.deliveries().length;
    await f.service.subscribe(PRINCIPAL, f.params(f.job('succeeded').id));
    await f.service.pump(); f.advance(120_000); await f.service.pump();
    assert.equal(f.deliveries().length, before + 1);
  }
});

test('Events expires subscriptions, caps requested lifetime and polls watched job expiration', async t => {
  const f = await fixture(t);
  const short = f.job();
  await f.service.subscribe(PRINCIPAL, f.params(short.id, { ttlMs: 10 }));
  f.advance(11); await f.finish(short); await f.service.pump();
  assert.equal(f.deliveries().length, 0);
  const watched = f.job();
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(watched.id, { ttlMs: 2 * 24 * 3600_000 }));
  assert.equal(Date.parse(subscription.refreshBefore), f.now() + 24 * 3600_000);
  watched.status = 'expired'; watched.error = 'Aprovação expirada.';
  await f.service.pump();
  assert.equal(JSON.parse(f.deliveries()[0]!.body).data.status, 'expired');
});

test('Events rejects replay, bad callback data and failed verification without retaining a subscription', async t => {
  const f = await fixture(t, async () => ({ status: 200, body: JSON.stringify({ challenge: 'wrong challenge' }) }));
  const job = f.job();
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(job.id, { cursor: 'old-cursor' })), (error: unknown) => (error as { code: number }).code === -32026);
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(job.id, { ttlMs: -1 })));
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(job.id, { delivery: { mode: 'webhook', url: 'http://127.0.0.1/callback', secret: SECRET } })));
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(job.id, { delivery: { mode: 'webhook', url: CALLBACK, secret: 'short' } })));
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(job.id)));
  assert.equal(f.service.snapshot().subscriptionCount, 0);
  assert.equal(f.deliveries().length, 0);
});

test('Events persistent state rejects corruption and symbolic links', async t => {
  const f = await fixture(t);
  await f.service.close();
  const filename = path.join(f.root, 'events.json');
  await writeFile(filename, '{"version":1,"subscriptions":"invalid"}');
  await assert.rejects(EventService.open(f.options), /estado|state/i);
  await rm(filename);
  const target = path.join(f.root, 'linked.json');
  await writeFile(target, '{}');
  await symlink(target, filename);
  await assert.rejects(EventService.open(f.options), /estado|state|arquivo|file/i);
});

test('Events revocation during callback verification prevents subscription activation', async t => {
  let revoke!: () => void;
  const f = await fixture(t, async (_url, body) => {
    revoke();
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  });
  revoke = () => { f.authorized.delete(PRINCIPAL); };
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(f.job().id)));
  assert.equal(f.service.snapshot().subscriptionCount, 0);
});

test('Events stores usable secrets privately without including them in callback failure diagnostics', async t => {
  const f = await fixture(t, async (_url, body) => {
    const input = JSON.parse(body);
    if (input.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: input.challenge }) };
    throw new Error(CALLBACK + ' ' + SECRET);
  });
  await f.service.subscribe(PRINCIPAL, f.params(f.job('succeeded').id));
  await f.service.pump(); await f.service.flush();
  const stored = await readFile(path.join(f.root, 'events.json'), 'utf8');
  assert.ok(stored.includes(SECRET));
  const snapshot = JSON.stringify(f.service.snapshot());
  assert.ok(!snapshot.includes(SECRET)); assert.ok(!snapshot.includes(CALLBACK));
  assert.equal(f.service.snapshot().pendingDeliveries, 1);
});

test('Events requires verification even when the injected clock begins at zero', async t => {
  const f = await fixture(t);
  f.advance(-BASE);
  await f.service.subscribe(PRINCIPAL, f.params(f.job().id));
  assert.equal(f.verifications().length, 1);
});

test('Events unsubscribe waits for a concurrent initial subscription and prevents later activation', async t => {
  let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (_url, body) => {
    started(); await proceed;
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  });
  const job = f.job();
  const subscribed = f.service.subscribe(PRINCIPAL, f.params(job.id));
  await ready;
  const removed = f.service.unsubscribe(PRINCIPAL, { name: NAME, arguments: { jobId: job.id }, delivery: { mode: 'webhook', url: CALLBACK } });
  await new Promise(resolve => setImmediate(resolve));
  release();
  await subscribed; await removed;
  assert.equal(f.service.snapshot().subscriptionCount, 0);
});

test('Events removes expired archives even after the last subscription is cancelled', async t => {
  const f = await fixture(t);
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(f.job('succeeded').id, { ttlMs: 10 }));
  await f.service.cancel(subscription.id);
  f.advance(11);
  await new Promise(resolve => setTimeout(resolve, 40));
  await f.service.flush();
  const stored = JSON.parse(await readFile(path.join(f.root, 'events.json'), 'utf8'));
  assert.deepEqual(stored.archives, []);
});

test('Events subscription identity is deterministic across removal and recreation', async t => {
  const f = await fixture(t);
  const job = f.job('succeeded');
  const initial = await f.service.subscribe(PRINCIPAL, f.params(job.id));
  await f.service.cancel(initial.id);
  const recreated = await f.service.subscribe(PRINCIPAL, f.params(job.id));
  assert.equal(recreated.id, initial.id);
  assert.match(initial.id, /^sub_[a-f0-9]{64}$/);
});

test('Events reserves capacity before accepting watched jobs and enforces the subscription cap', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 15; i++) await f.service.subscribe(PRINCIPAL, f.params(f.job().id));
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(f.job().id)), (error: unknown) => (error as { data?: { reason?: string } }).data?.reason === 'storage_limit');
  assert.equal(f.service.snapshot().subscriptionCount, 15);
  for (const job of f.jobs.values()) await f.finish(job);
  const shared = [...f.jobs.values()][0]!;
  for (let i = 15; i < 100; i++) await f.service.subscribe(PRINCIPAL, f.params(shared.id, { delivery: { mode: 'webhook', url: `https://events.example.com/callback/${i}`, secret: SECRET } }));
  assert.equal(f.service.snapshot().subscriptionCount, 100);
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(shared.id, { delivery: { mode: 'webhook', url: 'https://events.example.com/callback/overflow', secret: SECRET } })),
    (error: unknown) => (error as { data?: { reason?: string } }).data?.reason === 'subscription_limit');
  assert.equal(f.service.snapshot().subscriptionCount, 100);
});

test('Events malformed remote parameters return invalid-params errors without echoing input', async t => {
  const f = await fixture(t);
  const invalid = [
    () => f.service.list(PRINCIPAL, { cursor: 12, secret: SECRET }),
    () => f.service.subscribe(PRINCIPAL, { name: NAME, arguments: { jobId: 'not-a-uuid' }, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET } }),
    () => f.service.subscribe(PRINCIPAL, null),
    () => f.service.subscribe(PRINCIPAL, { ...f.params(f.job().id), unexpected: CALLBACK }),
    () => f.service.unsubscribe(PRINCIPAL, { name: NAME, arguments: { jobId: f.job().id }, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET } }),
    () => f.service.unsubscribe(PRINCIPAL, []),
  ];
  for (const invoke of invalid) await assert.rejects(invoke(), (error: unknown) => {
    const problem = error as { code?: number; message?: string };
    assert.equal(problem.code, -32602);
    assert.ok(!String(problem.message).includes(SECRET));
    assert.ok(!String(problem.message).includes(CALLBACK));
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('Events bounds slow subscription work before queuing so excess requests cannot block records and cancellation', async t => {
  const slowUrl = 'https://events.example.com/slow-verification';
  let announce!: () => void; let release!: () => void; let slowVerifications = 0;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (url, body, _headers, signal) => {
    const input = JSON.parse(body);
    if (input.type !== 'verification') return { status: 204, body: '' };
    if (url !== slowUrl) return { status: 200, body: JSON.stringify({ challenge: input.challenge }) };
    slowVerifications++; announce();
    await Promise.race([proceed, new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) reject(new Error('cancelled'));
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    })]);
    return { status: 200, body: JSON.stringify({ challenge: 'invalid proof' }) };
  });
  const watched = f.job();
  const existing = await f.service.subscribe(PRINCIPAL, f.params(watched.id));
  const slowParams = f.params(f.job().id, { delivery: { mode: 'webhook', url: slowUrl, secret: SECRET } });
  const first = f.service.subscribe(PRINCIPAL, slowParams).then(() => undefined, (error: unknown) => error);
  await started;
  const excess = Array.from({ length: 50 }, () => f.service.subscribe(PRINCIPAL, slowParams).then(() => undefined, (error: unknown) => error));
  let timeout!: ReturnType<typeof setTimeout>;
  const rejectedBeforeRelease = await Promise.race([
    Promise.all(excess),
    new Promise<'timeout'>(resolve => { timeout = setTimeout(() => resolve('timeout'), 100); }),
  ]);
  clearTimeout(timeout);
  const record = f.finish(watched);
  const cancel = f.service.cancel(existing.id);
  release();
  await first; await Promise.all(excess); await record;
  assert.equal(await cancel, true);
  assert.notEqual(rejectedBeforeRelease, 'timeout', 'Excess subscribe requests must reject while the first verifier is still blocked.');
  for (const error of rejectedBeforeRelease as unknown[]) assert.equal((error as { code?: number })?.code, -32025);
  assert.equal(slowVerifications, 1, 'Excess requests must never enter the global queue or call the slow verifier.');
  assert.equal(f.service.getArchivedJob(PRINCIPAL, watched.id)?.status, 'succeeded');
  assert.equal(f.service.snapshot().subscriptionCount, 0);
  // A failed verification releases admission capacity for the next request.
  await f.service.subscribe(PRINCIPAL, f.params(f.job().id));
  assert.equal(f.service.snapshot().subscriptionCount, 1);
});
