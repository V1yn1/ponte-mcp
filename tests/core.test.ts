import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, parseConfig, robloxPreset } from '../src/core/config.js';
import { JobManager } from '../src/core/jobs.js';
import { AuditLog } from '../src/core/audit.js';
import { textResult, type ToolDefinition } from '../src/types.js';

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
