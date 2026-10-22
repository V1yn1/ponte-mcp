import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { buildApiRequest } from '../src/clients/profiles.js';

// Execute the shipped examples with only the network boundary replaced. No
// provider request, paid model call or installation credential is used.
async function runExample(provider: 'gemini' | 'grok', args: string[], reply: (url: string, init: RequestInit) => Promise<Response>) {
  const source = await readFile(new URL(`../examples/${provider}-api.mjs`, import.meta.url), 'utf8');
  const imported = "import { buildApiRequest } from '../dist/clients/profiles.js';";
  assert.ok(source.startsWith(imported));
  const env = { GEMINI_API_KEY: 'google-example-secret', XAI_API_KEY: 'xai-example-secret', GEMINI_MODEL: 'example-model', XAI_MODEL: 'example-model', PONTE_API_TOKEN: 'ponte-example-secret', PONTE_MCP_URL: 'https://bridge.example.com/mcp' };
  let stdout = '', stderr = '', calls = 0;
  const fakeProcess = { argv: ['node', 'example.mjs', ...args], env, exitCode: 0, stdout: { write(value: string) { stdout += value; } }, stderr: { write(value: string) { stderr += value; } } };
  await runInNewContext(source.slice(imported.length), {
    buildApiRequest, AbortSignal, process: fakeProcess,
    fetch: async (url: string, init: RequestInit) => { calls++; return reply(url, init); },
  });
  return { stdout, stderr, calls, exitCode: fakeProcess.exitCode, env };
}

for (const provider of ['gemini', 'grok'] as const) {
  test(`${provider} example separates credentials, rejects redirects and redacts secrets echoed in a successful response`, async () => {
    const result = await runExample(provider, [], async (url, init) => {
      assert.equal(new URL(url).hostname, provider === 'gemini' ? 'generativelanguage.googleapis.com' : 'api.x.ai');
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.tools[0].allowed_tools, ['bridge_status']);
      assert.equal(body.tools[0].headers.Authorization, 'Bearer ponte-example-secret');
      const outer = new Headers(init.headers);
      assert.equal(outer.get(provider === 'gemini' ? 'x-goog-api-key' : 'Authorization'), provider === 'gemini' ? 'google-example-secret' : 'Bearer xai-example-secret');
      return Response.json({ tools: body.tools, error: { message: 'echo google-example-secret xai-example-secret' } });
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.calls, 1);
    assert.ok(!result.stdout.includes(result.env.PONTE_API_TOKEN));
    assert.ok(!result.stdout.includes(provider === 'gemini' ? result.env.GEMINI_API_KEY : result.env.XAI_API_KEY));
    assert.match(result.stdout, /CREDENCIAL OCULTA/);
  });

  test(`${provider} example requires explicit tools access and never retries uncertain failures`, async () => {
    const result = await runExample(provider, ['--tools'], async (_url, init) => {
      const body = JSON.parse(String(init.body));
      assert.ok(body.tools[0].allowed_tools.includes('bridge_invoke'));
      assert.ok(body.tools[0].allowed_tools.includes('bridge_watch_get'));
      throw new Error('Upstream leaked ponte-example-secret');
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.calls, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(result.env.PONTE_API_TOKEN));
    assert.match(result.stderr, /incerto/);
  });

  test(`${provider} example omits provider error bodies and help performs no network call`, async () => {
    const failure = await runExample(provider, [], async () => new Response('ponte-example-secret', { status: 429 }));
    assert.equal(failure.exitCode, 1);
    assert.equal(failure.calls, 1);
    assert.match(failure.stderr, /HTTP 429/);
    assert.ok(!failure.stderr.includes(failure.env.PONTE_API_TOKEN));
    const help = await runExample(provider, ['--help'], async () => { throw new Error('No request expected'); });
    assert.equal(help.exitCode, 0, help.stderr);
    assert.equal(help.calls, 0);
    assert.match(help.stdout, /Uso:/);
  });
}
