import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpHub } from '../src/mcp/hub.js';
import type { ToolDefinition, UpstreamConfig } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/upstream.mjs', import.meta.url));
// Only the managed execution runtime substitutes the child's process streams.
// Probe using real fd output, then explicitly opt this fixture into its adapter.
const rawStdio = await new Promise<boolean>((resolve, reject) => {
  const probe = spawn(process.execPath, ['--input-type=module', '-e',
    'import {writeSync} from "node:fs";writeSync(1,String(process.stdin.constructor.name === "Readable" && process.stdout.constructor.name === "Writable"));'],
  { env: getDefaultEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
  let output = '';
  probe.stdout.on('data', chunk => { output += chunk.toString(); });
  probe.on('error', reject);
  probe.on('close', code => {
    if (code !== 0 || !['true', 'false'].includes(output)) reject(new Error('Unable to inspect test child streams'));
    else resolve(output === 'true');
  });
});
const context = () => ({ signal: new AbortController().signal });
const config = (id = 'test', options: Record<string, unknown> = {}, overrides: Partial<UpstreamConfig> = {}): UpstreamConfig => ({
  id, name: id, enabled: true, transport: 'stdio', command: process.execPath,
  args: [fixture, JSON.stringify(options)], timeoutMs: 5_000, ...overrides,
  env: { ...(rawStdio ? { PONTE_TEST_RAW_STDIO: '1' } : {}), ...overrides.env },
});
const find = (hub: McpHub, title: string, source?: string): ToolDefinition => {
  const found = hub.tools().find(definition => definition.tool.title === title && (!source || definition.source === source));
  assert.ok(found, `Expected the upstream tool ${title}`);
  return found;
};
const firstText = (value: Awaited<ReturnType<ToolDefinition['execute']>>) => {
  const block = value.content[0];
  assert.equal(block?.type, 'text');
  return block!.type === 'text' ? block!.text : '';
};
async function until(condition: () => boolean, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) assert.fail('Expected state was not reached before the deadline');
    await delay(15);
  }
}

test('MCP hub connects two real servers and routes duplicate tool names separately', async t => {
  const hub = new McpHub([config('one', { label: 'first' }), config('two', { label: 'second' })]);
  t.after(() => hub.close());
  await hub.connectAll();
  assert.deepEqual(hub.statuses().map(status => status.status), ['connected', 'connected']);
  assert.equal(hub.tools().length, 18);
  const first = find(hub, 'echo', 'mcp:one');
  const second = find(hub, 'echo', 'mcp:two');
  assert.notEqual(first.tool.name, second.tool.name);
  assert.match(first.tool.name, /^one__/);
  assert.equal(firstText(await first.execute({ text: 'hello' }, context())), 'first:hello');
  assert.equal(firstText(await second.execute({ text: 'hello' }, context())), 'second:hello');
});

test('MCP hub preserves image content, upstream errors and structured results', async t => {
  const hub = new McpHub([config()]);
  t.after(() => hub.close());
  await hub.connectAll();
  const result = await find(hub, 'image').execute({}, context());
  assert.equal(result.content.length, 2);
  assert.equal(result.content[1]?.type, 'image');
  if (result.content[1]?.type === 'image') {
    assert.equal(result.content[1].mimeType, 'image/png');
    assert.match(result.content[1].data, /^iVBOR/);
  }
  const failure = await find(hub, 'failure').execute({}, context());
  assert.equal(failure.isError, true);
  assert.match(firstText(failure), /refused/);
  const structured = find(hub, 'structured');
  assert.equal(structured.tool.outputSchema, undefined, 'The job wrapper must not promise upstream structured output');
  assert.deepEqual((await structured.execute({}, context())).structuredContent, { label: 'fixture' });
});

test('MCP hub enforces explicit exposure and read policy instead of upstream hints', async t => {
  const hub = new McpHub([
    config('allowed', {}, { allowedTools: ['echo', 'image'], readOnlyTools: ['echo'] }),
    config('empty', {}, { allowedTools: [] }),
    config('disabled', {}, { enabled: false, command: '/this/does/not/exist' }),
  ]);
  t.after(() => hub.close());
  await hub.connectAll();
  assert.equal(hub.tools().length, 2);
  assert.equal(find(hub, 'echo').risk, 'read');
  assert.equal(find(hub, 'image').risk, 'execute');
  assert.equal(find(hub, 'image').tool.annotations?.readOnlyHint, false);
  assert.equal(hub.statuses().find(status => status.id === 'disabled')?.status, 'disabled');
});

