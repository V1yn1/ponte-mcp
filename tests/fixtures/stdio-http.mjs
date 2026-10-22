import { createReadStream, writeSync } from 'node:fs';
import { Writable } from 'node:stream';

// Only the managed execution runtime substitutes the child's process streams.
// Keep the production CLI and its MCP transport intact, adapting the fixture's
// descriptors when that runtime is present.
if (process.stdin.constructor.name === 'Readable' && process.stdout.constructor.name === 'Writable') {
  Object.defineProperty(process, 'stdin', { value: createReadStream('', { fd: 0, autoClose: false }) });
  Object.defineProperty(process, 'stdout', { value: new Writable({
    write(chunk, _encoding, callback) {
      try { writeSync(1, chunk); callback(); } catch (error) { callback(error); }
    },
  }) });
}

// HTTP is the external boundary of the stdio proxy. Advance its deadlines
// deterministically instead of making the suite wait 25 seconds per request.
let now = 0;
const deadlines = new Map();
AbortSignal.timeout = milliseconds => {
  const controller = new AbortController();
  deadlines.set(controller, now + milliseconds);
  return controller.signal;
};
function advance(milliseconds) {
  now += milliseconds;
  for (const [controller, deadline] of deadlines) {
    if (deadline > now) continue;
    deadlines.delete(controller);
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }
}
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
const calls = {};
const jobId = 'a4884721-9764-44db-9c97-cebb03aafc52';

globalThis.fetch = async (input, init = {}) => {
  const pathname = new URL(String(input)).pathname;
  if (pathname === '/v1/status') return json({ connected: true });
  if (pathname === '/v1/mcp/tools') {
    advance(16_000);
    init.signal.throwIfAborted();
    return json({ tools: [] });
  }
  if (pathname !== '/v1/mcp/call') throw new Error('Unexpected HTTP endpoint in the stdio fixture');
  const request = JSON.parse(init.body);
  calls[request.name] = (calls[request.name] ?? 0) + 1;
  if (request.name === 'fixture_stats') return json(result(calls));
  if (request.name === 'fixture_timeout') {
    advance(60_000);
    init.signal.throwIfAborted();
    throw new Error('The stdio tool request must have a finite deadline');
  }
  if (request.name === 'fixture_body_timeout') {
    return new Response(new ReadableStream({
      pull(controller) {
        advance(60_000);
        controller.error(init.signal.reason);
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  const watchArgs = request.name === 'bridge_watch_wait' ? request.arguments : request.name === 'bridge_call' && request.arguments.tool === 'bridge_watch_wait' ? request.arguments.arguments : undefined;
  if (watchArgs) {
    advance(watchArgs.waitMs ?? 25_000);
    init.signal.throwIfAborted();
    if (watchArgs.watcherId === 'simulate-timeout') {
      advance(11_000); init.signal.throwIfAborted();
      throw new Error('Watcher waits must have a finite deadline');
    }
    return json(result({ watcherId: watchArgs.watcherId, status: 'waiting', monitorDurable: true, canWakeClosedConversation: false }));
  }
  // Both a completed automatic tool and a full bridge_job approval wait can
  // legitimately keep the request open for the gateway's entire 25-second wait.
  advance(25_000);
  init.signal.throwIfAborted();
  return json(result(request.name === 'bridge_job'
    ? { jobId: request.arguments.jobId, status: 'pending_approval' }
    : { jobId, status: 'succeeded', value: request.arguments.value }));
};
