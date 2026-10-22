import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { handleModernMcp, type ModernMcpDependencies } from '../src/mcp/modern.js';

const protocolVersion = '2026-07-28';
const meta = () => ({
  'io.modelcontextprotocol/protocolVersion': protocolVersion,
  'io.modelcontextprotocol/clientCapabilities': {},
});
type MockRequest = { method: string; headers: Record<string, string | string[] | undefined>; body: any };
function request(method = 'server/discover', params: Record<string, unknown> = {}): MockRequest {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
    },
    body: { jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: meta() } },
  };
}
function fixture() {
  const calls: unknown[][] = [];
  const tool: Tool = {
    name: 'test_tool', inputSchema: { type: 'object', properties: {} },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['ponte:tools'] }] },
  };
  const deps: ModernMcpDependencies = {
    getTools: () => [tool],
    call: async (name, args) => {
      calls.push(['call', name, args]);
      return { content: [{ type: 'text', text: 'done' }, { type: 'image', data: 'AQ==', mimeType: 'image/png' }], _meta: { retained: true } };
    },
    events: {
      list: (principal, params) => { calls.push(['list', principal, params]); return { events: [] }; },
      subscribe: async (principal, params) => {
        calls.push(['subscribe', principal, params]);
        return { id: 'sub_test', refreshBefore: '2026-10-23T12:00:00Z', cursor: null, truncated: false };
      },
      unsubscribe: async (principal, params) => { calls.push(['unsubscribe', principal, params]); return {}; },
    },
    principal: 'oauth:grant_test', version: '0.4.0', instructions: 'Ponte instructions',
  };
  return { deps, calls, tool };
}
async function invoke(req: MockRequest, deps = fixture().deps) {
  let status = 200; let body: any; const headers: Record<string, string> = {};
  const res = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
    set(name: string | Record<string, string>, value?: string) {
      if (typeof name === 'string') headers[name.toLowerCase()] = value!;
      else for (const [key, item] of Object.entries(name)) headers[key.toLowerCase()] = item;
      return this;
    },
  };
  const handled = await handleModernMcp(req as unknown as Request, res as unknown as Response, deps);
  return { handled, status, body, headers };
}

test('modern dispatcher leaves legacy initialize, tools and notifications to the existing SDK', async () => {
  const { deps, calls } = fixture();
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]) {
    for (const headers of [{}, { 'mcp-protocol-version': '2025-11-25' }]) {
      const output = await invoke({ method: 'POST', headers, body }, deps);
      assert.equal(output.handled, false);
      assert.equal(output.body, undefined);
    }
  }
  assert.deepEqual(calls, []);
});

test('modern discovery advertises implemented capabilities, both eras and server identity without clientInfo', async () => {
  const { deps } = fixture();
  const output = await invoke(request(), deps);
  assert.equal(output.handled, true);
  assert.equal(output.status, 200);
  assert.equal(output.body.id, 7);
  assert.equal(output.body.result.resultType, 'complete');
  assert.ok(output.body.result.supportedVersions.includes(protocolVersion));
  assert.ok(output.body.result.supportedVersions.includes('2025-11-25'));
  assert.deepEqual(output.body.result.capabilities, { tools: {}, events: {} });
  assert.equal(output.body.result.instructions, deps.instructions);
  assert.deepEqual(output.body.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'ponte-mcp', version: deps.version });
});

test('modern tool listing paginates and preserves OAuth security metadata', async () => {
  const { deps, tool } = fixture();
  const tools = Array.from({ length: 101 }, (_, index) => ({ ...tool, name: `tool_${index}` }));
  deps.getTools = async () => tools;
  const first = await invoke(request('tools/list'), deps);
  assert.equal(first.body.result.tools.length, 100);
  assert.equal(first.body.result.nextCursor, '100');
  assert.deepEqual(first.body.result.tools[0]._meta, tool._meta);
  const last = await invoke(request('tools/list', { cursor: first.body.result.nextCursor }), deps);
  assert.deepEqual(last.body.result.tools.map((item: Tool) => item.name), ['tool_100']);
  assert.equal(last.body.result.nextCursor, undefined);
  for (const cursor of ['-1', 'NaN', '9007199254740992', '102', 5, null]) {
    assert.equal((await invoke(request('tools/list', { cursor }), deps)).body.error.code, -32602);
  }
});

test('modern tool calls pass only arguments, preserve images and tool error results, and execute once', async () => {
  const { deps, calls } = fixture();
  const output = await invoke(request('tools/call', { name: 'test_tool', arguments: { value: 3 } }), deps);
  assert.equal(output.status, 200);
  assert.equal(output.body.result.resultType, 'complete');
  assert.deepEqual(calls, [['call', 'test_tool', { value: 3 }]]);
  assert.equal(output.body.result.content[1].type, 'image');
  assert.equal(output.body.result._meta.retained, true);
  deps.call = async () => ({ content: [{ type: 'text', text: 'invalid value' }], isError: true });
  assert.equal((await invoke(request('tools/call', { name: 'test_tool' }), deps)).body.result.isError, true);
});

