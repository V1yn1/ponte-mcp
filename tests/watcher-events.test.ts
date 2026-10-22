import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventService } from '../src/events/service.js';
import type { WebhookPost } from '../src/events/webhook.js';
import type { Job } from '../src/types.js';
import type { Watcher } from '../src/watchers/types.js';

const NAME = 'ponte.watcher.completed';
const JOB_NAME = 'ponte.job.completed';
const CALLBACK = 'https://events.example.com/watcher-callback?token=private-route';
const SECRET = 'whsec_' + Buffer.alloc(32, 47).toString('base64');
const PRINCIPAL = 'oauth:watcher-owner';
const OTHER = 'oauth:other-owner';
const BASE = Date.parse('2026-10-22T12:00:00.000Z');
const TERMINAL = ['succeeded', 'failed', 'needs_input', 'cancelled', 'expired', 'interrupted'] as const;

async function fixture(t: TestContext, customPost?: WebhookPost) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-watcher-events-'));
  const watchers = new Map<string, Watcher>(); const owners = new Map<string, string>();
  const jobs = new Map<string, Job>();
  const authorized = new Set([PRINCIPAL, OTHER]);
  let clock = BASE; let response = 204; let watcherAvailable = true;
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const post: WebhookPost = async (url, body, headers, signal) => {
    calls.push({ url, body, headers });
    if (customPost) return customPost(url, body, headers, signal);
    const input = JSON.parse(body);
    return input.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: input.challenge }) } : { status: response, body: '' };
  };
  const options = {
    stateDir: root, post, now: () => clock,
    getJob: (principal: string, id: string) => {
      if (principal !== PRINCIPAL || !jobs.has(id)) throw new Error('Job indisponível.');
      return structuredClone(jobs.get(id)!);
    },
    getWatcher: async (principal: string, id: string) => {
      if (!watcherAvailable) throw new Error('WatchService ainda não abriu.');
      if (owners.get(id) !== principal || !watchers.has(id)) throw new Error('Watcher indisponível.');
      return structuredClone(watchers.get(id)!);
    },
    isAuthorized: (principal: string) => authorized.has(principal),
  };
  const service = await EventService.open(options); const services = [service];
  t.after(async () => { await Promise.all(services.map(item => item.close())); await rm(root, { recursive: true, force: true }); });
  const watcher = (status: Watcher['status'] = 'waiting', principal = PRINCIPAL, id = randomUUID()) => {
    const value: Watcher = { watcherId: id, name: 'private-watcher-name', trigger: { type: 'signal', source: 'private-source', runId: 'private-run-id' },
      status, createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 3600_000).toISOString(),
      ...(status !== 'waiting' ? { result: { summary: 'private-external-result', evidence: { token: 'private-signal-token' } }, error: 'private-external-error' } : {}),
    };
    watchers.set(id, value); owners.set(id, principal); return value;
  };
  const finish = (value: Watcher, status: Watcher['status'] = 'succeeded') => {
    value.status = status; value.updatedAt = new Date(clock).toISOString();
    value.result = { summary: 'private-external-result', evidence: { token: 'private-signal-token' } };
    return value;
  };
  const job = (id: string) => {
    const value: Job = { id, tool: 'local_send_task', source: 'local', risk: 'write', status: 'succeeded', arguments: {}, createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() };
    jobs.set(id, value); return value;
  };
  const params = (id: string, extra: Record<string, unknown> = {}) => ({ name: NAME, arguments: { watcherId: id }, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET }, ...extra });
  const reopen = async () => { await service.close(); const opened = await EventService.open(options); services.push(opened); return opened; };
  const record = async (value: Watcher, principal = PRINCIPAL, target = service) => {
    assert.equal(typeof target.recordWatcher, 'function', 'EventService must accept persisted watcher completions.');
    await target.recordWatcher(principal, value);
  };
  return { root, options, service, services, watchers, owners, jobs, authorized, calls, watcher, finish, job, params, record, reopen,
    advance: (value: number) => { clock += value; }, setResponse: (value: number) => { response = value; },
    setWatcherAvailable: (value: boolean) => { watcherAvailable = value; },
    deliveries: () => calls.filter(item => !('type' in JSON.parse(item.body))),
    verifications: () => calls.filter(item => JSON.parse(item.body).type === 'verification'),
  };
}

