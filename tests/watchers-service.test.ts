import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Job } from '../src/types.js';
import { WatchService, type WatchServiceOptions } from '../src/watchers/service.js';

const OWNER = 'owner'; const OTHER = 'other';
const input = { name: 'Trabalho remoto', trigger: { type: 'signal' as const, source: 'claude', runId: 'run-1' } };
const body = () => ({ eventId: randomUUID(), runId: 'run-1', status: 'succeeded' as const, summary: 'Concluído', evidence: { checks: ['ok'] } });
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-watchers-'));
  const authorized = new Set([OWNER, OTHER]); const jobs = new Map<string, Job>(); let paused = false;
  const options: WatchServiceOptions = { stateDir: root, secretKey: 'stable-instance-secret',
    isAuthorized: principal => authorized.has(principal), isPaused: () => paused,
    getJob: (principal, id) => { if (principal !== OWNER || !jobs.has(id)) throw new Error('missing'); return jobs.get(id)!; } };
  let service = await WatchService.open(options);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, authorized, jobs, options, get service() { return service; }, pause() { paused = true; },
    async reopen() { await service.close(); service = await WatchService.open(options); return service; },
    job(status: Job['status'] = 'running') { const now = new Date().toISOString(); const job: Job = { id: randomUUID(), tool: 'remote', source: 'test', risk: 'execute', status, createdAt: now, updatedAt: now, arguments: {} }; jobs.set(job.id, job); return job; } };
}

test('watcher signal persists before waking waiters and exposes no credentials in queries', async t => {
  const f = await fixture(t); const created = await f.service.create(OWNER, input); assert.ok(created.signalToken);
  const pending = f.service.wait(OWNER, created.watcherId, 5000);
  await new Promise(resolve => setImmediate(resolve));
  const event = body(); const completed = await f.service.signal(created.watcherId, created.signalToken!, event);
  assert.equal(completed.status, 'succeeded'); assert.deepEqual((await pending).result, { summary: event.summary, evidence: event.evidence });
  assert.equal(f.service.snapshot().activeWaiters, 0);
  const stored = await readFile(path.join(f.root, 'watchers.json'), 'utf8');
  assert.equal(JSON.parse(stored).watchers[0].status, 'succeeded'); assert.ok(!stored.includes(created.signalToken!));
  assert.equal((await stat(path.join(f.root, 'watchers.json'))).mode & 0o777, 0o600);
  for (const value of [await f.service.get(OWNER, created.watcherId), await f.service.list(OWNER), f.service.snapshot()]) {
    assert.ok(!JSON.stringify(value).includes(created.signalToken!)); assert.ok(!JSON.stringify(value).includes('"principal"'));
  }
  assert.equal((await f.service.wait(OWNER, created.watcherId, 0)).status, 'succeeded');
});

test('terminal listeners observe persisted watcher outcomes once without receiving callback credentials', async t => {
  const f = await fixture(t);
  const observed: Array<{ principal: string; watcher: any; stored: Promise<string> }> = [];
  const stop = f.service.onTerminal((principal, watcher) => {
    observed.push({ principal, watcher, stored: readFile(path.join(f.root, 'watchers.json'), 'utf8') });
  });
  const watcher = await f.service.create(OWNER, input);
  assert.equal(observed.length, 0);
  const event = body();
  await f.service.signal(watcher.watcherId, watcher.signalToken!, event);
  await f.service.signal(watcher.watcherId, watcher.signalToken!, event);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].principal, OWNER);
  assert.equal(observed[0].watcher.watcherId, watcher.watcherId);
  assert.equal(JSON.parse(await observed[0].stored).watchers[0].status, 'succeeded');
  assert.equal(observed[0].watcher.signalToken, undefined);
  assert.equal(observed[0].watcher.tokenHash, undefined);
  stop();
  const next = await f.service.create(OWNER, input);
  await f.service.cancel(OWNER, next.watcherId);
  assert.equal(observed.length, 1);
});

