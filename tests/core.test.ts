import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, parseConfig, robloxPreset } from '../src/core/config.js';
import { JobManager } from '../src/core/jobs.js';
import { AuditLog } from '../src/core/audit.js';
import { textResult, type AppConfig, type ToolDefinition } from '../src/types.js';

function tool(risk: ToolDefinition['risk'], execute?: ToolDefinition['execute']): ToolDefinition {
  return {
    tool: { name: 'test_tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
    source: 'test', risk, fingerprint: 'version-a',
    execute: execute ?? (async args => textResult(args.value)),
  };
}
async function settled(manager: JobManager, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = manager.get(id);
    if (!['running', 'queued'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('job did not settle');
}

test('creates separate credentials and preserves existing configuration', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ponte-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = await ConfigStore.open(path.join(dir, 'state'), { workspace: path.join(dir, 'project') });
  assert.notEqual(state.secrets.adminToken, state.secrets.apiToken);
  assert.ok(state.secrets.adminToken.length >= 40);
  assert.equal(state.config.projects[0]?.allowExec, false);
  assert.equal(state.config.approvalMode, 'mutations');
  const reopened = await ConfigStore.open(path.join(dir, 'state'));
  assert.deepEqual(reopened.secrets, state.secrets);
  assert.deepEqual(reopened.config, state.config);
});

test('configuration rejects public unencrypted upstream, duplicate IDs, and overlapping listener ports', () => {
  const base = { version: 1, port: 4317, apiPort: 4318, approvalMode: 'mutations', projects: [], upstreams: [] };
  assert.throws(() => parseConfig({ ...base, port: 4318 }));
  assert.throws(() => parseConfig({ ...base, upstreams: [{ id: 'x', name: 'X', transport: 'http', enabled: true, url: 'http://example.com/mcp' }] }));
  const project = { id: 'p', name: 'P', root: '/tmp/p', allowWrite: true, allowExec: false };
  assert.throws(() => parseConfig({ ...base, projects: [project, project] }));
  assert.deepEqual(robloxPreset('win32').args, ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat']);
});

test('configuration persists automatic approval without changing the default or accepting unknown modes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ponte-automatic-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = await ConfigStore.open(path.join(dir, 'state'), { workspace: path.join(dir, 'project') });
  assert.equal(state.config.approvalMode, 'mutations');
  await state.update(config => ({ ...config, approvalMode: 'automatic' }));
  assert.equal(state.config.approvalMode, 'automatic');
  assert.equal((await ConfigStore.open(path.join(dir, 'state'))).config.approvalMode, 'automatic');
  await assert.rejects(state.update(config => ({ ...config, approvalMode: 'unknown' as AppConfig['approvalMode'] })));
  assert.equal(state.config.approvalMode, 'automatic');
});

test('automatic mode executes every risk for local and upstream tools and preserves validation', async t => {
  for (const source of ['local', 'mcp:fixture']) {
    for (const risk of ['read', 'write', 'execute'] as const) {
      await t.test(`${source} ${risk}`, async t => {
        const calls: unknown[] = [];
        const definition = { ...tool(risk, async args => { calls.push(args.value); return textResult(args.value); }), source };
        const jobs = new JobManager(() => [definition], () => 'automatic');
        t.after(() => jobs.close());
        await assert.rejects(jobs.submit('test_tool', { value: 123 }), /inválidos/);
        const job = await jobs.submit('test_tool', { value: 'original' });
        job.arguments.value = 'tampered';
        const completed = await settled(jobs, job.id);
        assert.equal(completed.status, 'succeeded');
        assert.equal(completed.approval, 'automatic');
        assert.deepEqual(calls, ['original']);
      });
    }
  }
});

test('all mode still requires manual approval for every risk', async t => {
  for (const risk of ['read', 'write', 'execute'] as const) {
    const jobs = new JobManager(() => [tool(risk)], () => 'all');
    t.after(() => jobs.close());
    const job = await jobs.submit('test_tool', { value: risk });
    assert.equal(job.status, 'pending_approval');
    assert.equal(job.approval, undefined);
    jobs.approve(job.id);
    const completed = await settled(jobs, job.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.approval, 'manual');
  }
});

test('enabling automatic approval releases pending immutable requests exactly once', async t => {
  let mode: AppConfig['approvalMode'] = 'all';
  const calls: unknown[] = [];
  const definitions = (['read', 'write', 'execute'] as const).map(risk => {
    const definition = tool(risk, async args => { calls.push(args.value); return textResult('ok'); });
    definition.tool.name = risk;
    return definition;
  });
  const jobs = new JobManager(() => definitions, () => mode);
  t.after(() => jobs.close());
  const pending = await Promise.all(definitions.map(definition => jobs.submit(definition.tool.name, { value: definition.risk })));
  pending[0]!.arguments.value = 'tampered';
  mode = 'automatic';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 3, rejected: 0, returnedToPending: 0 });
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 0, rejected: 0, returnedToPending: 0 });
  for (const job of pending) {
    const completed = await settled(jobs, job.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.approval, 'automatic');
  }
  assert.deepEqual(calls.sort(), ['execute', 'read', 'write']);
});