test('Watcher Events catalog exposes a strict watcher filter and metadata-only terminal payload', async t => {
  const f = await fixture(t);
  const catalog = await f.service.list(PRINCIPAL, {}) as { events: Array<{ name: string; description: string; delivery: string[]; inputSchema: any; payloadSchema: any }> };
  assert.deepEqual(catalog.events.map(item => item.name), [JOB_NAME, NAME]);
  const event = catalog.events.find(item => item.name === NAME)!;
  assert.deepEqual(event.delivery, ['webhook']);
  assert.deepEqual(event.inputSchema.required, ['watcherId']);
  assert.deepEqual(Object.keys(event.inputSchema.properties), ['watcherId']);
  assert.equal(event.inputSchema.properties.watcherId.format, 'uuid');
  assert.equal(event.inputSchema.additionalProperties, false);
  assert.deepEqual(event.payloadSchema.required, ['watcherId', 'status', 'createdAt', 'updatedAt']);
  assert.deepEqual(Object.keys(event.payloadSchema.properties), event.payloadSchema.required);
  assert.deepEqual(event.payloadSchema.properties.status.enum, TERMINAL);
  assert.equal(event.payloadSchema.additionalProperties, false);
  assert.match(event.description, /bridge_watch_get/);
  assert.match(event.description, /sem reenviar/);
});

test('Watcher Events rejects foreign resources and wrong filter shapes before callback verification', async t => {
  const f = await fixture(t); const own = f.watcher(); const foreign = f.watcher('waiting', OTHER);
  const invalid = [
    f.params(foreign.watcherId), f.params(randomUUID()), f.params('not-a-uuid'),
    f.params(own.watcherId, { arguments: {} }),
    f.params(own.watcherId, { arguments: { jobId: own.watcherId } }),
    f.params(own.watcherId, { arguments: { watcherId: own.watcherId, jobId: own.watcherId } }),
    f.params(own.watcherId, { name: JOB_NAME }),
  ];
  for (const params of invalid) await assert.rejects(f.service.subscribe(PRINCIPAL, params));
  assert.equal(f.calls.length, 0);
  f.authorized.delete(PRINCIPAL);
  await assert.rejects(f.service.subscribe(PRINCIPAL, f.params(own.watcherId)));
  assert.equal(f.calls.length, 0);
});

test('Watcher Events emits after watcher completion, never after a dispatch job, and signs only metadata', async t => {
  const f = await fixture(t); const watcher = f.watcher();
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId));
  await f.service.record(f.job(watcher.watcherId)); await f.record(watcher); await f.service.pump();
  assert.equal(f.deliveries().length, 0);
  assert.equal(f.service.snapshot().subscriptions[0]?.status, 'waiting');
  f.advance(1000); await f.record(f.finish(watcher)); await f.service.pump();
  await f.record(watcher); await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  const request = f.deliveries()[0]!; const event = JSON.parse(request.body);
  assert.deepEqual(event.data, { watcherId: watcher.watcherId, status: 'succeeded', createdAt: watcher.createdAt, updatedAt: watcher.updatedAt });
  assert.equal(event.name, NAME); assert.equal(event.timestamp, watcher.updatedAt); assert.equal(event.cursor, null);
  assert.equal(request.headers['webhook-id'], event.eventId);
  assert.equal(request.headers['X-MCP-Subscription-Id'], subscription.id);
  const signature = createHmac('sha256', Buffer.alloc(32, 47)).update(`${event.eventId}.${request.headers['webhook-timestamp']}.${request.body}`).digest('base64');
  assert.ok(request.headers['webhook-signature']!.split(' ').includes('v1,' + signature));
  const snapshot = f.service.snapshot();
  assert.equal(snapshot.delivered, 1);
  assert.equal(snapshot.subscriptions[0]?.watcherId, watcher.watcherId);
  assert.equal(snapshot.subscriptions[0]?.jobId, undefined);
  const stored = await readFile(path.join(f.root, 'events.json'), 'utf8');
  for (const privateValue of ['private-watcher-name', 'private-source', 'private-run-id', 'private-external-result', 'private-external-error', 'private-signal-token']) {
    assert.ok(!stored.includes(privateValue)); assert.ok(!request.body.includes(privateValue)); assert.ok(!JSON.stringify(snapshot).includes(privateValue));
  }
  assert.ok(!JSON.stringify(snapshot).includes(SECRET)); assert.ok(!JSON.stringify(snapshot).includes(CALLBACK));
});

