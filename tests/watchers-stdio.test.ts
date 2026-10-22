import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startApplication } from '../src/app.js';

test('real stdio proxy discovers, creates and waits for an authenticated external completion signal', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-watch-stdio-'));
  const stateDir = path.join(root, 'state');
  const runtime = await startApplication({ stateDir, workspace: path.join(root, 'project'), apiPort: 0, adminPort: 0 });
  const client = new Client({ name: 'native-watch-stdio-test', version: '1' });
  t.after(async () => { await client.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.store.update(config => ({ ...config, approvalMode: 'automatic', apiPort: Number(new URL(runtime.apiUrl).port) }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [
    '--import', 'tsx', '--import', fileURLToPath(new URL('./fixtures/stdio-streams.mjs', import.meta.url)),
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'stdio', '--state-dir', stateDir,
  ], cwd: fileURLToPath(new URL('../', import.meta.url)), stderr: 'ignore' }));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['bridge_watch_create', 'bridge_watch_get', 'bridge_watch_list', 'bridge_watch_wait', 'bridge_watch_cancel']) assert.ok(names.includes(name));
  const created = await client.callTool({ name: 'bridge_watch_create', arguments: { name: 'Claude via stdio', trigger: { type: 'signal', source: 'external-test', runId: 'stdio-run' }, idempotencyKey: 'stdio-run' } });
  assert.equal(created.isError, false);
  const watcher = JSON.parse((created.content as Array<{ type: string; text: string }>)[1]!.text);
  const waiting = client.callTool({ name: 'bridge_watch_wait', arguments: { watcherId: watcher.watcherId, waitMs: 10000 } });
  for (let i = 0; i < 100 && runtime.state().watchers.activeWaiters !== 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.state().watchers.activeWaiters, 1);
  const receipt = await fetch(watcher.callback.url, { method: 'POST', headers: { Authorization: 'Bearer ' + watcher.callback.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: randomUUID(), runId: 'stdio-run', status: 'succeeded', summary: 'Entrega externa concluída.' }) });
  assert.equal(receipt.status, 200);
  const completed = await waiting;
  const result = JSON.parse((completed.content as Array<{ type: string; text: string }>)[0]!.text);
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.summary, 'Entrega externa concluída.');
  assert.equal(runtime.state().watchers.activeWaiters, 0);
});