test('unknown tools and malformed tool call parameters cannot execute', async () => {
  const { deps, calls } = fixture();
  for (const params of [{ name: 'missing' }, { name: '' }, { name: 7 }, { name: 'test_tool', arguments: [] }, { name: 'test_tool', arguments: null }]) {
    const output = await invoke(request('tools/call', params), deps);
    assert.equal(output.status, 400);
    assert.equal(output.body.error.code, -32602);
  }
  assert.deepEqual(calls, []);
});

test('compact discovery keeps cached direct names callable against the complete current registry', async () => {
  const { deps, calls, tool } = fixture();
  deps.getTools = () => [];
  deps.getCallableTools = () => [tool];
  assert.deepEqual((await invoke(request('tools/list'), deps)).body.result.tools, []);
  const result = await invoke(request('tools/call', { name: tool.name, arguments: { value: 9 } }), deps);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [['call', tool.name, { value: 9 }]]);
  deps.getCallableTools = () => [];
  assert.equal((await invoke(request('tools/call', { name: tool.name }), deps)).status, 400);
  assert.equal(calls.length, 1, 'a removed tool must not execute from an old discovery snapshot');
});

test('required modern metadata is validated before execution', async () => {
  const { deps, calls } = fixture();
  for (const value of [undefined, null, [], {}, { ...meta(), 'io.modelcontextprotocol/protocolVersion': 7 }, { ...meta(), 'io.modelcontextprotocol/clientCapabilities': [] }, { ...meta(), 'io.modelcontextprotocol/clientInfo': { name: 'missing-version' } }, { ...meta(), 'io.modelcontextprotocol/logLevel': ['debug'] }]) {
    const req = request('tools/call', { name: 'test_tool' }); req.body.params._meta = value;
    const output = await invoke(req, deps);
    assert.equal(output.handled, true);
    assert.equal(output.status, 400);
    assert.equal(output.body.error.code, -32602);
  }
  assert.deepEqual(calls, []);
});

test('mandatory mirrored headers must match the modern body exactly', async () => {
  const { deps, calls } = fixture();
  for (const [header, value] of [
    ['mcp-protocol-version', undefined], ['mcp-protocol-version', '2025-11-25'],
    ['mcp-method', undefined], ['mcp-method', 'tools/list'], ['mcp-method', ['tools/call', 'tools/list']],
    ['mcp-name', undefined], ['mcp-name', 'other_tool'], ['mcp-name', ' test_tool '],
  ] as Array<[string, string | string[] | undefined]>) {
    const req = request('tools/call', { name: 'test_tool' }); req.headers[header] = value;
    const output = await invoke(req, deps);
    assert.equal(output.status, 400, header);
    assert.equal(output.body.error.code, -32020, header);
  }
  assert.deepEqual(calls, []);
});

test('unknown future protocol versions report supported versions instead of falling through to legacy', async () => {
  const req = request();
  req.headers['mcp-protocol-version'] = '2099-01-01';
  req.body.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01';
  const output = await invoke(req);
  assert.equal(output.handled, true);
  assert.equal(output.status, 400);
  assert.equal(output.body.error.code, -32022);
  assert.equal(output.body.error.data.requested, '2099-01-01');
  assert.ok(output.body.error.data.supported.includes(protocolVersion));
});

test('modern invalid JSON-RPC envelopes and notifications cannot call tools', async () => {
  const { deps, calls } = fixture();
  const valid = request('tools/call', { name: 'test_tool' });
  for (const body of [null, [], {}, { ...valid.body, jsonrpc: '1.0' }, { ...valid.body, id: null }, { ...valid.body, id: undefined }, { ...valid.body, id: {} }, { ...valid.body, id: 1.5 }, { ...valid.body, method: 7 }, { ...valid.body, params: [] }]) {
    const output = await invoke({ ...valid, body }, deps);
    assert.equal(output.status, 400);
    assert.ok([-32600, -32602].includes(output.body.error.code));
  }
  assert.deepEqual(calls, []);
});

test('modern dispatch validates HTTP media types and rejects unsupported RPCs', async () => {
  const badContent = request(); badContent.headers['content-type'] = 'text/plain';
  assert.equal((await invoke(badContent)).status, 415);
  const badCharset = request(); badCharset.headers['content-type'] = 'application/json; charset=iso-8859-1';
  assert.equal((await invoke(badCharset)).status, 415);
  for (const accept of [undefined, 'application/json', 'text/event-stream', 'application/json, text/event-stream;q=0']) {
    const req = request(); req.headers.accept = accept;
    assert.equal((await invoke(req)).status, 406);
  }
  for (const method of ['ping', 'initialize', 'resources/list', 'events/poll', 'unimplemented']) {
    const output = await invoke(request(method));
    assert.equal(output.status, 404);
    assert.equal(output.body.error.code, -32601);
  }
});