test('automatic reconciliation rejects changed or removed definitions and continues with valid requests', async t => {
  let mode: AppConfig['approvalMode'] = 'all';
  const calls: unknown[] = [];
  let definitions = ['changed', 'removed', 'valid'].map(name => {
    const definition = tool('execute', async args => { calls.push(args.value); return textResult('ok'); });
    definition.tool.name = name;
    return definition;
  });
  const jobs = new JobManager(() => definitions, () => mode);
  t.after(() => jobs.close());
  const pending = await Promise.all(definitions.map(definition => jobs.submit(definition.tool.name, { value: definition.tool.name })));
  definitions = definitions.filter(definition => definition.tool.name !== 'removed').map(definition => definition.tool.name === 'changed' ? { ...definition, fingerprint: 'version-b' } : definition);
  mode = 'automatic';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 1, rejected: 2, returnedToPending: 0 });
  for (const job of pending.slice(0, 2)) {
    assert.equal(jobs.get(job.id).status, 'rejected');
    assert.match(jobs.get(job.id).error!, /alterad/);
  }
  assert.equal((await settled(jobs, pending[2]!.id)).status, 'succeeded');
  assert.deepEqual(calls, ['valid']);
});

test('automatic reconciliation expires stale approvals before releasing the queue', async t => {
  let mode: AppConfig['approvalMode'] = 'all';
  const calls: unknown[] = [];
  const jobs = new JobManager(() => [tool('write', async args => { calls.push(args.value); return textResult('ok'); })], () => mode);
  t.after(() => jobs.close());
  const pending = await jobs.submit('test_tool', { value: 'stale' });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 16 * 60 * 1000);
  mode = 'automatic';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 0, rejected: 0, returnedToPending: 0 });
  assert.equal(jobs.get(pending.id).status, 'expired');
  assert.deepEqual(calls, []);
});

test('automatic approval queues while paused and resuming reconciles the latest mode', async t => {
  let mode: AppConfig['approvalMode'] = 'all';
  const calls: unknown[] = [];
  const jobs = new JobManager(() => [tool('execute', async args => { calls.push(args.value); return textResult('ok'); })], () => mode);
  t.after(() => jobs.close());
  const pending = await jobs.submit('test_tool', { value: 'paused' });
  jobs.setPaused(true);
  mode = 'automatic';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 1, rejected: 0, returnedToPending: 0 });
  assert.equal(jobs.paused, true);
  assert.equal(jobs.get(pending.id).status, 'queued');
  assert.deepEqual(calls, []);
  await assert.rejects(jobs.submit('test_tool', { value: 'new' }), /paus/i);
  mode = 'all';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 0, rejected: 0, returnedToPending: 1 });
  assert.equal(jobs.get(pending.id).status, 'pending_approval');
  assert.equal(jobs.get(pending.id).approval, undefined);
  mode = 'automatic';
  jobs.setPaused(false);
  assert.equal((await settled(jobs, pending.id)).status, 'succeeded');
  assert.deepEqual(calls, ['paused']);
});