test('Watcher Events subscribes to every persisted terminal status with immediate catch-up', async t => {
  const f = await fixture(t);
  for (const status of TERMINAL) {
    const watcher = f.watcher(status);
    await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId)); await f.service.pump();
    const event = JSON.parse(f.deliveries().at(-1)!.body);
    assert.equal(event.data.watcherId, watcher.watcherId); assert.equal(event.data.status, status);
  }
  assert.equal(f.deliveries().length, TERMINAL.length);
});

test('Watcher Events catches completion racing with callback verification', async t => {
  let announce!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; }); const proceed = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (_url, body) => {
    const input = JSON.parse(body); if (input.type !== 'verification') return { status: 204, body: '' };
    announce(); await proceed; return { status: 200, body: JSON.stringify({ challenge: input.challenge }) };
  });
  const watcher = f.watcher();
  const subscribing = f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId));
  await started;
  f.finish(watcher, 'needs_input');
  const recording = f.record(watcher); release();
  await subscribing; await recording; await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(JSON.parse(f.deliveries()[0]!.body).data.status, 'needs_input');
});

test('Watcher Events polls persisted terminal state if the listener was missed', async t => {
  const f = await fixture(t); const watcher = f.watcher();
  await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId));
  f.finish(watcher, 'expired'); await f.service.pump(); await f.service.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(JSON.parse(f.deliveries()[0]!.body).data.status, 'expired');
});

test('Watcher Events recovers a completion across restart without inventing interruption for a waiting watcher', async t => {
  const f = await fixture(t); const complete = f.watcher(); const waiting = f.watcher();
  await f.service.subscribe(PRINCIPAL, f.params(complete.watcherId));
  await f.service.subscribe(PRINCIPAL, f.params(waiting.watcherId));
  await f.service.close(); f.finish(complete, 'interrupted');
  const reopened = await f.reopen(); await reopened.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(JSON.parse(f.deliveries()[0]!.body).data.status, 'interrupted');
  assert.equal(reopened.snapshot().subscriptions.find(item => item.watcherId === waiting.watcherId)?.status, 'waiting');
});

test('Watcher Events preserves a watch when its reader is temporarily unavailable during startup', async t => {
  const f = await fixture(t); const watcher = f.watcher();
  await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId)); await f.service.close();
  f.finish(watcher, 'failed'); f.setWatcherAvailable(false);
  const reopened = await f.reopen(); await reopened.pump();
  assert.equal(reopened.snapshot().subscriptions[0]?.status, 'waiting');
  assert.equal(f.deliveries().length, 0);
  f.setWatcherAvailable(true); await reopened.pump(); await reopened.pump();
  assert.equal(f.deliveries().length, 1);
  assert.equal(JSON.parse(f.deliveries()[0]!.body).data.status, 'failed');
});

test('Watcher Events keeps one event identity across retries, refreshes, duplicates and restart', async t => {
  const f = await fixture(t); f.setResponse(503); const watcher = f.watcher('failed');
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId)); await f.service.pump();
  const original = JSON.parse(f.deliveries()[0]!.body).eventId;
  await f.record(watcher);
  const refreshed = await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId)); assert.equal(refreshed.id, subscription.id);
  f.watchers.clear(); f.owners.clear();
  const reopened = await f.reopen(); f.advance(1000); f.setResponse(204); await reopened.pump();
  assert.equal(f.deliveries().length, 2);
  assert.equal(JSON.parse(f.deliveries()[1]!.body).eventId, original);
  assert.equal(f.deliveries()[1]!.body, f.deliveries()[0]!.body);
  assert.equal(reopened.snapshot().delivered, 1);
});

test('Watcher Events scopes recording and unsubscribe to the owner and rechecks authorization before retry', async t => {
  const f = await fixture(t); const watcher = f.watcher();
  await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId));
  await f.record({ ...watcher, status: 'failed' }, OTHER); await f.service.pump();
  assert.equal(f.deliveries().length, 0);
  await f.service.unsubscribe(OTHER, { name: NAME, arguments: { watcherId: watcher.watcherId }, delivery: { mode: 'webhook', url: CALLBACK } });
  assert.equal(f.service.snapshot().subscriptionCount, 1);
  f.setResponse(503); await f.record(f.finish(watcher)); await f.service.pump();
  f.authorized.delete(PRINCIPAL); f.advance(1000); await f.service.pump();
  assert.equal(f.deliveries().length, 1); assert.equal(f.service.snapshot().subscriptionCount, 0);
  const stored = JSON.parse(await readFile(path.join(f.root, 'events.json'), 'utf8'));
  assert.deepEqual(stored.watcherArchives, []);
});