test('modern event methods pass authenticated principal and strip only transport metadata', async () => {
  const { deps, calls } = fixture();
  const params = { name: 'ponte.job.completed', arguments: { jobId: 'job_test' }, delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: 'secret' }, ttlMs: 30_000, cursor: null };
  const list = await invoke(request('events/list'), deps);
  const subscribe = await invoke(request('events/subscribe', params), deps);
  const unsubscribeParams = { ...params, delivery: { mode: 'webhook', url: 'https://example.com/hook' } };
  const unsubscribe = await invoke(request('events/unsubscribe', unsubscribeParams), deps);
  for (const output of [list, subscribe, unsubscribe]) {
    assert.equal(output.status, 200);
    assert.equal(output.body.result.resultType, 'complete');
  }
  assert.equal(subscribe.body.result.id, 'sub_test');
  assert.deepEqual(calls, [['list', deps.principal, {}], ['subscribe', deps.principal, params], ['unsubscribe', deps.principal, unsubscribeParams]]);
});

test('event protocol errors retain their code and categorized data; unexpected errors reveal no details', async () => {
  const { deps } = fixture();
  for (const code of [-32602, -32015, -32024, -32025, -32026]) {
    deps.events.subscribe = async () => { throw Object.assign(new Error('Callback verification failed'), { code, data: { reason: 'challenge_failed' } }); };
    const output = await invoke(request('events/subscribe'), deps);
    assert.equal(output.body.error.code, code);
    assert.deepEqual(output.body.error.data, { reason: 'challenge_failed' });
  }
  deps.events.subscribe = async () => { throw new Error('private-signing-secret'); };
  const output = await invoke(request('events/subscribe'), deps);
  assert.equal(output.status, 500);
  assert.equal(output.body.error.code, -32603);
  assert.ok(!JSON.stringify(output.body).includes('private-signing-secret'));
});

test('Mcp-Name accepts valid base64 sentinels and rejects malformed encodings', async () => {
  const { deps, calls, tool } = fixture();
  for (const name of ['ferramenta_ação', '=?base64?literal?=']) {
    deps.getTools = () => [{ ...tool, name }];
    const req = request('tools/call', { name });
    req.headers['mcp-name'] = `=?base64?${Buffer.from(name).toString('base64')}?=`;
    assert.equal((await invoke(req, deps)).status, 200);
  }
  assert.equal(calls.length, 2);
  for (const encoded of ['=?base64?%%%?=', '=?base64?/w==?=', '=?base64?dGVzdF90b29s?=junk']) {
    const req = request('tools/call', { name: 'test_tool' }); req.headers['mcp-name'] = encoded;
    const output = await invoke(req, deps);
    assert.equal(output.status, 400);
    assert.equal(output.body.error.code, -32020);
  }
  assert.equal(calls.length, 2);
});

test('schema-declared Mcp-Param headers are validated at their exact property paths', async () => {
  const { deps, tool, calls } = fixture();
  tool.inputSchema = { type: 'object', properties: {
    target: { type: 'object', properties: { zone: { type: 'string', 'x-mcp-header': 'Zone' } } },
    count: { type: 'integer', 'x-mcp-header': 'Count' },
    enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' },
  } };
  const req = request('tools/call', { name: 'test_tool', arguments: { target: { zone: 'São Paulo' }, count: 42, enabled: false } });
  req.headers['mcp-param-zone'] = `=?base64?${Buffer.from('São Paulo').toString('base64')}?=`;
  req.headers['mcp-param-count'] = '42.0'; req.headers['mcp-param-enabled'] = 'false';
  assert.equal((await invoke(req, deps)).status, 200);
  for (const [key, value] of [['mcp-param-zone', undefined], ['mcp-param-count', '43'], ['mcp-param-enabled', 'False']]) {
    const output = await invoke({ ...req, headers: { ...req.headers, [key!]: value } }, deps);
    assert.equal(output.status, 400);
    assert.equal(output.body.error.code, -32020);
  }
  assert.equal(calls.length, 1);
  const omitted = request('tools/call', { name: 'test_tool', arguments: { target: { zone: null } } });
  assert.equal((await invoke(omitted, deps)).status, 200);
});

test('invalid custom-header annotations are excluded from the modern catalog and cannot execute', async () => {
  const { deps, tool, calls } = fixture();
  for (const schema of [
    { type: 'object', properties: { value: { type: 'number', 'x-mcp-header': 'Value' } } },
    { type: 'object', properties: { value: { type: ['string'], 'x-mcp-header': 'Value' } } },
    { type: 'object', properties: { value: { type: 'string', 'x-mcp-header': 'Bad\r\nHeader' } } },
    { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Value' }, b: { type: 'string', 'x-mcp-header': 'value' } } },
    { type: 'object', properties: { values: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } },
  ]) {
    tool.inputSchema = schema as Tool['inputSchema'];
    assert.deepEqual((await invoke(request('tools/list'), deps)).body.result.tools, []);
    assert.equal((await invoke(request('tools/call', { name: 'test_tool' }), deps)).body.error.code, -32602);
  }
  assert.deepEqual(calls, []);
});