test('a failing terminal listener cannot roll back a committed result or duplicate the signal', async t => {
  const f = await fixture(t);
  f.service.onTerminal(() => { throw new Error('subscriber unavailable'); });
  const watcher = await f.service.create(OWNER, input);
  const event = body();
  assert.equal((await f.service.signal(watcher.watcherId, watcher.signalToken!, event)).status, 'succeeded');
  assert.equal((await f.service.signal(watcher.watcherId, watcher.signalToken!, event)).status, 'succeeded');
  assert.equal((await f.service.get(OWNER, watcher.watcherId)).status, 'succeeded');
});

test('watchers enforce ownership, callback credential and run correlation', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, input);
  await assert.rejects(f.service.get(OTHER, w.watcherId)); await assert.rejects(f.service.cancel(OTHER, w.watcherId));
  await assert.rejects(f.service.wait(OTHER, w.watcherId, 1)); assert.equal((await f.service.list(OTHER)).total, 0);
  await assert.rejects(f.service.signal(w.watcherId, 'wrong', body()));
  await assert.rejects(f.service.signal(w.watcherId, w.signalToken!, { ...body(), runId: 'wrong' }));
  assert.equal((await f.service.get(OWNER, w.watcherId)).status, 'waiting');
});

test('duplicate signals and creations are idempotent but conflicting content cannot overwrite', async t => {
  const f = await fixture(t); const createInput = { ...input, idempotencyKey: 'stable-key' };
  const w = await f.service.create(OWNER, createInput); const again = await f.service.create(OWNER, createInput);
  assert.deepEqual(again, w); await assert.rejects(f.service.create(OWNER, { ...createInput, name: 'different' }));
  const event = body(); await f.service.signal(w.watcherId, w.signalToken!, event);
  assert.equal((await f.service.signal(w.watcherId, w.signalToken!, event)).status, 'succeeded');
  await assert.rejects(f.service.signal(w.watcherId, w.signalToken!, { ...event, summary: 'different' }));
  await assert.rejects(f.service.signal(w.watcherId, w.signalToken!, body()));
  assert.equal((await f.service.get(OWNER, w.watcherId)).result?.summary, event.summary);
});

test('restart preserves pending signal, terminal result and derived creation token', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, { ...input, idempotencyKey: 'restart' });
  await f.reopen(); assert.equal((await f.service.get(OWNER, w.watcherId)).status, 'waiting');
  assert.equal((await f.service.create(OWNER, { ...input, idempotencyKey: 'restart' })).signalToken, w.signalToken);
  const event = body(); await f.service.signal(w.watcherId, w.signalToken!, { ...event, status: 'needs_input' });
  await f.reopen(); assert.equal((await f.service.get(OWNER, w.watcherId)).status, 'needs_input');
});

test('revocation while waiting rejects delivery and durably cancels the watcher', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, input);
  const pending = f.service.wait(OWNER, w.watcherId, 5000); const rejected = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve)); f.authorized.delete(OWNER);
  await rejected; assert.equal((await f.service.adminGet(w.watcherId)).status, 'cancelled');
  await assert.rejects(f.service.signal(w.watcherId, w.signalToken!, body()));
  assert.equal(f.service.snapshot().activeWaiters, 0);
});

test('aborting a waiter or reaching its short deadline leaves the durable watcher waiting', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, input); const controller = new AbortController();
  const pending = f.service.wait(OWNER, w.watcherId, 5000, controller.signal); const rejected = assert.rejects(pending);
  controller.abort(); await rejected; assert.equal(f.service.snapshot().activeWaiters, 0);
  assert.equal((await f.service.wait(OWNER, w.watcherId, 5)).status, 'waiting');
  assert.equal((await f.service.get(OWNER, w.watcherId)).status, 'waiting');
  assert.equal(f.service.snapshot().activeWaiters, 0);
});

test('watcher expires independently of a waiting call and cancellation stays terminal', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, { ...input, timeoutMs: 1000 });
  assert.equal((await f.service.wait(OWNER, w.watcherId, 3000)).status, 'expired');
  await assert.rejects(f.service.signal(w.watcherId, w.signalToken!, body()));
  const next = await f.service.create(OWNER, input); assert.equal((await f.service.adminCancel(next.watcherId)).status, 'cancelled');
  assert.equal((await f.service.wait(OWNER, next.watcherId, 0)).status, 'cancelled');
});