test('MCP hub names remain unique, safe and stable for ambiguous and long names', async t => {
  const names = ['same name', 'same?name', 'x'.repeat(120), 'b__c'];
  const hub = new McpHub([config('a', { names }), config('a__b', { names: ['c'] })]);
  t.after(() => hub.close());
  await hub.connectAll();
  const before = hub.tools().map(definition => definition.tool.name).sort();
  assert.equal(new Set(before).size, 5);
  for (const name of before) {
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
    assert.ok(name.length <= 64);
  }
  await hub.reconnect('a');
  assert.deepEqual(hub.tools().map(definition => definition.tool.name).sort(), before);
});

test('MCP hub rejects circular and oversized tool catalogs without partial exposure', async t => {
  const hub = new McpHub([config('cycle', { cycle: true }), config('huge', { count: 501, pageSize: 251 })]);
  t.after(() => hub.close());
  await assert.doesNotReject(() => hub.connectAll());
  assert.deepEqual(hub.statuses().map(status => status.status), ['error', 'error']);
  assert.equal(hub.tools().length, 0);
  assert.match(hub.statuses()[0]?.error ?? '', /pagina|cursor/i);
  assert.match(hub.statuses()[1]?.error ?? '', /500/);
});

test('MCP hub refreshes changed catalogs and invalidates prior schema fingerprints', async t => {
  const hub = new McpHub([config()]);
  t.after(() => hub.close());
  await hub.connectAll();
  const old = find(hub, 'echo');
  assert.ok(old.fingerprint);
  await find(hub, 'refresh').execute({}, context());
  await until(() => hub.tools().some(definition => definition.tool.title === 'echo' && definition.fingerprint !== old.fingerprint));
  const current = find(hub, 'echo');
  assert.equal(current.tool.name, old.tool.name);
  assert.notEqual(current.fingerprint, old.fingerprint);
  await assert.rejects(() => old.execute({}, context()), /alterad|atualiz|indispon/i);
});

test('MCP hub replaces configs atomically and rejects obsolete tool definitions', async t => {
  const initial = config('target', { label: 'old' });
  const hub = new McpHub([initial]);
  t.after(() => hub.close());
  await hub.connectAll();
  const old = find(hub, 'echo');
  await hub.replaceConfigs([config('target', { label: 'new' })]);
  const current = find(hub, 'echo');
  assert.notEqual(current.fingerprint, old.fingerprint);
  assert.equal(firstText(await current.execute({}, context())), 'new:echo');
  await assert.rejects(() => old.execute({}, context()), /alterad|atualiz|indispon/i);
  await hub.replaceConfigs([]);
  assert.equal(hub.tools().length, 0);
  assert.equal(hub.statuses().length, 0);
});

test('MCP hub expands explicit env references without inheriting unrelated secrets', async t => {
  const previous = process.env.PONTE_HUB_TEST_SECRET;
  process.env.PONTE_HUB_TEST_SECRET = 'fixture-private-value';
  t.after(() => { if (previous === undefined) delete process.env.PONTE_HUB_TEST_SECRET; else process.env.PONTE_HUB_TEST_SECRET = previous; });
  const hub = new McpHub([config('environment', {}, { env: { FIXTURE_SECRET: '${PONTE_HUB_TEST_SECRET}' } })]);
  t.after(() => hub.close());
  await hub.connectAll();
  const environment = JSON.parse(firstText(await find(hub, 'environment').execute({}, context())));
  assert.equal(environment.inherited, null);
  assert.equal(environment.configured, 'fixture-private-value');
  assert.equal(environment.hasPath, true);
  assert.ok(!JSON.stringify(hub.statuses()).includes('fixture-private-value'));
  if (process.platform === 'win32') {
    assert.equal(environment.localAppData, process.env.LOCALAPPDATA);
    assert.equal(environment.systemRoot, process.env.SystemRoot);
  }
});

