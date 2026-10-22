import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApplication } from '../src/app.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApiRequest } from '../src/clients/profiles.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-client-http-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'custom-state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  const apiHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  const state = () => fetch(runtime.adminUrl + '/admin/state', { headers: adminHeaders }).then(response => response.json()) as Promise<any>;
  return { root, runtime, clients, adminHeaders, apiHeaders, state };
}

test('admin client profiles track the configured origin, preserve local state and expose no credentials', async t => {
  const { runtime, adminHeaders, apiHeaders, state } = await fixture(t);
  const initial = await state();
  assert.ok(Array.isArray(initial.connection.clientProfiles), 'admin state must provide client-specific profiles');
  assert.equal(initial.connection.clientProfiles.length, 6);
  const local = initial.connection.clientProfiles.find((profile: any) => profile.id === 'gemini-cli-stdio');
  assert.equal(local.available, true);
  assert.ok(JSON.parse(local.content).mcpServers.ponte.args.includes(runtime.store.stateDir));
  assert.ok(initial.connection.apiTokenCommand.text.includes('token'));
  assert.ok(initial.connection.apiTokenCommand.text.includes(runtime.store.stateDir));
  assert.ok(initial.connection.clientProfiles.filter((profile: any) => profile.requiresPublicUrl).every((profile: any) => !profile.available));
  const publicUrl = 'https://ponte-client.example.com';
  const response = await fetch(runtime.adminUrl + '/admin/settings', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ publicUrl }) });
  assert.equal(response.status, 200, await response.clone().text());
  const configured = await state();
  assert.ok(configured.connection.clientProfiles.every((profile: any) => profile.available));
  const remote = configured.connection.clientProfiles.find((profile: any) => profile.id === 'gemini-cli-http');
  assert.equal(JSON.parse(remote.content).mcpServers.ponte.httpUrl, publicUrl + '/mcp');
  const serialized = JSON.stringify(configured.connection);
  assert.ok(!serialized.includes(runtime.store.secrets.apiToken));
  assert.ok(!serialized.includes(runtime.store.secrets.adminToken));
  assert.equal((await fetch(runtime.adminUrl + '/admin/state', { headers: apiHeaders })).status, 401);
  const publicState = await fetch(runtime.apiUrl + '/v1/status', { headers: apiHeaders }).then(result => result.json()) as any;
  assert.equal(publicState.connection, undefined, 'local installation profiles stay on the authenticated admin surface');
});

const plain = (result: any) => result.content.filter((part: any) => part.type === 'text').map((part: any) => JSON.parse(part.text));

for (const provider of ['gemini', 'grok'] as const) {
  test(`${provider} generated MCP credentials support approval, idempotence and native watcher recovery over real HTTP`, async t => {
    const { root, runtime, clients, adminHeaders } = await fixture(t);
    const publicUrl = `https://${provider}.bridge.example.com`;
    await runtime.store.update(config => ({ ...config, publicUrl, mcpToolExposure: 'compact' }));
    const request = buildApiRequest(provider, { model: 'test-model', prompt: 'Verifique a Ponte.', mcpUrl: publicUrl + '/mcp', mcpToken: runtime.store.secrets.apiToken, access: 'tools' });
    const descriptor = (request.body.tools as any[])[0];
    // This is a controlled local tunnel, not a call to a model provider. The
    // actual MCP transport uses exactly the URL and headers from the template.
    const localFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, publicUrl);
      return fetch(runtime.apiUrl + url.pathname + url.search, init);
    };
    const connect = async () => {
      const client = new Client({ name: `${provider}-profile-integration`, version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.url ?? descriptor.server_url), { requestInit: { headers: descriptor.headers }, fetch: localFetch }));
      return client;
    };
    let client = await connect();
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true);
      return plain(result);
    };
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [...descriptor.allowed_tools].sort());
    assert.equal((await call('bridge_status', {}))[0].directExecution.toolExposure, 'compact');
    const writeArgs = { tool: 'local_write_file', argumentsJson: JSON.stringify({ projectId: 'principal', path: 'client-result.txt', content: provider, expectedHash: null }), idempotencyKey: provider + '-write' };
    const [pending] = await call('bridge_invoke', writeArgs);
    assert.equal(pending.status, 'pending_approval');
    assert.equal((await fetch(runtime.adminUrl + `/admin/jobs/${pending.jobId}/approve`, { method: 'POST', headers: adminHeaders, body: '{}' })).status, 200);
    const [completed] = await call('bridge_job', { jobId: pending.jobId, waitMs: 2000 });
    assert.equal(completed.status, 'succeeded');
    assert.equal((await call('bridge_invoke', writeArgs))[0].jobId, pending.jobId);
    assert.equal(await readFile(path.join(root, 'project', 'client-result.txt'), 'utf8'), provider);
    await runtime.store.update(config => ({ ...config, approvalMode: 'automatic' }));

    for (const status of ['succeeded', 'failed', 'needs_input']) {
      const [, watcher] = await call('bridge_invoke', { tool: 'bridge_watch_create', argumentsJson: JSON.stringify({ name: `${provider} ${status}`, trigger: { type: 'signal', source: 'client-profile-test', runId: status }, idempotencyKey: `${provider}-${status}` }) });
      assert.equal(watcher.status, 'waiting');
      if (status === 'succeeded') {
        const abort = new AbortController();
        const interrupted = client.callTool({ name: 'bridge_watch_wait', arguments: { watcherId: watcher.watcherId, waitMs: 5000 } }, undefined, { signal: abort.signal });
        void interrupted.catch(() => {});
        for (let i = 0; i < 100 && runtime.watchers.snapshot().activeWaiters !== 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(runtime.watchers.snapshot().activeWaiters, 1);
        abort.abort();
        await assert.rejects(interrupted);
        await client.close();
        client = await connect();
        const [recovered] = await call('bridge_watch_get', { watcherId: watcher.watcherId });
        assert.equal(recovered.status, 'waiting');
        assert.equal(recovered.watcherId, watcher.watcherId);
        for (let i = 0; i < 100 && runtime.watchers.snapshot().activeWaiters; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(runtime.watchers.snapshot().activeWaiters, 0);
      }
      const waiting = call('bridge_watch_wait', { watcherId: watcher.watcherId, waitMs: 2000 });
      const signal = await localFetch(watcher.callback.url, { method: 'POST', headers: { Authorization: 'Bearer ' + watcher.callback.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: randomUUID(), runId: status, status, summary: `${provider}: ${status} confirmado pelo executor.` }) });
      assert.equal(signal.status, 200);
      const [terminal] = await waiting;
      assert.equal(terminal.status, status);
      assert.equal(terminal.monitorDurable, true);
      assert.equal(terminal.canWakeClosedConversation, false);
      assert.equal(terminal.watcherId, watcher.watcherId);
    }
    const invalid = await fetch(runtime.apiUrl + '/mcp', { method: 'POST', headers: { ...adminHeaders, Accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(invalid.status, 401, 'admin credentials are never an MCP credential');
  });
}