test('job triggers capture terminal jobs while signal watchers ignore delegation job completion', async t => {
  const f = await fixture(t); const job = f.job(); const linked = await f.service.create(OWNER, { name: 'Job', trigger: { type: 'job', jobId: job.id } });
  const remote = await f.service.create(OWNER, input); job.status = 'succeeded'; job.result = { content: [{ type: 'text', text: 'Sent keys' }] };
  await f.service.recordJob(job); assert.equal((await f.service.get(OWNER, linked.watcherId)).status, 'succeeded');
  assert.equal((await f.service.get(OWNER, remote.watcherId)).status, 'waiting');
  const immediate = await f.service.create(OWNER, { name: 'Completed', trigger: { type: 'job', jobId: job.id } }); assert.equal(immediate.status, 'succeeded');
  const missing = f.job(); const interrupted = await f.service.create(OWNER, { name: 'Lost', trigger: { type: 'job', jobId: missing.id } });
  f.jobs.clear(); await f.reopen(); assert.equal((await f.service.get(OWNER, interrupted.watcherId)).status, 'interrupted');
});

test('paused service blocks creation while accepting completion of an armed watcher', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, input); f.pause();
  await assert.rejects(f.service.create(OWNER, input)); assert.equal((await f.service.signal(w.watcherId, w.signalToken!, body())).status, 'succeeded');
});

test('validation bounds create, signal payload, waits and active watcher capacity', async t => {
  const f = await fixture(t);
  for (const bad of [{ ...input, name: '' }, { ...input, timeoutMs: 999 }, { ...input, timeoutMs: 604800001 }, { ...input, idempotencyKey: 'has spaces' }]) await assert.rejects(f.service.create(OWNER, bad));
  const w = await f.service.create(OWNER, input);
  await assert.rejects(f.service.signal(w.watcherId, w.signalToken!, { ...body(), evidence: { large: 'x'.repeat(32768) } }));
  await assert.rejects(f.service.wait(OWNER, w.watcherId, 300001));
  for (let i = 1; i < 100; i++) await f.service.create(OWNER, { ...input, name: `Watcher ${i}` });
  await assert.rejects(f.service.create(OWNER, input)); assert.equal(f.service.snapshot().stats.waiting, 100);
});

test('watcher state rejects corruption and symbolic links', async t => {
  const f = await fixture(t); await f.service.close(); const filename = path.join(f.root, 'watchers.json');
  await writeFile(filename, '{"version":1,"watchers":"bad"}'); await assert.rejects(WatchService.open(f.options), /estado/i);
  await rm(filename); const target = path.join(f.root, 'target.json'); await writeFile(target, '{}'); await symlink(target, filename);
  await assert.rejects(WatchService.open(f.options), /estado|arquivo/i);
});

test('waiter capacity is bounded and released by abort without changing the watcher', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, input); const controller = new AbortController();
  const waits = Array.from({ length: 20 }, () => f.service.wait(OWNER, w.watcherId, 5000, controller.signal).catch(() => undefined));
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.service.snapshot().activeWaiters, 20);
  await assert.rejects(f.service.wait(OWNER, w.watcherId, 5000)); controller.abort(); await Promise.all(waits);
  assert.equal(f.service.snapshot().activeWaiters, 0); assert.equal((await f.service.wait(OWNER, w.watcherId, 1)).status, 'waiting');
});

