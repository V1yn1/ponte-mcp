import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApplication } from '../src/app.js';

const fixture = fileURLToPath(new URL('./fixtures/upstream.mjs', import.meta.url));
const streams = fileURLToPath(new URL('./fixtures/stdio-streams.mjs', import.meta.url));
const registration = (id: string) => ({
  server: { id, name: 'MCP de teste', transport: 'stdio', command: process.execPath,
    args: ['--import', streams, fixture, JSON.stringify({ names: ['echo'], label: id })], timeoutMs: 5000 },
  reason: 'Disponibilizar a ferramenta de teste solicitada pelo usuário.',
  sourceUrl: 'https://example.com/mcp-fixture',
});
function texts(result: any): any[] {
  return result.content.filter((block: any) => block.type === 'text').map((block: any) => {
    try { return JSON.parse(block.text); } catch { return block.text; }
  });
}

test('an authenticated MCP chat registers after approval and uses new tools through its existing broker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-mcp-management-http-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  const client = new Client({ name: 'management-chat', version: '1.0.0' });
  t.after(async () => { await client.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.apiUrl + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + runtime.store.secrets.apiToken } },
  }));
  const initialCatalog = await client.listTools();
  for (const name of ['bridge_mcp_list', 'bridge_mcp_add', 'bridge_mcp_reconnect']) {
    assert.ok(initialCatalog.tools.some(tool => tool.name === name), name + ' must be discoverable');
  }
  const request = await client.callTool({ name: 'bridge_call', arguments: {
    tool: 'bridge_mcp_add', arguments: registration('fixture'), idempotencyKey: 'register-fixture',
  } });
  assert.equal(request.isError, false);
  const pending = texts(request)[0];
  assert.equal(pending.status, 'pending_approval');
  assert.equal(pending.risk, 'execute');
  assert.equal(runtime.store.config.upstreams.length, 0);
  assert.equal(runtime.hub.statuses().length, 0);
  const preview = runtime.jobs.get(pending.jobId).preview as any;
  assert.equal(preview.kind, 'mcp_add');
  assert.equal(preview.reason, registration('fixture').reason);
  assert.equal(preview.server.command, process.execPath);
  assert.equal((await fetch(runtime.adminUrl + '/admin/jobs/' + pending.jobId + '/approve', {
    method: 'POST', headers: adminHeaders, body: '{}',
  })).status, 200);
  const completed = await client.callTool({ name: 'bridge_job', arguments: { jobId: pending.jobId, waitMs: 25000 } });
  assert.equal(texts(completed)[0].status, 'succeeded', JSON.stringify(completed));
  const added = texts(completed).find(item => item?.registered === true);
  assert.equal(added.server.status, 'connected');
  assert.equal(added.server.toolCount, 1);
  assert.deepEqual(runtime.store.config.upstreams[0]!.readOnlyTools, []);

  // Keep the client's original tools/list. A fresh broker search must find the
  // server and expose its schema even when the host caches its initial catalog.
  const catalog = texts(await client.callTool({ name: 'bridge_list_tools', arguments: { source: 'mcp:fixture' } }))[0];
  assert.equal(catalog.total, 1);
  assert.equal(catalog.tools[0].source, 'mcp:fixture');
  assert.equal(catalog.tools[0].risk, 'execute', 'upstream readOnlyHint does not bypass review');
  assert.ok(!initialCatalog.tools.some(tool => tool.name === catalog.tools[0].name));
  const invocation = texts(await client.callTool({ name: 'bridge_call', arguments: {
    tool: catalog.tools[0].name, arguments: { text: 'catalogo-atualizado' }, idempotencyKey: 'invoke-new-tool',
  } }))[0];
  assert.equal(invocation.status, 'pending_approval');
  assert.equal((await fetch(runtime.adminUrl + '/admin/jobs/' + invocation.jobId + '/approve', {
    method: 'POST', headers: adminHeaders, body: '{}',
  })).status, 200);
  const answer = await client.callTool({ name: 'bridge_job', arguments: { jobId: invocation.jobId, waitMs: 25000 } });
  assert.equal(texts(answer)[0].status, 'succeeded');
  assert.ok(texts(answer).includes('fixture:catalogo-atualizado'));
  assert.equal(texts(await client.callTool({ name: 'bridge_list_tools', arguments: { source: 'mcp:absent' } }))[0].total, 0);
});

test('REST Actions register in automatic mode without gaining access to administration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-mcp-management-rest-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  const apiHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  assert.equal((await fetch(runtime.adminUrl + '/admin/settings', {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ approvalMode: 'automatic' }),
  })).status, 200);
  const input = { tool: 'bridge_mcp_add', argumentsJson: JSON.stringify(registration('automatic')), idempotencyKey: 'add-automatic' };
  const response = await fetch(runtime.apiUrl + '/v1/jobs', { method: 'POST', headers: apiHeaders, body: JSON.stringify(input) });
  assert.equal(response.status, 202, await response.clone().text());
  let job = await response.json() as any;
  for (let attempt = 0; attempt < 250 && ['queued', 'running'].includes(job.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    job = await fetch(runtime.apiUrl + '/v1/jobs/' + job.id, { headers: apiHeaders }).then(value => value.json());
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.equal(job.approval, 'automatic');
  assert.equal(texts(job.result)[0].server.status, 'connected');
  const replay = await fetch(runtime.apiUrl + '/v1/jobs', { method: 'POST', headers: apiHeaders, body: JSON.stringify(input) }).then(value => value.json()) as any;
  assert.equal(replay.id, job.id);
  assert.equal(runtime.store.config.upstreams.length, 1);
  assert.equal((await fetch(runtime.adminUrl + '/admin/state', { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(runtime.apiUrl + '/admin/servers', { method: 'POST', headers: apiHeaders, body: '{}' })).status, 404);
  const catalog = await fetch(runtime.apiUrl + '/v1/tools?source=mcp%3Aautomatic', { headers: apiHeaders }).then(value => value.json()) as any;
  assert.equal(catalog.tools.length, 1);
  assert.equal(catalog.tools[0].risk, 'execute');
});
