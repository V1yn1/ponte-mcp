import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type RequestListener } from 'node:http';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/ponte-watch-notify.mjs', import.meta.url));
const secret = 'watcher-only-test-secret';
const args = ['--status', 'succeeded', '--summary', 'Demanda validada.'];

async function endpoint(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/hooks/watchers/example/signal`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

async function notify(url: string, argv = args, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script, ...argv], {
    env: { ...process.env, PONTE_WATCH_URL: url, PONTE_WATCH_TOKEN: secret, PONTE_WATCH_RUN_ID: 'neurolaudos-demanda-test', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => child.kill(), 20000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

test('notifier posts an authenticated, correlated JSON completion receipt', async () => {
  const received: { body: string; authorization?: string; contentType?: string }[] = [];
  const server = await endpoint(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ body, authorization: request.headers.authorization, contentType: request.headers['content-type'] });
    response.writeHead(200).end('{}');
  });
  try {
    const result = await notify(server.url, [...args, '--exit-code', '0']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0]!.body);
    assert.match(body.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual({ ...body, eventId: 'UUID' }, { eventId: 'UUID', runId: 'neurolaudos-demanda-test', status: 'succeeded', summary: 'Demanda validada.', exitCode: 0 });
    assert.equal(received[0]!.authorization, `Bearer ${secret}`);
    assert.equal(received[0]!.contentType, 'application/json');
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes(secret));
  } finally { await server.close(); }
});

test('notifier fails on permanent HTTP errors without retrying or disclosing server content', async () => {
  let requests = 0;
  const server = await endpoint((_request, response) => {
    requests++;
    response.writeHead(401).end(`sensitive-response-${secret}`);
  });
  try {
    const result = await notify(server.url);
    assert.equal(result.code, 1);
    assert.equal(requests, 1);
    assert.match(result.stderr, /401/);
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stderr.includes('sensitive-response'));
    assert.ok(!result.stderr.includes(server.url));
  } finally { await server.close(); }
});

test('notifier retries transient HTTP failures with the exact same event and stops at three attempts', async () => {
  const bodies: string[] = [];
  const server = await endpoint(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    response.writeHead(503).end(secret);
  });
  try {
    const result = await notify(server.url);
    assert.equal(result.code, 1);
    assert.equal(bodies.length, 3);
    assert.equal(new Set(bodies).size, 1);
    assert.match(JSON.parse(bodies[0]!).eventId, /^[0-9a-f-]{36}$/);
    assert.ok(!result.stderr.includes(secret));
  } finally { await server.close(); }
});

test('notifier can succeed after a transient HTTP failure', async () => {
  let requests = 0;
  const server = await endpoint((_request, response) => response.writeHead(++requests === 1 ? 503 : 204).end());
  try {
    const result = await notify(server.url, ['--status', 'needs_input', '--summary', 'Escolha necessária.']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests, 2);
  } finally { await server.close(); }
});

test('notifier refuses redirects instead of forwarding its credential', async () => {
  let redirected = 0;
  const destination = await endpoint((_request, response) => { redirected++; response.end(); });
  let original = 0;
  const server = await endpoint((_request, response) => {
    original++;
    response.writeHead(307, { location: destination.url }).end();
  });
  try {
    const result = await notify(server.url);
    assert.equal(result.code, 1);
    assert.equal(original, 1);
    assert.equal(redirected, 0);
    assert.ok(!result.stderr.includes(secret));
  } finally { await Promise.all([server.close(), destination.close()]); }
});

test('notifier validates command and environment before sending a request', async () => {
  let requests = 0;
  const server = await endpoint((_request, response) => { requests++; response.end(); });
  try {
    const invalid: [string[], Record<string, string>][] = [
      [['--status', 'waiting', '--summary', 'No'], {}],
      [['--status', 'succeeded'], {}],
      [[...args, '--exit-code', '1.5'], {}],
      [[...args, '--exit-code', '9007199254740992'], {}],
      [[...args, '--unknown', 'value'], {}],
      [args, { PONTE_WATCH_RUN_ID: '' }],
      [args, { PONTE_WATCH_RUN_ID: 'x'.repeat(129) }],
      [args, { PONTE_WATCH_TOKEN: '' }],
      [args, { PONTE_WATCH_TOKEN: `${secret}\ninjected-header` }],
      [args, { PONTE_WATCH_URL: `${server.url}?token=${secret}` }],
      [args, { PONTE_WATCH_URL: `${server.url}#${secret}` }],
      [args, { PONTE_WATCH_URL: server.url.replace('http://', `http://user:${secret}@`) }],
      [args, { PONTE_WATCH_URL: 'http://example.com/signal' }],
      [args, { PONTE_WATCH_URL: 'ftp://127.0.0.1/signal' }],
      [args, { PONTE_WATCH_URL: `${server.url}?` }],
      [args, { PONTE_WATCH_URL: `${server.url}#` }]
    ];
    for (const [argv, env] of invalid) {
      const result = await notify(server.url, argv, env);
      assert.equal(result.code, 1, `accepted invalid input: ${Object.keys(env).join(',')} ${argv[0]}`);
      assert.match(result.stderr, /^ponte-watch-notify: /);
      assert.ok(!result.stderr.includes(secret));
      assert.ok(!result.stderr.includes(server.url));
    }
    assert.equal(requests, 0);
  } finally { await server.close(); }
});

test('notifier rejects oversized UTF-8 payloads before sending a request', async () => {
  let requests = 0;
  const server = await endpoint((_request, response) => { requests++; response.end(); });
  try {
    const result = await notify(server.url, ['--status', 'failed', '--summary', '🧪'.repeat(9000)]);
    assert.equal(result.code, 1);
    assert.equal(requests, 0);
    assert.match(result.stderr, /^ponte-watch-notify: /);
    assert.ok(!result.stderr.includes(secret));
  } finally { await server.close(); }
});