test('concurrent signals admit one result and disk failure never publishes a terminal result', async t => {
  const f = await fixture(t); const w = await f.service.create(OWNER, input);
  const results = await Promise.allSettled([f.service.signal(w.watcherId, w.signalToken!, body()), f.service.signal(w.watcherId, w.signalToken!, { ...body(), status: 'failed' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const pending = await f.service.create(OWNER, input); const filename = path.join(f.root, 'watchers.json');
  const target = path.join(f.root, 'other.json'); await writeFile(target, '{}'); await rm(filename); await symlink(target, filename);
  await assert.rejects(f.service.signal(pending.watcherId, pending.signalToken!, body()));
  assert.equal(f.service.snapshot().watchers.find(item => item.watcherId === pending.watcherId)?.status, 'waiting');
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('loading rejects corrupted creation identity and token hashes', async t => {
  const f = await fixture(t); await f.service.create(OWNER, { ...input, idempotencyKey: 'disk-key' }); await f.service.close();
  const filename = path.join(f.root, 'watchers.json'); const stored = JSON.parse(await readFile(filename, 'utf8'));
  for (const field of ['inputHash', 'tokenHash']) {
    const corrupted = structuredClone(stored); corrupted.watchers[0][field] = '0'.repeat(64); await writeFile(filename, JSON.stringify(corrupted));
    await assert.rejects(WatchService.open(f.options), /estado/i);
  }
});

test('close rejects waits in authorization and leaves no waiter registered after draining work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-watchers-close-'));
  let blocked = false; let announce!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = await WatchService.open({ stateDir: root, secretKey: 'stable-instance-secret', getJob: () => undefined,
    isAuthorized: async () => { if (blocked) { announce(); await gate; } return true; } });
  const controller = new AbortController();
  t.after(async () => { release(); controller.abort(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const watcher = await service.create(OWNER, input);
  const existing = service.wait(OWNER, watcher.watcherId, 45000, controller.signal).then(() => 'resolved', () => 'rejected');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(service.snapshot().activeWaiters, 1);
  blocked = true;
  const waiting = service.wait(OWNER, watcher.watcherId, 45000, controller.signal).then(() => 'resolved', () => 'rejected');
  await entered;
  const closing = service.close(); release(); await closing;
  assert.equal(service.snapshot().activeWaiters, 0, 'close must cover registrations that were awaiting authorization');
  assert.equal(await existing, 'rejected'); assert.equal(await waiting, 'rejected');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(service.snapshot().activeWaiters, 0);
  assert.equal(service.snapshot().stats.waiting, 1, 'Closing the service must preserve the durable watcher.');
});

test('authenticateSignal validates scoped credentials and grants without completing a watcher', async t => {
  const f = await fixture(t); const watcher = await f.service.create(OWNER, input); const other = await f.service.create(OWNER, input);
  await assert.rejects(f.service.authenticateSignal(watcher.watcherId, 'wrong'));
  await assert.rejects(f.service.authenticateSignal(other.watcherId, watcher.signalToken!));
  await assert.rejects(f.service.authenticateSignal(randomUUID(), watcher.signalToken!));
  await f.service.authenticateSignal(watcher.watcherId, watcher.signalToken!);
  assert.equal((await f.service.get(OWNER, watcher.watcherId)).status, 'waiting');
  f.authorized.delete(OWNER); await assert.rejects(f.service.authenticateSignal(watcher.watcherId, watcher.signalToken!));
});

test('run identifiers reject whitespace-only and control characters without trimming correlation', async t => {
  const f = await fixture(t);
  for (const runId of ['task\n', '   ', 'task\u0000', 'task\u007f']) {
    await assert.rejects(f.service.create(OWNER, { ...input, trigger: { ...input.trigger, runId } }));
  }
  const watcher = await f.service.create(OWNER, { ...input, trigger: { ...input.trigger, runId: ' task ' } });
  for (const runId of ['task\n', '   ', 'task']) await assert.rejects(f.service.signal(watcher.watcherId, watcher.signalToken!, { ...body(), runId }));
  assert.equal((await f.service.signal(watcher.watcherId, watcher.signalToken!, { ...body(), runId: ' task ' })).status, 'succeeded');
});

test('recordJob preserves a trusted terminal snapshot after JobManager prunes the job', async t => {
  const f = await fixture(t); const job = f.job();
  const watcher = await f.service.create(OWNER, { name: 'Job retido', trigger: { type: 'job', jobId: job.id } });
  job.status = 'succeeded'; job.result = { message: 'Resultado terminal recebido' };
  const recorded = f.service.recordJob(structuredClone(job)); f.jobs.delete(job.id); await recorded;
  const completed = await f.service.get(OWNER, watcher.watcherId);
  assert.equal(completed.status, 'succeeded'); assert.deepEqual(completed.result?.evidence, { jobResult: job.result });
});
