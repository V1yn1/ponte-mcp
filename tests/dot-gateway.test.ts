import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { JobManager } from '../src/core/jobs.js';
import { callGateway, publicTools } from '../src/mcp/server.js';
import { WatchService } from '../src/watchers/service.js';
import { watcherControlTools } from '../src/watchers/tools.js';
import { textResult, type AppConfig, type ToolDefinition } from '../src/types.js';

function definition(name = 'fixture_read', risk: ToolDefinition['risk'] = 'read', execute: ToolDefinition['execute'] = async args => textResult(args)): ToolDefinition {
  return {
    tool: { name, title: name, description: 'Ferramenta de teste com argumentos exatos.', inputSchema: {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
    } },
    risk, source: 'mcp:fixture', fingerprint: 'first', execute,
  };
}

function fixture(t: TestContext, definitions = [definition()], mode: AppConfig['approvalMode'] = 'mutations') {
  const state = { definitions, mode };
  const jobs = new JobManager(() => state.definitions, () => state.mode);
  t.after(() => jobs.close());
  const gateway = {
    jobs, getTools: () => state.definitions, publicStatus: () => ({ approvalMode: state.mode }),
    getJobForClient(id: string, principal?: string) {
      if (principal !== undefined && jobs.ownerOf(id) !== principal) throw new Error('Trabalho indisponível para esta conexão.');
      return jobs.get(id);
    },
  };
  return { state, jobs, gateway };
}

function payload(result: CallToolResult): any {
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  return JSON.parse(first.type === 'text' ? first.text : '{}');
}

const input = (tool: string, args: Record<string, unknown> = { value: 'real input' }, idempotencyKey?: string) => ({
  tool, argumentsJson: JSON.stringify(args), ...(idempotencyKey ? { idempotencyKey } : {}),
});

