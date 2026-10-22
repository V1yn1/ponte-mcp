import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConfigStore } from '../src/core/config.js';

async function proxy(t: TestContext): Promise<Client> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ponte-stdio-wait-'));
  const stateDir = path.join(directory, 'state');
  const client = new Client({ name: 'stdio-wait-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await ConfigStore.open(stateDir, { workspace: path.join(directory, 'project') });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', fileURLToPath(new URL('./fixtures/stdio-http.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'stdio', '--state-dir', stateDir],
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stderr: 'ignore',
  }));
  return client;
}

function data(result: CallToolResult) {
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  return JSON.parse(first!.type === 'text' ? first!.text : '{}');
}
function state(result: CallToolResult) { assert.equal(result.isError, false); return data(result); }
function recovery(result: CallToolResult, watcherId: string, reason: string) {
  assert.equal(result.isError, true);
  const value = data(result);
  assert.equal(value.watcherId, watcherId); assert.equal(value.status, undefined);
  assert.equal(value.recovery.reason, reason); assert.equal(value.recovery.defaultWaitMs, 25000); assert.equal(value.recovery.maxWaitMs, 45000);
  assert.equal(value.canWakeClosedConversation, false);
  assert.deepEqual(value.nextCall, { tool: 'bridge_watch_get', arguments: { watcherId } });
  assert.match(value.nextStep, /não (?:reenvie|crie)/i);
  assert.ok(!JSON.stringify(value).includes('fixture-sensitive'));
  return value;
}

test('stdio proxy preserves automatic results and job IDs through the full gateway wait', async t => {
  const client = await proxy(t);
  const completed = state(await client.callTool({ name: 'long_tool', arguments: { value: 'original' } }));
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.value, 'original');
  assert.match(completed.jobId, /^[a-f0-9-]{36}$/);
  const pending = state(await client.callTool({ name: 'bridge_job', arguments: { jobId: completed.jobId, waitMs: 25_000 } }));
  assert.deepEqual(pending, { jobId: completed.jobId, status: 'pending_approval' });
});

for (const name of ['fixture_timeout', 'fixture_body_timeout']) {
  test(`stdio proxy explains uncertain tool results after ${name} without replaying the operation`, async t => {
    const client = await proxy(t);
    await assert.rejects(client.callTool({ name, arguments: {} }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /tempo limite/i);
      assert.match(error.message, /pode (?:ter|continuar)|resultado.*incerto/i);
      assert.match(error.message, /painel|bridge_job/i);
      assert.match(error.message, /não reenvie|não repita/i);
      assert.doesNotMatch(error.message, /npm start/i);
      return true;
    });
    const counts = state(await client.callTool({ name: 'fixture_stats', arguments: {} }));
    assert.equal(counts[name], 1);
  });
}

test('stdio catalog requests retain the shorter connection deadline', async t => {
  const client = await proxy(t);
  await assert.rejects(client.listTools(), /ponte local|tempo limite/i);
});

test('stdio proxy budgets the 45-second server wait plus transport margin under a deterministic clock', async t => {
  const client = await proxy(t);
  const watcherId = '66267440-c208-4214-99cb-72ae188b7c5c';
  for (const request of [
    { name: 'bridge_watch_wait', arguments: { watcherId, waitMs: 45000 } },
    { name: 'bridge_call', arguments: { tool: 'bridge_watch_wait', arguments: { watcherId, waitMs: 45000 } } },
    { name: 'bridge_watch_wait', arguments: { watcherId } },
  ]) {
    const result = state(await client.callTool(request));
    assert.equal(result.watcherId, watcherId); assert.equal(result.status, 'waiting');
    assert.equal(result.monitorDurable, true); assert.equal(result.canWakeClosedConversation, false);
  }
  await assert.rejects(client.callTool({ name: 'fixture_timeout', arguments: {} }), /tempo limite/i);
});

test('stdio rejects stale 300-second requests before sending HTTP and recovers the same watcher', async t => {
  const client = await proxy(t);
  const watcherId = '66267440-c208-4214-99cb-72ae188b7c5c';
  for (const name of ['bridge_watch_wait', 'bridge_call']) {
    const args = { watcherId, waitMs: 300000 };
    recovery(await client.callTool({ name, arguments: name === 'bridge_call' ? { tool: 'bridge_watch_wait', arguments: args } : args }), watcherId, 'wait_limit_exceeded');
  }
  const counts = state(await client.callTool({ name: 'fixture_stats', arguments: {} }));
  assert.equal(counts.bridge_watch_wait ?? 0, 0); assert.equal(counts.bridge_call ?? 0, 0); assert.equal(counts.bridge_watch_create ?? 0, 0);
});

for (const [scenario, suffix, reason] of [
  ['deadline', '001', 'wait_interrupted'], ['before headers', '002', 'communication_error'],
  ['broken body', '003', 'communication_error'], ['invalid JSON', '004', 'communication_error'],
  ['invalid result shape', '005', 'communication_error'], ['HTTP 502', '006', 'communication_error'],
  ['HTTP 503', '007', 'communication_error'], ['HTTP 504', '008', 'communication_error'],
  ['body deadline', '012', 'wait_interrupted'],
]) {
  test(`stdio watcher recovery survives ${scenario} without resubmission`, async t => {
    const client = await proxy(t);
    const watcherId = '00000000-0000-4000-8000-000000000' + suffix;
    for (const name of ['bridge_watch_wait', 'bridge_call']) {
      const args = { watcherId, waitMs: 45000 };
      const response = recovery(await client.callTool({ name, arguments: name === 'bridge_call' ? { tool: 'bridge_watch_wait', arguments: args } : args }), watcherId, reason!);
      const recovered = state(await client.callTool({ name: response.nextCall.tool, arguments: response.nextCall.arguments }));
      assert.equal(recovered.watcherId, watcherId); assert.equal(recovered.status, 'succeeded');
    }
    const counts = state(await client.callTool({ name: 'fixture_stats', arguments: {} }));
    assert.equal(counts.bridge_watch_wait, 1); assert.equal(counts.bridge_call, 1); assert.equal(counts.bridge_watch_get, 2);
    assert.equal(counts.bridge_watch_create ?? 0, 0);
  });
}

for (const [status, suffix] of [[401, '009'], [403, '010'], [404, '011']] as const) {
  test(`stdio watcher HTTP ${status} remains an access error without an automatic recovery hint`, async t => {
    const client = await proxy(t);
    const watcherId = '00000000-0000-4000-8000-000000000' + suffix;
    await assert.rejects(client.callTool({ name: 'bridge_watch_wait', arguments: { watcherId, waitMs: 25000 } }), /indisponível|autoriz/i);
    const counts = state(await client.callTool({ name: 'fixture_stats', arguments: {} }));
    assert.equal(counts.bridge_watch_wait, 1); assert.equal(counts.bridge_watch_get ?? 0, 0); assert.equal(counts.bridge_watch_create ?? 0, 0);
  });
}
