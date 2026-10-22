import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFile } from 'node:fs/promises';
import { createReadStream, writeSync } from 'node:fs';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const options = JSON.parse(process.argv[2] ?? '{}');
const label = options.label ?? 'fixture';
let revision = 0;
let cancelled = 0;
const server = new Server({ name: 'ponte-test-upstream', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });

function toolList() {
  const names = options.names ?? (options.count
    ? Array.from({ length: options.count }, (_, index) => `tool_${index}`)
    : ['echo', 'image', 'failure', 'slow', 'disconnect', 'refresh', 'environment', 'stats', 'structured']);
  return names.map(name => ({
    name,
    title: name,
    description: `Fixture ${name}, revision ${revision}`,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, ms: { type: 'number' }, ...(revision ? { revision: { type: 'number' } } : {}) },
    },
    annotations: { readOnlyHint: true },
    ...(name === 'structured' ? { outputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } } : {}),
  }));
}

server.setRequestHandler(ListToolsRequestSchema, async request => {
  if (options.listDelay) await delay(options.listDelay);
  const tools = toolList();
  const start = Number(request.params?.cursor ?? 0);
  const pageSize = options.pageSize ?? 3;
  return {
    tools: tools.slice(start, start + pageSize),
    ...(options.cycle ? { nextCursor: '0' } : start + pageSize < tools.length ? { nextCursor: String(start + pageSize) } : {}),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  if (name === 'image') return { content: [
    { type: 'text', text: label },
    { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhMcAAAAASUVORK5CYII=', mimeType: 'image/png' },
  ] };
  if (name === 'failure') return { isError: true, content: [{ type: 'text', text: 'The fixture refused the operation.' }] };
  if (name === 'slow') {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, Number(args.ms ?? 5_000));
      extra.signal.addEventListener('abort', () => { cancelled += 1; clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  if (name === 'disconnect') {
    if (options.callMarker) await appendFile(options.callMarker, 'called\n');
    // Simulate an abrupt upstream crash, without waiting on a blocking fd read.
    process.kill(process.pid, 'SIGTERM');
    await new Promise(() => {});
  }
  if (name === 'refresh') {
    revision += 1;
    await server.notification({ method: 'notifications/tools/list_changed' });
  }
  if (name === 'environment') return { content: [{ type: 'text', text: JSON.stringify({
    inherited: process.env.PONTE_HUB_TEST_SECRET ?? null,
    configured: process.env.FIXTURE_SECRET ?? null,
    hasPath: Boolean(process.env.PATH),
    localAppData: process.env.LOCALAPPDATA ?? null,
    systemRoot: process.env.SystemRoot ?? null,
  }) }] };
  if (name === 'stats') return { content: [{ type: 'text', text: JSON.stringify({ cancelled }) }] };
  if (name === 'structured') return { content: [{ type: 'text', text: label }], structuredContent: { label } };
  return { content: [{ type: 'text', text: `${label}:${String(args.text ?? name)}` }] };
});

if (options.stderr) writeSync(2, options.stderr);
if (options.startupDelay) await delay(options.startupDelay);
// Opt in only when the test harness detected synthetic child-process streams.
// Native Node (including Windows) uses the SDK's normal stdin/stdout streams.
const rawStreams = process.env.PONTE_TEST_RAW_STDIO === '1';
const input = rawStreams ? createReadStream('', { fd: 0, autoClose: false }) : process.stdin;
const output = rawStreams ? new Writable({
  write(chunk, _encoding, callback) {
    try { writeSync(1, chunk); callback(); } catch (error) { callback(error); }
  },
}) : process.stdout;
input.on('end', () => { void server.close(); });
await server.connect(new StdioServerTransport(input, output));
