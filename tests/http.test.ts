import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApplication } from '../src/app.js';

test('HTTP settings accept clearing the public URL and reject malformed origins', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-settings-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const update = (publicUrl: unknown) => fetch(runtime.adminUrl + '/admin/settings', {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicUrl }),
  });
  for (const clear of ['', null]) {
    assert.equal((await update('https://ponte.example.com')).status, 200);
    assert.equal(runtime.store.config.publicUrl, 'https://ponte.example.com');
    assert.equal((await update(clear)).status, 200);
    assert.equal(runtime.store.config.publicUrl, undefined);
  }
  for (const invalid of ['invalid', 'http://ponte.example.com', 'https://ponte.example.com/path']) {
    assert.equal((await update(invalid)).status, 400);
    assert.equal(runtime.store.config.publicUrl, undefined);
  }
});

test('HTTP server form can explicitly clear its allowlist while preserving omitted credentials', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-server-form-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const save = (body: unknown) => fetch(runtime.adminUrl + '/admin/servers', {
    method: 'POST', headers: { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const server = () => runtime.store.config.upstreams.find(item => item.id === 'fixture')!;
  assert.equal((await save({ id: 'fixture', name: 'Fixture', transport: 'stdio', enabled: false, command: process.execPath, allowedTools: ['echo'], env: { FIXTURE: 'preserved' } })).status, 200);
  assert.deepEqual(server().allowedTools, ['echo']);
  assert.equal((await save({ id: 'fixture', allowedTools: [] })).status, 200);
  assert.deepEqual(server().allowedTools, []);
  assert.equal((await save({ id: 'fixture', allowedTools: null })).status, 200);
  assert.equal(server().allowedTools, undefined);
  assert.deepEqual(server().env, { FIXTURE: 'preserved' });
  assert.equal((await save({ id: 'fixture', allowedTools: 42 })).status, 400);
  assert.equal(server().allowedTools, undefined);
});

test('HTTP/MCP workflow enforces separate administration, review, and real file writes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-http-'));
  const runtime = await startApplication({ stateDir: path.join(root, '.ponte'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  const apiHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  assert.equal((await fetch(runtime.apiUrl + '/v1/tools')).status, 401);
  assert.equal((await fetch(runtime.adminUrl + '/admin/state', { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(runtime.apiUrl + '/v1/tools', { headers: adminHeaders })).status, 401);
  assert.equal((await fetch(runtime.adminUrl + '/admin/state', { headers: { ...adminHeaders, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(runtime.apiUrl + '/admin/state', { headers: apiHeaders })).status, 404);
  const response = await fetch(runtime.apiUrl + '/v1/jobs', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ tool: 'local_write_file', arguments: { projectId: 'principal', path: 'hello.txt', content: 'Ola Ponte', expectedHash: null }, idempotencyKey: 'http-test-1' }) });
  assert.equal(response.status, 202);
  const job = await response.json() as { id: string; status: string };
  assert.equal(job.status, 'pending_approval');
  await assert.rejects(readFile(path.join(root, 'project', 'hello.txt')));
  assert.equal((await fetch(runtime.apiUrl + '/v1/jobs/' + job.id + '/approve', { method: 'POST', headers: apiHeaders })).status, 404);
  const approval = await fetch(runtime.adminUrl + '/admin/jobs/' + job.id + '/approve', { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(approval.status, 200);
  for (let i = 0; i < 100; i++) {
    const state = runtime.jobs.get(job.id);
    if (state.status === 'succeeded') break;
    if (state.status === 'failed') assert.fail(state.error);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(path.join(root, 'project', 'hello.txt'), 'utf8'), 'Ola Ponte');
  const replay = await fetch(runtime.apiUrl + '/v1/jobs', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ tool: 'local_write_file', arguments: { projectId: 'principal', path: 'hello.txt', content: 'Ola Ponte', expectedHash: null }, idempotencyKey: 'http-test-1' }) });
  assert.equal((await replay.json() as { id: string }).id, job.id);

  const client = new Client({ name: 'ponte-integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.apiUrl + '/mcp'), { requestInit: { headers: { Authorization: apiHeaders.Authorization } } });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'local_read_file'));
  assert.ok(tools.tools.some(tool => tool.name === 'bridge_job'));
  assert.ok(!tools.tools.some(tool => /approve/i.test(tool.name)));
  const read = await client.callTool({ name: 'local_read_file', arguments: { projectId: 'principal', path: 'hello.txt' } });
  assert.ok(JSON.stringify(read).includes('Ola Ponte'));
  const schema = await fetch(runtime.apiUrl + '/openapi.json', { headers: apiHeaders }).then(res => res.json()) as { openapi: string; paths: Record<string, unknown> };
  assert.equal(schema.openapi, '3.1.0');
  assert.ok(schema.paths['/v1/jobs']);
  const stateText = await fetch(runtime.adminUrl + '/admin/state', { headers: adminHeaders }).then(res => res.text());
  assert.ok(!stateText.includes(runtime.store.secrets.apiToken));
  assert.ok(!stateText.includes(runtime.store.secrets.adminToken));
});