async function settled(jobs: JobManager, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = jobs.get(id);
    if (!['running', 'queued'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The job did not settle.');
}

async function watchers(t: TestContext) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ponte-dot-watchers-'));
  const service = await WatchService.open({
    stateDir, secretKey: 'isolated-dot-test-key', isAuthorized: principal => principal === 'owner',
    getJob: () => { throw new Error('No job expected.'); },
  });
  t.after(async () => { await service.close(); await rm(stateDir, { recursive: true, force: true }); });
  return service;
}

test('JSON gateways execute the real leaf with literal arguments and preserve direct and legacy calls', async t => {
  const received: unknown[] = [];
  const tool = definition('fixture_read', 'read', async args => { received.push(args.value); return textResult(args); });
  const { gateway } = fixture(t, [tool]);
  const literal = '$(not-a-command) ${NOT_AN_ENV_LOOKUP} `literal`';
  for (const name of ['bridge_read', 'bridge_invoke']) {
    const result = await callGateway(gateway, name, input(tool.tool.name, { value: literal }), 'owner');
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(payload(result).status, 'succeeded');
    assert.equal(JSON.parse(result.content[1]!.type === 'text' ? result.content[1]!.text : '{}').value, literal);
  }
  assert.equal(payload(await callGateway(gateway, tool.tool.name, { value: 'direct' }, 'owner')).status, 'succeeded');
  assert.equal(payload(await callGateway(gateway, 'bridge_call', { tool: tool.tool.name, arguments: { value: 'legacy' } }, 'owner')).status, 'succeeded');
  assert.deepEqual(received, [literal, literal, 'direct', 'legacy']);
});

test('JSON gateways reject malformed and non-object JSON before submission', async t => {
  let executions = 0;
  const { gateway, jobs } = fixture(t, [definition('fixture_read', 'read', async () => { executions++; return textResult('unexpected'); })]);
  for (const name of ['bridge_read', 'bridge_invoke']) {
    for (const argumentsJson of ['{', '[]', 'null', '"text"', '7', 'true', '{"value":"ok"} trailing']) {
      const result = await callGateway(gateway, name, { tool: 'fixture_read', argumentsJson }, 'owner');
      assert.equal(result.isError, true);
      assert.match(payload(result).error, /objeto JSON/i);
    }
    const oversized = await callGateway(gateway, name, { tool: 'fixture_read', argumentsJson: JSON.stringify({ value: 'é'.repeat(530_000) }) }, 'owner');
    assert.equal(oversized.isError, true);
    assert.match(payload(oversized).error, /1 MiB/);
    const badSchema = await callGateway(gateway, name, input('fixture_read', { value: 3 }), 'owner');
    assert.equal(badSchema.isError, true);
    assert.match(payload(badSchema).error, /Argumentos inválidos/);
  }
  assert.equal(jobs.list().length, 0);
  assert.equal(executions, 0);
});

test('bridge_read rejects write and execute before preview while bridge_invoke retains approval', async t => {
  for (const risk of ['write', 'execute'] as const) {
    let previews = 0; let executions = 0;
    const tool = definition('fixture_effect', risk, async () => { executions++; return textResult('done'); });
    tool.preview = async () => { previews++; return { effect: risk }; };
    const { gateway, jobs } = fixture(t, [tool]);
    const denied = await callGateway(gateway, 'bridge_read', input(tool.tool.name), 'owner');
    assert.equal(denied.isError, true);
    assert.match(payload(denied).error, /somente.*leitura/i);
    assert.equal(previews, 0); assert.equal(executions, 0); assert.equal(jobs.list().length, 0);
    const allowed = payload(await callGateway(gateway, 'bridge_invoke', input(tool.tool.name, { value: 'approved request' }, risk), 'owner'));
    assert.equal(allowed.status, 'pending_approval'); assert.equal(allowed.risk, risk);
    assert.equal(previews, 1); assert.equal(executions, 0);
    jobs.approve(allowed.jobId);
    assert.equal(payload(await callGateway(gateway, 'bridge_job', { jobId: allowed.jobId, waitMs: 500 }, 'owner')).status, 'succeeded');
    assert.equal(executions, 1);
  }
});

test('bridge_read preserves all-mode review and gives the same pending job as its next call', async t => {
  let executions = 0;
  const { gateway, jobs } = fixture(t, [definition('fixture_read', 'read', async () => { executions++; return textResult('approved'); })], 'all');
  const result = payload(await callGateway(gateway, 'bridge_read', input('fixture_read'), 'owner'));
  assert.equal(result.status, 'pending_approval'); assert.equal(executions, 0);
  assert.deepEqual(result.nextCall, { tool: 'bridge_job', arguments: { jobId: result.jobId, waitMs: 25000 } });
  assert.equal(result.continuation.deliveryDoesNotProveContinuation, true);
  jobs.approve(result.jobId);
  assert.equal(payload(await callGateway(gateway, 'bridge_job', { jobId: result.jobId, waitMs: 500 }, 'owner')).status, 'succeeded');
  assert.equal(executions, 1);
});

test('read-only submission checks the current risk inside the serialized submission queue', async t => {
  let release!: () => void; let previewStarted!: () => void;
  const started = new Promise<void>(resolve => { previewStarted = resolve; });
  const gate = definition('gate');
  gate.preview = async () => { previewStarted(); await new Promise<void>(resolve => { release = resolve; }); return {}; };
  let targetPreviews = 0; let targetExecutions = 0;
  const target = definition('target', 'read', async () => { targetExecutions++; return textResult('unexpected'); });
  target.preview = async () => { targetPreviews++; return {}; };
  const { gateway, jobs, state } = fixture(t, [gate, target], 'automatic');
  const first = jobs.submit('gate', { value: 'block submission' }, undefined, 'owner');
  await started;
  const pendingRead = callGateway(gateway, 'bridge_read', input('target'), 'owner');
  state.definitions = [gate, { ...target, risk: 'execute', fingerprint: 'changed' }];
  release(); await first;
  const result = await pendingRead;
  assert.equal(result.isError, true); assert.match(payload(result).error, /somente.*leitura/i);
  assert.equal(targetPreviews, 0); assert.equal(targetExecutions, 0);
  assert.equal(jobs.list().some(job => job.tool === 'target'), false);
});

test('read-only submission rechecks a definition changed during its asynchronous preview', async t => {
  let release!: () => void; let previewStarted!: () => void; let executions = 0;
  const started = new Promise<void>(resolve => { previewStarted = resolve; });
  const tool = definition('target', 'read', async () => { executions++; return textResult('unexpected'); });
  tool.preview = async () => { previewStarted(); await new Promise<void>(resolve => { release = resolve; }); return {}; };
  const { gateway, jobs, state } = fixture(t, [tool], 'automatic');
  const pending = callGateway(gateway, 'bridge_read', input('target'), 'owner');
  await Promise.race([started, pending.then(result => { assert.equal(result.isError, false, 'The read-only gateway must reach the read preview.'); })]);
  state.definitions = [{ ...tool, risk: 'write', fingerprint: 'changed' }];
  release();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(payload(result).error, /somente.*leitura|alterad|mudou/i);
  assert.equal(executions, 0); assert.equal(jobs.list().length, 0);
});

test('a read-only job cannot execute a changed definition after waiting in the execution queue', async t => {
  const release: Array<() => void> = [];
  const blocker = definition('blocker', 'read', async (_args, { signal }) => {
    await new Promise<void>((resolve, reject) => { release.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return textResult('released');
  });
  let executions = 0;
  const target = definition('target', 'read', async () => { executions++; return textResult('unexpected'); });
  const { jobs, state } = fixture(t, [blocker, target], 'automatic');
  for (let i = 0; i < 4; i++) await jobs.submit('blocker', { value: String(i) }, undefined, 'owner');
  const queued = await jobs.submit('target', { value: 'queued' }, undefined, 'owner', { readOnly: true });
  assert.equal(queued.status, 'queued');
  state.definitions = [blocker, { ...target, risk: 'execute', fingerprint: 'changed' }];
  release[0]!();
  assert.equal((await settled(jobs, queued.id)).status, 'failed');
  assert.equal(executions, 0);
});

test('read-only idempotency cannot recover a mutating job after its current descriptor becomes read-only', async t => {
  let executions = 0;
  const tool = definition('target', 'execute', async () => { executions++; return textResult('effect applied'); });
  const { gateway, jobs, state } = fixture(t, [tool], 'automatic');
  const original = payload(await callGateway(gateway, 'bridge_invoke', input('target', { value: 'one effect' }, 'same-key'), 'owner'));
  assert.equal(original.status, 'succeeded');
  state.definitions = [{ ...tool, risk: 'read', fingerprint: 'changed' }];
  const recovered = await callGateway(gateway, 'bridge_read', input('target', { value: 'one effect' }, 'same-key'), 'owner');
  assert.equal(recovered.isError, true); assert.match(payload(recovered).error, /somente.*leitura/i);
  await assert.rejects(jobs.submit('target', { value: 'one effect' }, 'same-key', 'owner', { readOnly: true }), /somente.*leitura/i);
  assert.equal(executions, 1); assert.equal(jobs.list().length, 1);
});

test('JSON gateways share idempotency per owner and preserve pause and schema validation', async t => {
  let executions = 0;
  const { gateway, jobs } = fixture(t, [definition('target', 'read', async args => { executions++; return textResult(args); })], 'automatic');
  const args = input('target', { value: 'once per owner' }, 'same-key');
  const original = payload(await callGateway(gateway, 'bridge_read', args, 'owner'));
  const replay = payload(await callGateway(gateway, 'bridge_invoke', args, 'owner'));
  assert.equal(original.status, 'succeeded'); assert.equal(replay.jobId, original.jobId); assert.equal(executions, 1);
  const other = payload(await callGateway(gateway, 'bridge_invoke', args, 'other'));
  assert.notEqual(other.jobId, original.jobId); assert.equal(executions, 2);
  assert.equal((await callGateway(gateway, 'bridge_job', { jobId: original.jobId }, 'other')).isError, true);
  const conflict = await callGateway(gateway, 'bridge_read', input('target', { value: 'different' }, 'same-key'), 'owner');
  assert.equal(conflict.isError, true); assert.match(payload(conflict).error, /outros argumentos/);
  jobs.setPaused(true);
  const paused = await callGateway(gateway, 'bridge_invoke', input('target', { value: 'new work' }, 'new-key'), 'owner');
  assert.equal(paused.isError, true); assert.match(payload(paused).error, /pausad/i); assert.equal(executions, 2);
});

test('compact exposure stays fixed while dynamic discovery and JSON invocation see newly connected tools', async t => {
  const { gateway, state } = fixture(t, [definition()], 'automatic');
  const service = await watchers(t);
  const bridge = { ...gateway, watchers: service };
  const compact = publicTools(bridge, true, 'compact');
  assert.equal(compact.length, 12);
  assert.equal(compact.some(tool => tool.name === 'fixture_read'), false);
  for (const name of ['bridge_tool_schema', 'bridge_read', 'bridge_invoke']) assert.ok(compact.some(tool => tool.name === name));
  assert.ok(compact.every(tool => (tool._meta?.securitySchemes as unknown[])?.length === 1));
  assert.equal(compact.find(tool => tool.name === 'bridge_read')?.annotations?.readOnlyHint, true);
  assert.deepEqual(compact.find(tool => tool.name === 'bridge_invoke')?.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false });
  const added = definition('new_upstream_tool', 'execute');
  state.definitions.push(added);
  assert.deepEqual(publicTools(bridge, true, 'compact'), compact);
  const full = publicTools(bridge);
  assert.ok(full.some(tool => tool.name === added.tool.name));
  assert.equal(full.length, compact.length + state.definitions.length);
  const discovered = payload(await callGateway(bridge, 'bridge_list_tools', { source: 'mcp:fixture', search: 'NEW_UPSTREAM', includeSchemas: false }, 'owner'));
  assert.equal(discovered.total, 1); assert.equal(discovered.tools[0].name, added.tool.name);
  assert.equal(Object.hasOwn(discovered.tools[0], 'inputSchema'), false);
  assert.equal(payload(await callGateway(bridge, 'bridge_invoke', input(added.tool.name), 'owner')).status, 'succeeded');
});

test('tool schema resolves one exact leaf with original schema and a recipe that supplies no invented values', async t => {
  const tool = definition('exact_target');
  tool.tool.inputSchema = { type: 'object', properties: { nested: { $ref: '#/$defs/nested' } }, required: ['nested'], $defs: { nested: { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'], additionalProperties: false } }, additionalProperties: false };
  const { gateway } = fixture(t, [tool]);
  const descriptor = payload(await callGateway(gateway, 'bridge_tool_schema', { tool: tool.tool.name }, 'owner'));
  assert.equal(descriptor.name, tool.tool.name); assert.equal(descriptor.risk, 'read'); assert.equal(descriptor.source, tool.source);
  assert.deepEqual(descriptor.inputSchema, tool.tool.inputSchema);
  assert.equal(descriptor.invocation.tool, 'bridge_read'); assert.equal(descriptor.invocation.target, tool.tool.name);
  assert.equal(descriptor.invocation.argumentsJson.type, 'string'); assert.equal(descriptor.invocation.argumentsJson.required, true);
  assert.equal(descriptor.invocation.arguments, undefined);
  const normal = payload(await callGateway(gateway, 'bridge_list_tools', {}, 'owner'));
  assert.deepEqual(normal.tools[0].inputSchema, tool.tool.inputSchema);
  const summary = payload(await callGateway(gateway, 'bridge_list_tools', { includeSchemas: false }, 'owner'));
  assert.equal(Object.hasOwn(summary.tools[0], 'inputSchema'), false);
  assert.equal((await callGateway(gateway, 'bridge_list_tools', { includeSchemas: 'false' }, 'owner')).isError, true);
});

test('summary discovery bounds long descriptions without truncating full descriptors or schemas', async t => {
  const tool = definition('verbose');
  tool.tool.description = 'a'.repeat(900);
  const { gateway } = fixture(t, [tool]);
  const summaryResult = await callGateway(gateway, 'bridge_list_tools', { includeSchemas: false }, 'owner');
  assert.notEqual(summaryResult.isError, true, JSON.stringify(summaryResult));
  const summary = payload(summaryResult).tools[0];
  assert.equal(summary.description.length, 500); assert.equal(summary.descriptionTruncated, true);
  const full = payload(await callGateway(gateway, 'bridge_list_tools', {}, 'owner')).tools[0];
  assert.equal(full.description, tool.tool.description); assert.deepEqual(full.inputSchema, tool.tool.inputSchema);
  const exact = payload(await callGateway(gateway, 'bridge_tool_schema', { tool: tool.tool.name }, 'owner'));
  assert.equal(exact.description, tool.tool.description); assert.deepEqual(exact.inputSchema, tool.tool.inputSchema);
});

test('schema and JSON gateways reject unknown names and gateway recursion without submitting jobs', async t => {
  const { gateway, jobs } = fixture(t);
  for (const target of ['missing', 'fixture', 'bridge_call', 'bridge_read', 'bridge_invoke', 'bridge_tool_schema', 'bridge_status']) {
    const schema = await callGateway(gateway, 'bridge_tool_schema', { tool: target }, 'owner');
    assert.equal(schema.isError, true); assert.match(payload(schema).error, /indisponível|desconhecida/i);
    for (const name of ['bridge_read', 'bridge_invoke']) {
      const result = await callGateway(gateway, name, input(target), 'owner');
      assert.equal(result.isError, true); assert.match(payload(result).error, /indisponível|desconhecida/i);
    }
  }
  assert.equal(jobs.list().length, 0);
});

test('watcher read controls bypass the job queue with owner checks and cancellation remains a mutation', async t => {
  const { gateway, jobs } = fixture(t);
  const service = await watchers(t);
  const bridge = { ...gateway, watchers: service };
  const created = await service.create('owner', { name: 'Read control', trigger: { type: 'signal', source: 'test', runId: 'dot-run' } });
  const schema = payload(await callGateway(bridge, 'bridge_tool_schema', { tool: 'bridge_watch_get' }, 'owner'));
  assert.deepEqual(schema.inputSchema, watcherControlTools.find(tool => tool.name === 'bridge_watch_get')!.inputSchema);
  assert.equal(schema.invocation.tool, 'bridge_read');
  const getArgs = input('bridge_watch_get', { watcherId: created.watcherId });
  assert.equal(payload(await callGateway(bridge, 'bridge_read', getArgs, 'owner')).watcherId, created.watcherId);
  assert.equal((await callGateway(bridge, 'bridge_read', getArgs, 'other')).isError, true);
  const cancelArgs = input('bridge_watch_cancel', { watcherId: created.watcherId });
  assert.equal((await callGateway(bridge, 'bridge_read', cancelArgs, 'owner')).isError, true);
  assert.equal((await service.get('owner', created.watcherId)).status, 'waiting');
  assert.equal(payload(await callGateway(bridge, 'bridge_invoke', cancelArgs, 'owner')).status, 'cancelled');
  assert.equal(jobs.list().length, 0);
});

test('JSON invocation preserves multimodal blocks, structuredContent and metadata in immediate and recovered results', async t => {
  const upstream: CallToolResult = {
    content: [
      { type: 'text', text: 'original text' },
      { type: 'image', mimeType: 'image/png', data: 'AQ==' },
      { type: 'audio', mimeType: 'audio/wav', data: 'Ag==' },
      { type: 'resource', resource: { uri: 'fixture://document', mimeType: 'text/plain', text: 'embedded' } },
      { type: 'resource_link', uri: 'https://example.com/result', name: 'result', mimeType: 'text/plain' },
    ],
    structuredContent: { answer: 42 }, _meta: { original: 'metadata' },
  };
  const { gateway } = fixture(t, [definition('media', 'read', async () => upstream)]);
  const result = await callGateway(gateway, 'bridge_read', input('media'), 'owner');
  assert.equal(payload(result).status, 'succeeded');
  assert.deepEqual(result.content.slice(1), upstream.content); assert.deepEqual(result.structuredContent, upstream.structuredContent); assert.deepEqual(result._meta, upstream._meta);
  const recovered = await callGateway(gateway, 'bridge_job', { jobId: payload(result).jobId }, 'owner');
  assert.deepEqual(recovered.content.slice(1), upstream.content); assert.deepEqual(recovered.structuredContent, upstream.structuredContent); assert.deepEqual(recovered._meta, upstream._meta);
});

test('cancelled JSON jobs retain their terminal state and cannot execute after cancellation', async t => {
  let executions = 0;
  const { gateway, jobs } = fixture(t, [definition('write', 'write', async () => { executions++; return textResult('unexpected'); })]);
  const pending = payload(await callGateway(gateway, 'bridge_invoke', input('write', { value: 'cancel me' }, 'cancel-once'), 'owner'));
  assert.equal(pending.status, 'pending_approval');
  assert.equal((await callGateway(gateway, 'bridge_cancel', { jobId: pending.jobId }, 'other')).isError, true);
  const cancelled = await callGateway(gateway, 'bridge_cancel', { jobId: pending.jobId }, 'owner');
  assert.equal(cancelled.isError, true); assert.equal(payload(cancelled).status, 'cancelled');
  const replay = payload(await callGateway(gateway, 'bridge_invoke', input('write', { value: 'cancel me' }, 'cancel-once'), 'owner'));
  assert.equal(replay.jobId, pending.jobId); assert.equal(replay.status, 'cancelled');
  assert.equal(jobs.list().length, 1); assert.equal(executions, 0);
});
