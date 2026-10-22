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

function state(result: CallToolResult) {
  assert.equal(result.isError, false);
  const first = result.content[0];
  assert.equal(first?.type, 'text');
  return JSON.parse(first!.type === 'text' ? first!.text : '{}');
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
