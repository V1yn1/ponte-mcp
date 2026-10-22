import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApplication } from '../src/app.js';

function values(result: any): any[] {
  return result.content.filter((item: any) => item.type === 'text').map((item: any) => {
    try { return JSON.parse(item.text); } catch { return item.text; }
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-dot-http-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  const client = new Client({ name: 'compact-mcp-contract-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  const apiHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.apiUrl + '/mcp'), { requestInit: { headers: apiHeaders } }));
  const settings = (body: unknown) => fetch(runtime.adminUrl + '/admin/settings', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify(body) });
  const modern = (method: string, params: Record<string, unknown> = {}) => fetch(runtime.apiUrl + '/mcp', {
    method: 'POST',
    headers: { ...apiHeaders, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'compact-test', method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
  }).then(response => response.json()) as Promise<any>;
  return { root, runtime, client, settings, adminHeaders, apiHeaders, modern };
}

test('compact profile is an authenticated discovery preference, not an execution or permission boundary', async t => {
  const { runtime, client, settings, apiHeaders, modern } = await fixture(t);
  const initial = await client.listTools();
  assert.ok(initial.tools.some(tool => tool.name === 'local_projects'));
  const policy = runtime.store.config.approvalMode;
  const projects = runtime.store.config.projects;
  const response = await settings({ mcpToolExposure: 'compact' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as any).mcpToolExposure, 'compact');
  assert.equal(runtime.store.config.approvalMode, policy);
  assert.deepEqual(runtime.store.config.projects, projects);
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 12);
  assert.ok(catalog.tools.some(tool => tool.name === 'bridge_read'));
  assert.ok(catalog.tools.some(tool => tool.name === 'bridge_invoke'));
  assert.ok(!catalog.tools.some(tool => tool.name === 'local_projects'));
  const proxy = await fetch(runtime.apiUrl + '/v1/mcp/tools', { headers: apiHeaders }).then(response => response.json()) as any;
  assert.deepEqual(proxy.tools.map((tool: any) => tool.name), catalog.tools.map(tool => tool.name));
  assert.equal((await modern('tools/list')).result.tools.length, 12);
  for (const invoke of [
    () => client.callTool({ name: 'local_projects', arguments: {} }),
    async () => (await modern('tools/call', { name: 'local_projects', arguments: {} })).result,
  ]) assert.equal(values(await invoke())[0].status, 'succeeded', 'previously discovered names remain valid');
  const status = values(await client.callTool({ name: 'bridge_status', arguments: {} }))[0];
  assert.equal(status.directExecution.executionLocation, 'ponte_host');
  assert.equal(status.directExecution.requiresWorkSession, false);
  assert.equal(status.directExecution.requiresCodexSession, false);
  assert.equal(status.directExecution.clientToolAvailability, 'not_observable_by_server');
  assert.equal(status.directExecution.toolExposure, 'compact');
  assert.equal(status.watchers.canWakeClosedConversation, false);
  assert.equal((await settings({ mcpToolExposure: 'all-access' })).status, 400);
  assert.equal((await fetch(runtime.adminUrl + '/admin/settings', { method: 'PATCH', headers: apiHeaders, body: JSON.stringify({ mcpToolExposure: 'full' }) })).status, 401);
  assert.equal(runtime.store.config.mcpToolExposure, 'compact');
});

test('JSON gateways complete an approved file operation directly and preserve the same job on retry', async t => {
  const { root, runtime, client, settings, adminHeaders } = await fixture(t);
  assert.equal((await settings({ mcpToolExposure: 'compact' })).status, 200);
  const catalog = values(await client.callTool({ name: 'bridge_list_tools', arguments: { source: 'local', includeSchemas: false } }))[0];
  assert.ok(catalog.tools.some((tool: any) => tool.name === 'local_write_file'));
  assert.ok(catalog.tools.every((tool: any) => tool.inputSchema === undefined));
  const descriptor = values(await client.callTool({ name: 'bridge_tool_schema', arguments: { tool: 'local_write_file' } }))[0];
  assert.equal(descriptor.inputSchema.type, 'object');
  assert.equal(descriptor.invocation.tool, 'bridge_invoke');
  const input = { tool: 'local_write_file', argumentsJson: JSON.stringify({ projectId: 'principal', path: 'dot-direct.txt', expectedHash: null, content: 'Conteúdo literal: $(echo unsafe) `echo unsafe` ${TOKEN}\n' }), idempotencyKey: 'dot-file-one' };
  const rejected = await client.callTool({ name: 'bridge_read', arguments: input });
  assert.equal(rejected.isError, true);
  assert.equal(runtime.jobs.list().length, 0);
  const submitted = values(await client.callTool({ name: 'bridge_invoke', arguments: input }))[0];
  assert.equal(submitted.status, 'pending_approval');
  assert.deepEqual(submitted.nextCall, { tool: 'bridge_job', arguments: { jobId: submitted.jobId, waitMs: 25000 } });
  assert.equal(values(await client.callTool({ name: 'bridge_invoke', arguments: input }))[0].jobId, submitted.jobId);
  assert.equal((await fetch(runtime.adminUrl + '/admin/jobs/' + submitted.jobId + '/approve', { method: 'POST', headers: adminHeaders, body: '{}' })).status, 200);
  const complete = values(await client.callTool({ name: 'bridge_job', arguments: { jobId: submitted.jobId, waitMs: 25000 } }))[0];
  assert.equal(complete.status, 'succeeded');
  assert.equal(await readFile(path.join(root, 'project', 'dot-direct.txt'), 'utf8'), JSON.parse(input.argumentsJson).content);
  const read = await client.callTool({ name: 'bridge_read', arguments: { tool: 'local_read_file', argumentsJson: JSON.stringify({ projectId: 'principal', path: 'dot-direct.txt' }) } });
  assert.equal(values(read)[0].status, 'succeeded');
  assert.ok(values(read).some(value => value?.content === JSON.parse(input.argumentsJson).content));
  assert.equal(values(await client.callTool({ name: 'bridge_invoke', arguments: input }))[0].jobId, submitted.jobId);
  assert.equal(runtime.jobs.list().filter(job => job.tool === 'local_write_file').length, 1);
});

test('a compact MCP client uses a newly registered upstream and receives native images without refreshing tools/list', async t => {
  const { runtime, client, settings, modern } = await fixture(t);
  await settings({ mcpToolExposure: 'compact', approvalMode: 'automatic' });
  const initial = await client.listTools();
  const registration = {
    server: { id: 'dotfixture', name: 'Dot contract fixture', transport: 'stdio', command: process.execPath,
      args: ['--import', fileURLToPath(new URL('./fixtures/stdio-streams.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/upstream.mjs', import.meta.url)), JSON.stringify({ names: ['echo', 'image', 'failure', 'structured'], label: 'direct-mcp' })], timeoutMs: 5000 },
    reason: 'Validar o uso direto de ferramentas MCP pelo catálogo compacto.', sourceUrl: 'https://example.com/controlled-test-fixture',
  };
  const registered = await client.callTool({ name: 'bridge_invoke', arguments: { tool: 'bridge_mcp_add', argumentsJson: JSON.stringify(registration), idempotencyKey: 'dot-add-fixture' } });
  assert.equal(values(registered)[0].status, 'succeeded', JSON.stringify(registered));
  assert.equal(runtime.hub.statuses()[0]?.status, 'connected');
  const dynamic = values(await client.callTool({ name: 'bridge_list_tools', arguments: { source: 'mcp:dotfixture', includeSchemas: false } }))[0];
  assert.equal(dynamic.total, 4);
  assert.ok(dynamic.tools.every((tool: any) => !initial.tools.some(item => item.name === tool.name)));
  assert.ok(dynamic.tools.every((tool: any) => tool.risk === 'execute'));
  const image = dynamic.tools.find((tool: any) => tool.name.includes('__image__'));
  const descriptor = values(await client.callTool({ name: 'bridge_tool_schema', arguments: { tool: image.name } }))[0];
  assert.equal(descriptor.inputSchema.type, 'object');
  assert.equal((await client.callTool({ name: 'bridge_read', arguments: { tool: image.name, argumentsJson: '{}' } })).isError, true);
  const result = await modern('tools/call', { name: 'bridge_invoke', arguments: { tool: image.name, argumentsJson: '{}', idempotencyKey: 'dot-image-one' } });
  assert.equal(values(result.result)[0].status, 'succeeded');
  assert.ok(result.result.content.some((item: any) => item.type === 'image' && item.mimeType === 'image/png' && item.data.length > 0));
  const jobId = values(result.result)[0].jobId;
  const recovered = await client.callTool({ name: 'bridge_job', arguments: { jobId } });
  assert.deepEqual(recovered.content, result.result.content);
  const failure = dynamic.tools.find((tool: any) => tool.name.includes('__failure__'));
  const failed = await client.callTool({ name: 'bridge_invoke', arguments: { tool: failure.name, argumentsJson: '{}' } });
  assert.equal(failed.isError, true);
  assert.equal(values(failed)[0].status, 'failed');
  const structured = dynamic.tools.find((tool: any) => tool.name.includes('__structured__'));
  const structuredResult = await client.callTool({ name: 'bridge_invoke', arguments: { tool: structured.name, argumentsJson: '{}' } });
  assert.deepEqual(structuredResult.structuredContent, { label: 'direct-mcp' });
});