test('Watcher Events subscription identities cannot collide with job subscriptions for the same UUID', async t => {
  const f = await fixture(t); const watcher = f.watcher(); f.job(watcher.watcherId);
  const jobParams = f.params(watcher.watcherId, { name: JOB_NAME, arguments: { jobId: watcher.watcherId } });
  const job = await f.service.subscribe(PRINCIPAL, jobParams);
  const watched = await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId));
  assert.notEqual(job.id, watched.id);
  assert.equal((await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId))).id, watched.id);
  await f.service.pump(); assert.equal(f.deliveries().length, 1);
  assert.equal(JSON.parse(f.deliveries()[0]!.body).name, JOB_NAME);
  await f.service.unsubscribe(PRINCIPAL, { name: JOB_NAME, arguments: { jobId: watcher.watcherId }, delivery: { mode: 'webhook', url: CALLBACK } });
  assert.equal(f.service.snapshot().subscriptionCount, 1);
  await f.record(f.finish(watcher)); await f.service.pump();
  assert.equal(f.deliveries().length, 2); assert.equal(JSON.parse(f.deliveries()[1]!.body).name, NAME);
  await f.service.unsubscribe(PRINCIPAL, { name: NAME, arguments: { watcherId: watcher.watcherId }, delivery: { mode: 'webhook', url: CALLBACK } });
  const recreated = await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId)); assert.equal(recreated.id, watched.id);
});

test('Watcher Events loads previous version-one job state with no watcher archive field', async t => {
  const f = await fixture(t); const job = f.job(randomUUID()); f.setResponse(503);
  const subscription = await f.service.subscribe(PRINCIPAL, f.params(job.id, { name: JOB_NAME, arguments: { jobId: job.id } }));
  await f.service.pump(); const original = JSON.parse(f.deliveries()[0]!.body).eventId;
  await f.service.close();
  const filename = path.join(f.root, 'events.json'); const legacy = JSON.parse(await readFile(filename, 'utf8'));
  delete legacy.watcherArchives; await writeFile(filename, JSON.stringify(legacy));
  const reopened = await f.reopen();
  assert.equal(reopened.snapshot().subscriptions[0]?.id, subscription.id);
  assert.equal(reopened.getArchivedJob(PRINCIPAL, job.id)?.status, 'succeeded');
  f.advance(1000); f.setResponse(204); await reopened.pump();
  assert.equal(JSON.parse(f.deliveries()[1]!.body).eventId, original);
  const watcher = f.watcher('succeeded'); await reopened.subscribe(PRINCIPAL, f.params(watcher.watcherId)); await reopened.pump();
  assert.equal(JSON.parse(f.deliveries().at(-1)!.body).name, NAME);
});

test('Watcher Events validates persisted watcher ownership and forbids mismatched delivery kinds', async t => {
  const f = await fixture(t); const watcher = f.watcher('succeeded');
  await f.service.subscribe(PRINCIPAL, f.params(watcher.watcherId)); await f.service.close();
  const filename = path.join(f.root, 'events.json'); const valid = JSON.parse(await readFile(filename, 'utf8'));
  const wrongOwner = structuredClone(valid); wrongOwner.watcherArchives[0].principal = OTHER;
  await writeFile(filename, JSON.stringify(wrongOwner)); await assert.rejects(EventService.open(f.options), /estado/i);
  const wrongEvent = structuredClone(valid); wrongEvent.subscriptions[0].delivery.event.name = JOB_NAME;
  await writeFile(filename, JSON.stringify(wrongEvent)); await assert.rejects(EventService.open(f.options), /estado/i);
  const wrongResource = structuredClone(valid); wrongResource.subscriptions[0].delivery.event.data.watcherId = randomUUID();
  await writeFile(filename, JSON.stringify(wrongResource)); await assert.rejects(EventService.open(f.options), /estado/i);
  const waitingArchive = structuredClone(valid); waitingArchive.watcherArchives[0].watcher.status = 'waiting';
  await writeFile(filename, JSON.stringify(waitingArchive)); await assert.rejects(EventService.open(f.options), /estado/i);
});