test('disabling automatic mode restores required review but keeps running and manually approved jobs', async t => {
  for (const nextMode of ['mutations', 'all'] as const) {
    await t.test(nextMode, async t => {
      let mode: AppConfig['approvalMode'] = 'automatic';
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const calls: unknown[] = [];
      const definitions = (['read', 'write', 'execute'] as const).map(risk => {
        const definition = tool(risk, async args => {
          calls.push(args.value);
          if (String(args.value).startsWith('running-')) await gate;
          return textResult('ok');
        });
        definition.tool.name = risk;
        return definition;
      });
      const jobs = new JobManager(() => definitions, () => mode);
      t.after(() => { release(); jobs.close(); });
      const running = await Promise.all(Array.from({ length: 4 }, (_, index) => jobs.submit('write', { value: `running-${index}` })));
      mode = 'all';
      jobs.reconcileApprovalMode();
      const manual = await jobs.submit('write', { value: 'manual' });
      jobs.approve(manual.id);
      mode = 'automatic';
      const queued = await Promise.all(definitions.map(definition => jobs.submit(definition.tool.name, { value: definition.risk })));
      assert.ok(queued.every(job => job.status === 'queued'));
      mode = nextMode;
      assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 0, rejected: 0, returnedToPending: nextMode === 'all' ? 3 : 2 });
      assert.ok(running.every(job => jobs.get(job.id).status === 'running'));
      assert.equal(jobs.get(manual.id).status, 'queued');
      assert.equal(jobs.get(manual.id).approval, 'manual');
      for (const job of queued) {
        const needsApproval = nextMode === 'all' || job.risk !== 'read';
        assert.equal(jobs.get(job.id).status, needsApproval ? 'pending_approval' : 'queued');
        assert.equal(jobs.get(job.id).approval, needsApproval ? undefined : 'automatic');
      }
      release();
      for (const job of [...running, manual]) assert.equal((await settled(jobs, job.id)).status, 'succeeded');
      const read = queued.find(job => job.risk === 'read')!;
      if (nextMode === 'mutations') assert.equal((await settled(jobs, read.id)).status, 'succeeded');
      assert.ok(!calls.includes('write'));
      assert.ok(!calls.includes('execute'));
      if (nextMode === 'all') assert.ok(!calls.includes('read'));
    });
  }
});

test('queued automatic jobs check the latest mode even before settings reconciliation', async t => {
  let mode: AppConfig['approvalMode'] = 'automatic';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: unknown[] = [];
  const definition = tool('write', async args => { calls.push(args.value); await gate; return textResult('ok'); });
  const jobs = new JobManager(() => [definition], () => mode);
  t.after(() => { release(); jobs.close(); });
  const running = await Promise.all(Array.from({ length: 4 }, (_, index) => jobs.submit('test_tool', { value: `running-${index}` })));
  const queued = await jobs.submit('test_tool', { value: 'must-review' });
  assert.equal(queued.status, 'queued');
  mode = 'all';
  release();
  for (const job of running) await settled(jobs, job.id);
  assert.equal(jobs.get(queued.id).status, 'pending_approval');
  assert.equal(jobs.get(queued.id).approval, undefined);
  assert.ok(!calls.includes('must-review'));
});

test('asynchronous previews use the latest approval mode and retain immutable arguments', async t => {
  for (const nextMode of ['automatic', 'all'] as const) {
    await t.test(nextMode, async t => {
      let mode: AppConfig['approvalMode'] = nextMode === 'automatic' ? 'all' : 'automatic';
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const previewStarted = new Promise<void>(resolve => { started = resolve; });
      const calls: unknown[] = [];
      const definition = tool('write', async args => { calls.push(args.value); return textResult('ok'); });
      definition.preview = async args => { args.value = 'preview mutation'; started(); await gate; return 'preview'; };
      const jobs = new JobManager(() => [definition], () => mode);
      t.after(() => { release(); jobs.close(); });
      const args = { value: 'original' };
      const submitting = jobs.submit('test_tool', args);
      void submitting.catch(() => {});
      await previewStarted;
      args.value = 'caller mutation';
      mode = nextMode;
      jobs.reconcileApprovalMode();
      release();
      const job = await submitting;
      assert.equal(job.arguments.value, 'original');
      if (nextMode === 'automatic') {
        assert.equal((await settled(jobs, job.id)).status, 'succeeded');
        assert.deepEqual(calls, ['original']);
      } else {
        assert.equal(job.status, 'pending_approval');
        assert.deepEqual(calls, []);
      }
    });
  }
});