test('MCP hub reports missing env and insecure HTTP configuration without crashing', async t => {
  const hub = new McpHub([
    config('missing', {}, { env: { FIXTURE_SECRET: '${PONTE_HUB_MISSING_794F0586}' } }),
    { id: 'remote', name: 'remote', enabled: true, transport: 'http', url: 'http://example.com/mcp' },
    { id: 'header', name: 'header', enabled: true, transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${PONTE_HUB_MISSING_794F0586}' } },
    config('invalid', {}, { command: '/missing/executable', env: { SECRET: 'do-not-leak' } }),
  ]);
  t.after(() => hub.close());
  await assert.doesNotReject(() => hub.connectAll());
  assert.ok(hub.statuses().every(status => status.status === 'error'));
  assert.equal(hub.tools().length, 0);
  const errors = hub.statuses().map(status => status.error).join(' ');
  assert.match(errors, /ambiente/);
  assert.match(errors, /HTTPS|loopback/);
  assert.ok(!errors.includes('do-not-leak'));
});

test('MCP hub bounds call timeouts and forwards cancellation to the upstream', async t => {
  const hub = new McpHub([config('timeout', {}, { timeoutMs: 1_200 })]);
  t.after(() => hub.close());
  await hub.connectAll();
  const slow = find(hub, 'slow');
  const start = Date.now();
  await assert.rejects(() => slow.execute({ ms: 10_000 }, context()), /tempo|limite/i);
  assert.ok(Date.now() - start < 4_000);
  const controller = new AbortController();
  const pending = slow.execute({ ms: 10_000 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(() => pending, /cancelad/i);
  await delay(40);
  const stats = JSON.parse(firstText(await find(hub, 'stats').execute({}, context())));
  assert.ok(stats.cancelled >= 2, 'Both the deadline and explicit abort must reach the upstream');
});

test('MCP hub never retries an interrupted mutation after disconnection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ponte-hub-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'calls.txt');
  const hub = new McpHub([config('disconnect', { callMarker: marker })]);
  t.after(() => hub.close());
  await hub.connectAll();
  await assert.rejects(() => find(hub, 'disconnect').execute({}, context()), /conex|interromp|indispon/i);
  await until(() => hub.statuses()[0]?.status === 'error');
  assert.equal(hub.tools().length, 0);
  assert.equal(await readFile(marker, 'utf8'), 'called\n');
});

test('MCP hub can close while connecting and exposes no stale tools afterwards', async () => {
  const hub = new McpHub([config('slow-start', { startupDelay: 1_000 })]);
  const connecting = hub.connectAll();
  await delay(20);
  await hub.close();
  await connecting;
  assert.equal(hub.tools().length, 0);
  assert.ok(hub.statuses().every(status => status.status !== 'connected'));
});

test('MCP hub forwards headers and calls through real HTTP and legacy SSE servers', async t => {
  const clients = new Set<Server>();
  const sessions = new Map<string, SSEServerTransport>();
  const seenHeaders: string[] = [];
  let hub: McpHub | undefined;
  const makeServer = (label: string) => {
    const server = new Server({ name: 'http-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', title: 'echo', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, request => ({ content: [{ type: 'text', text: `${label}:${request.params.arguments?.text}` }] }));
    clients.add(server);
    return server;
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    seenHeaders.push(request.headers.authorization ?? '');
    if (request.headers.authorization !== 'Bearer fixture-header-value') {
      response.writeHead(401).end('Missing fixture authentication');
      return;
    }
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname === '/mcp' && request.method === 'POST') {
      const server = makeServer('http');
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on('close', () => { clients.delete(server); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } else if (url.pathname === '/sse' && request.method === 'GET') {
      const server = makeServer('sse');
      const transport = new SSEServerTransport('/messages', response);
      sessions.set(transport.sessionId, transport);
      response.on('close', () => { sessions.delete(transport.sessionId); clients.delete(server); void server.close(); });
      await server.connect(transport);
    } else if (url.pathname === '/messages' && request.method === 'POST') {
      const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) response.writeHead(404).end();
      else await transport.handlePostMessage(request, response);
    } else response.writeHead(405).end();
  };
  const http = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) {
      t.skip('This sandbox cannot open loopback listeners; run with normal local process permissions.');
      return;
    }
    throw error;
  }
  t.after(async () => {
    await hub?.close();
    await Promise.allSettled([...clients].map(client => client.close()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const previous = process.env.PONTE_HUB_HEADER_TEST;
  process.env.PONTE_HUB_HEADER_TEST = 'fixture-header-value';
  t.after(() => { if (previous === undefined) delete process.env.PONTE_HUB_HEADER_TEST; else process.env.PONTE_HUB_HEADER_TEST = previous; });
  hub = new McpHub((['http', 'sse'] as const).map(transport => ({
    id: transport, name: transport, enabled: true, transport,
    url: `http://127.0.0.1:${address.port}/${transport === 'http' ? 'mcp' : 'sse'}`,
    headers: { Authorization: 'Bearer ${PONTE_HUB_HEADER_TEST}' }, timeoutMs: 3_000,
  })));
  await hub.connectAll();
  assert.deepEqual(hub.statuses().map(status => status.status), ['connected', 'connected'], JSON.stringify(hub.statuses()));
  assert.equal(firstText(await find(hub, 'echo', 'mcp:http').execute({ text: 'one' }, context())), 'http:one');
  assert.equal(firstText(await find(hub, 'echo', 'mcp:sse').execute({ text: 'two' }, context())), 'sse:two');
  assert.ok(seenHeaders.length >= 6);
  assert.ok(seenHeaders.every(header => header === 'Bearer fixture-header-value'));
  assert.ok(!JSON.stringify(hub.statuses()).includes('fixture-header-value'));
});