test('pausing as an automatically approved job starts prevents the next queued job from starting', async t => {
  let mode: AppConfig['approvalMode'] = 'all';
  const calls: unknown[] = [];
  const definition = tool('write', async args => {
    calls.push(args.value);
    if (args.value === 'first') jobs.setPaused(true);
    return textResult('ok');
  });
  const jobs = new JobManager(() => [definition], () => mode);
  t.after(() => jobs.close());
  const first = await jobs.submit('test_tool', { value: 'first' });
  const second = await jobs.submit('test_tool', { value: 'second' });
  mode = 'automatic';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 2, rejected: 0, returnedToPending: 0 });
  assert.equal(jobs.get(second.id).status, 'queued');
  assert.deepEqual(calls, ['first']);
  jobs.setPaused(false);
  for (const job of [first, second]) assert.equal((await settled(jobs, job.id)).status, 'succeeded');
  assert.deepEqual(calls, ['first', 'second']);
});

test('automatic mode preserves concurrent idempotency', async t => {
  const calls: unknown[] = [];
  const jobs = new JobManager(() => [tool('execute', async args => { calls.push(args.value); return textResult('ok'); })], () => 'automatic');
  t.after(() => jobs.close());
  const duplicates = await Promise.all(Array.from({ length: 10 }, () => jobs.submit('test_tool', { value: 'one' }, 'automatic-request')));
  assert.equal(new Set(duplicates.map(job => job.id)).size, 1);
  assert.equal((await settled(jobs, duplicates[0]!.id)).status, 'succeeded');
  assert.deepEqual(calls, ['one']);
  await assert.rejects(jobs.submit('test_tool', { value: 'different' }, 'automatic-request'), /idemp/i);
  jobs.close();
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 0, rejected: 0, returnedToPending: 0 });
  await assert.rejects(jobs.submit('test_tool', { value: 'closed' }), /encerrando/);
  assert.deepEqual(calls, ['one']);
});

test('closed managers never approve or release previously pending work', async () => {
  let mode: AppConfig['approvalMode'] = 'all';
  const calls: unknown[] = [];
  const jobs = new JobManager(() => [tool('write', async args => { calls.push(args.value); return textResult('ok'); })], () => mode);
  const pending = await jobs.submit('test_tool', { value: 'closed' });
  jobs.close();
  mode = 'automatic';
  assert.deepEqual(jobs.reconcileApprovalMode(), { approved: 0, rejected: 0, returnedToPending: 0 });
  jobs.setPaused(false);
  assert.equal(jobs.get(pending.id).status, 'cancelled');
  assert.deepEqual(calls, []);
});

test('audit records automatic and manual approval metadata without arguments or results', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ponte-approval-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = new AuditLog(dir);
  let mode: AppConfig['approvalMode'] = 'automatic';
  const jobs = new JobManager(() => [tool('write')], () => mode, audit);
  t.after(() => jobs.close());
  const automatic = await jobs.submit('test_tool', { value: 'SECRET-AUTOMATIC' });
  await settled(jobs, automatic.id);
  mode = 'all';
  const manual = await jobs.submit('test_tool', { value: 'SECRET-MANUAL' });
  jobs.approve(manual.id);
  await settled(jobs, manual.id);
  await audit.flush();
  const content = await readFile(path.join(dir, 'audit.jsonl'), 'utf8');
  const entries = content.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.jobId === automatic.id && entry.status === 'queued' && entry.approval === 'automatic'));
  assert.ok(entries.some(entry => entry.jobId === manual.id && entry.status === 'pending_approval' && entry.approval === undefined));
  assert.ok(entries.some(entry => entry.jobId === manual.id && entry.status === 'queued' && entry.approval === 'manual'));
  assert.ok(!content.includes('SECRET-'));
});

test('read calls run automatically but mutations wait for an immutable approval', async () => {
  const calls: string[] = [];
  let current = tool('write', async args => { calls.push(String(args.value)); return textResult('ok'); });
  const jobs = new JobManager(() => [current], () => 'mutations');
  const args = { value: 'original' };
  const job = await jobs.submit('test_tool', args);
  args.value = 'changed';
  job.arguments.value = 'tampered';
  assert.equal(job.status, 'pending_approval');
  assert.deepEqual(calls, []);
  jobs.approve(job.id);
  assert.equal((await settled(jobs, job.id)).status, 'succeeded');
  assert.deepEqual(calls, ['original']);
  assert.throws(() => jobs.approve(job.id));
  current = tool('read');
  const read = await jobs.submit('test_tool', { value: 'read' });
  assert.equal((await settled(jobs, read.id)).status, 'succeeded');
  jobs.close();
});

test('rejects malformed arguments, pauses, and never approves a changed tool definition', async () => {
  let current = tool('write');
  const jobs = new JobManager(() => [current], () => 'mutations');
  await assert.rejects(jobs.submit('test_tool', { value: 12 }));
  const job = await jobs.submit('test_tool', { value: 'x' });
  current = { ...current, fingerprint: 'version-b' };
  assert.throws(() => jobs.approve(job.id), /alterad|changed/i);
  jobs.setPaused(true);
  await assert.rejects(jobs.submit('test_tool', { value: 'x' }), /paus/i);
  jobs.close();
});

test('idempotency protects against duplicate work and detects reused keys with changed input', async () => {
  const jobs = new JobManager(() => [tool('write')], () => 'mutations');
  const first = await jobs.submit('test_tool', { value: 'x' }, 'request-123');
  const same = await jobs.submit('test_tool', { value: 'x' }, 'request-123');
  assert.equal(first.id, same.id);
  await assert.rejects(jobs.submit('test_tool', { value: 'y' }, 'request-123'), /idemp/i);
  jobs.close();
});

test('cancellation aborts an executing tool and cannot later become succeeded', async () => {
  const slow = tool('read', async (_args, { signal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    return textResult('too late');
  });
  const jobs = new JobManager(() => [slow], () => 'mutations');
  const job = await jobs.submit('test_tool', { value: 'x' });
  await new Promise(resolve => setTimeout(resolve, 10));
  jobs.cancel(job.id);
  assert.equal((await settled(jobs, job.id)).status, 'cancelled');
  jobs.close();
});

test('MCP isError results mark jobs failed and retain tool result', async () => {
  const jobs = new JobManager(() => [tool('read', async () => ({ ...textResult('upstream failure'), isError: true }))], () => 'mutations');
  const job = await jobs.submit('test_tool', { value: 'x' });
  const result = await settled(jobs, job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.result?.isError, true);
  jobs.close();
});

test('accepts JSON Schema 2020-12 and enforces unevaluatedProperties for modern MCP tools', async () => {
  const definition = tool('read');
  definition.tool.inputSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { value: { type: 'string' } }, required: ['value'], unevaluatedProperties: false,
  };
  const jobs = new JobManager(() => [definition], () => 'mutations');
  const job = await jobs.submit('test_tool', { value: 'modern schema' });
  assert.equal((await settled(jobs, job.id)).status, 'succeeded');
  await assert.rejects(jobs.submit('test_tool', { value: 'x', extra: true }), /inválidos/);
  jobs.close();
});

test('default schema dialect enforces modern keywords and explicit draft-07 remains supported', async () => {
  const definition = tool('read');
  definition.tool.inputSchema = { type: 'object', properties: { value: { type: 'string' } }, unevaluatedProperties: false };
  const jobs = new JobManager(() => [definition], () => 'mutations');
  await assert.rejects(jobs.submit('test_tool', { value: 'x', extra: true }), /inválidos/);
  definition.tool.inputSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false };
  const job = await jobs.submit('test_tool', { value: 'legacy schema' });
  assert.equal((await settled(jobs, job.id)).status, 'succeeded');
  jobs.close();
});

test('audit persists only metadata, never tool arguments or output', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ponte-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = new AuditLog(dir);
  const jobs = new JobManager(() => [tool('read')], () => 'mutations', audit);
  const job = await jobs.submit('test_tool', { value: 'SECRET-CODE' });
  await settled(jobs, job.id);
  await audit.flush();
  const content = await readFile(path.join(dir, 'audit.jsonl'), 'utf8');
  assert.ok(content.includes(job.id));
  assert.ok(!content.includes('SECRET-CODE'));
  jobs.close();
});
