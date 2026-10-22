import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApplication, type Application } from '../src/app.js';

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const plain = (result: any) => result.content.filter((part: any) => part.type === 'text').map((part: any) => JSON.parse(part.text));

async function fixture(t: TestContext, automatic = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-watch-http-'));
  const options = { stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 };
  const runtime = await startApplication(options); const runtimes = [runtime];
  t.after(async () => { await Promise.all(runtimes.map(item => item.close())); await rm(root, { recursive: true, force: true }); });
  if (automatic) await runtime.store.update(config => ({ ...config, approvalMode: 'automatic' }));
  const apiHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  const admin = (route: string, body?: unknown) => fetch(runtime.adminUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const call = async (name: string, args: object, signal?: AbortSignal) => {
    const response = await fetch(runtime.apiUrl + '/v1/mcp/call', { method: 'POST', headers: apiHeaders, body: JSON.stringify({ name, arguments: args }), ...(signal ? { signal } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  const create = async (suffix = 'default') => {
    const result = await call('bridge_watch_create', { name: 'Claude neurolaudos ' + suffix, trigger: { type: 'signal', source: 'claude-neurolaudos', runId: 'run-' + suffix }, idempotencyKey: 'watch-' + suffix });
    assert.equal(result.isError, false, JSON.stringify(result));
    const [job, watcher] = plain(result); assert.equal(job.status, 'succeeded'); assert.ok(watcher.watcherId); return watcher;
  };
  const signal = (watcher: any, overrides: object = {}, token = watcher.callback.token) => fetch(runtime.apiUrl + '/hooks/watchers/' + watcher.watcherId + '/signal', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: randomUUID(), runId: watcher.trigger.runId, status: 'succeeded', summary: 'Demanda concluída e verificada.', ...overrides }) });
  return { root, options, runtime, runtimes, apiHeaders, admin, call, create, signal };
}

async function authorize(runtime: Application) {
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const client = await runtime.oauth.clientsStore.registerClient!({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'ponte:tools' });
  let consent = '';
  await runtime.oauth.authorize(client, { redirectUri: redirect, codeChallenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), scopes: ['ponte:tools'], resource: new URL('https://watchers.example/mcp') }, { redirect: (_status: number, url: string) => { consent = url; } } as unknown as Response);
  const requestId = new URL(consent).searchParams.get('request')!;
  await runtime.oauth.approve(requestId);
  const code = new URL(await runtime.oauth.completeAuthorization(requestId)).searchParams.get('code')!;
  const tokens = await runtime.oauth.exchangeAuthorizationCode(client, code, undefined, redirect, new URL('https://watchers.example/mcp'));
  return { token: tokens.access_token, grantId: (await runtime.oauth.verifyAccessToken(tokens.access_token)).extra!.grantId as string };
}

async function rpc(runtime: Application, token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(runtime.apiUrl + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) });
  assert.equal(response.status, 200); return response.json();
}

test('watcher creation follows approval; callback is scoped, bounded and available while paused', async t => {
  const f = await fixture(t, false);
  const pending = plain(await f.call('bridge_watch_create', { name: 'Aguardar Claude', trigger: { type: 'signal', source: 'claude', runId: 'approved-run' } }))[0];
  assert.equal(pending.status, 'pending_approval');
  assert.equal((await f.admin('/admin/state').then(res => res.json())).watchers.stats.waiting, 0);
  assert.equal((await f.admin('/admin/jobs/' + pending.jobId + '/approve', {})).status, 200);
  const [job, watcher] = plain(await f.call('bridge_job', { jobId: pending.jobId, waitMs: 1000 }));
  assert.equal(job.status, 'succeeded');
  assert.equal(watcher.callback.url, f.runtime.apiUrl + '/hooks/watchers/' + watcher.watcherId + '/signal');
  assert.equal(watcher.callback.body.runId, 'approved-run');
  assert.equal((await f.signal(watcher, {}, f.runtime.store.secrets.apiToken)).status, 401);
  assert.equal((await f.signal({ ...watcher, watcherId: randomUUID() })).status, 401);
  assert.equal((await f.signal(watcher, { runId: 'wrong-run' })).status, 400);
  const oversized = await f.signal(watcher, { summary: 'x'.repeat(33 * 1024) });
  assert.equal(oversized.status, 413); assert.ok(!(await oversized.text()).includes('xxx'));
  await f.admin('/admin/pause', { paused: true });
  assert.equal((await f.signal(watcher, { status: 'needs_input', summary: 'Preciso da especificação do campo.' })).status, 200);
  const result = plain(await f.call('bridge_watch_get', { watcherId: watcher.watcherId }))[0];
  assert.equal(result.status, 'needs_input'); assert.equal(result.canWakeClosedConversation, false);
  assert.equal(result.callback, undefined); assert.equal(result.signalToken, undefined);
  const state = await f.admin('/admin/state').then(res => res.json());
  assert.equal(state.watchers.stats.needs_input, 1);
  assert.ok(!JSON.stringify(state.watchers).includes(watcher.callback.token));
  const adminJob = await f.admin('/admin/jobs/' + job.jobId).then(res => res.json());
  assert.ok(!JSON.stringify(adminJob).includes(watcher.callback.token));
  const ownerJob = await fetch(f.runtime.apiUrl + '/v1/jobs/' + job.jobId, { headers: f.apiHeaders }).then(res => res.json());
  assert.ok(JSON.stringify(ownerJob.result).includes(watcher.callback.token));
});

test('four waits do not occupy execution slots and real producer completion releases the original wait', async t => {
  const f = await fixture(t); const watcher = await f.create('parallel');
  const waits = Array.from({ length: 4 }, () => f.call('bridge_watch_wait', { watcherId: watcher.watcherId, waitMs: 10000 }));
  for (let i = 0; i < 100 && f.runtime.state().watchers?.activeWaiters !== 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.runtime.state().watchers?.activeWaiters, 4);
  const delegation = await f.call('local_write_file', { projectId: 'principal', path: 'delegated.txt', content: 'demanda enviada', expectedHash: null });
  assert.equal(plain(delegation)[0].status, 'succeeded');
  assert.equal(plain(await f.call('bridge_watch_get', { watcherId: watcher.watcherId }))[0].status, 'waiting');
  const sent = await promisify(execFile)(process.execPath, ['scripts/ponte-watch-notify.mjs', '--status', 'succeeded', '--summary', 'Demanda implementada e validada.', '--exit-code', '0'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PONTE_WATCH_URL: watcher.callback.url, PONTE_WATCH_TOKEN: watcher.callback.token, PONTE_WATCH_RUN_ID: watcher.trigger.runId } });
  assert.ok(!(sent.stdout + sent.stderr).includes(watcher.callback.token));
  const results = (await Promise.all(waits)).map(result => plain(result)[0]);
  assert.ok(results.every(result => result.status === 'succeeded' && result.result.exitCode === 0));
  assert.equal(f.runtime.state().watchers?.activeWaiters, 0);
  const persisted = JSON.parse(await readFile(path.join(f.options.stateDir, 'watchers.json'), 'utf8'));
  assert.equal(persisted.watchers[0].status, 'succeeded');
  assert.ok(!JSON.stringify(persisted).includes(watcher.callback.token));
});

test('disconnect removes only waiter and native signal watcher survives restart with idempotent creation', async t => {
  const f = await fixture(t); const watcher = await f.create('restart');
  assert.equal((await f.create('restart')).watcherId, watcher.watcherId);
  const abort = new AbortController(); const waiting = f.call('bridge_watch_wait', { watcherId: watcher.watcherId, waitMs: 10000 }, abort.signal);
  void waiting.catch(() => {});
  for (let i = 0; i < 100 && !f.runtime.state().watchers?.activeWaiters; i++) await new Promise(resolve => setTimeout(resolve, 5));
  abort.abort(); await assert.rejects(waiting);
  for (let i = 0; i < 100 && f.runtime.state().watchers?.activeWaiters; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.runtime.state().watchers?.activeWaiters, 0);
  assert.equal(plain(await f.call('bridge_watch_get', { watcherId: watcher.watcherId }))[0].status, 'waiting');
  await f.runtime.close(); const reopened = await startApplication(f.options); f.runtimes.push(reopened);
  const body = { eventId: randomUUID(), runId: watcher.trigger.runId, status: 'failed', summary: 'Teste externo falhou.', exitCode: 1 };
  const send = () => fetch(reopened.apiUrl + '/hooks/watchers/' + watcher.watcherId + '/signal', { method: 'POST', headers: { Authorization: 'Bearer ' + watcher.callback.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send()).status, 200); assert.equal((await send()).status, 200);
  const result = await fetch(reopened.apiUrl + '/v1/watchers/' + watcher.watcherId, { headers: f.apiHeaders }).then(res => res.json());
  assert.equal(result.status, 'failed'); assert.equal(result.result.summary, body.summary);
  assert.equal(result.callback, undefined);
});

test('legacy and MCP2 expose native watchers with per-grant isolation and revocation', async t => {
  const f = await fixture(t); await f.runtime.store.update(config => ({ ...config, publicUrl: 'https://watchers.example' }));
  const one = await authorize(f.runtime), two = await authorize(f.runtime);
  const listed = await rpc(f.runtime, one.token, 'tools/list');
  for (const name of ['bridge_watch_create', 'bridge_watch_get', 'bridge_watch_wait', 'bridge_watch_list', 'bridge_watch_cancel']) assert.ok(listed.result.tools.some((tool: any) => tool.name === name), name);
  const client = new Client({ name: 'watcher-legacy', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.runtime.apiUrl + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + one.token } } }));
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'bridge_watch_wait'));
  const created = await client.callTool({ name: 'bridge_watch_create', arguments: { name: 'OAuth external', trigger: { type: 'signal', source: 'claude', runId: 'oauth-run' } } });
  assert.equal(created.isError, false); const watcher = plain(created)[1];
  assert.equal(watcher.callback.url, 'https://watchers.example/hooks/watchers/' + watcher.watcherId + '/signal');
  for (const name of ['bridge_watch_get', 'bridge_watch_wait', 'bridge_watch_cancel']) {
    const denied = await rpc(f.runtime, two.token, 'tools/call', { name, arguments: { watcherId: watcher.watcherId, ...(name === 'bridge_watch_wait' ? { waitMs: 0 } : {}) } });
    assert.equal(denied.result.isError, true); assert.ok(!JSON.stringify(denied).includes('oauth-run'));
  }
  const otherList = await rpc(f.runtime, two.token, 'tools/call', { name: 'bridge_watch_list', arguments: {} });
  assert.equal(plain(otherList.result)[0].total, 0);
  assert.equal((await fetch(f.runtime.apiUrl + '/v1/watchers/' + watcher.watcherId, { headers: f.apiHeaders })).status, 404);
  const waiting = await rpc(f.runtime, one.token, 'tools/call', { name: 'bridge_watch_wait', arguments: { watcherId: watcher.watcherId, waitMs: 0 } });
  assert.equal(plain(waiting.result)[0].status, 'waiting');
  await f.runtime.oauth.revokeGrant(one.grantId);
  assert.equal((await f.signal(watcher)).status, 401);
  assert.equal((await f.admin('/admin/watchers/' + watcher.watcherId).then(res => res.json())).status, 'cancelled');
});

test('job trigger follows approved real job; Actions and admin cancel preserve the external job', async t => {
  const f = await fixture(t, false);
  const submitted = await f.call('local_write_file', { projectId: 'principal', path: 'job.txt', content: 'feito', expectedHash: null });
  const jobId = plain(submitted)[0].jobId;
  await f.runtime.store.update(config => ({ ...config, approvalMode: 'automatic' }));
  const made = await f.call('bridge_watch_create', { name: 'Resultado do arquivo', trigger: { type: 'job', jobId } });
  assert.equal(made.isError, false); const watcher = plain(made)[1];
  assert.equal(watcher.status, 'waiting'); assert.equal(watcher.callback, undefined);
  const waiter = f.call('bridge_watch_wait', { watcherId: watcher.watcherId, waitMs: 2000 });
  await f.admin('/admin/jobs/' + jobId + '/approve', {});
  assert.equal(plain(await waiter)[0].status, 'succeeded');
  const external = await f.create('cancel');
  const response = await fetch(f.runtime.apiUrl + '/v1/watchers/' + external.watcherId + '/cancel', { method: 'POST', headers: f.apiHeaders, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'cancelled');
  assert.equal((await f.signal(external)).status, 409);
  const list = await fetch(f.runtime.apiUrl + '/v1/watchers?limit=1&offset=0', { headers: f.apiHeaders }).then(res => res.json());
  assert.equal(list.total, 2); assert.equal(list.watchers.length, 1);
  assert.ok(!JSON.stringify(list).includes(external.callback.token));
});

test('signal persistence failure is retriable and never acknowledges a terminal result before commit', async t => {
  const f = await fixture(t); const watcher = await f.create('io-error');
  const filename = path.join(f.options.stateDir, 'watchers.json'); const saved = filename + '.saved';
  await rename(filename, saved); await mkdir(filename);
  const eventId = randomUUID();
  const failed = await f.signal(watcher, { eventId });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes(f.options.stateDir));
  assert.equal(plain(await f.call('bridge_watch_get', { watcherId: watcher.watcherId }))[0].status, 'waiting');
  await rm(filename, { recursive: true }); await rename(saved, filename);
  assert.equal((await f.signal(watcher, { eventId })).status, 200);
  assert.equal(plain(await f.call('bridge_watch_wait', { watcherId: watcher.watcherId, waitMs: 0 }))[0].status, 'succeeded');
});

test('unauthenticated callback traffic cannot exhaust the completion quota of legitimate watchers', async t => {
  const f = await fixture(t); const watcher = await f.create('quota');
  for (let i = 0; i < 601; i++) {
    const response = await fetch(watcher.callback.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'x'.repeat(43) }, body: '{}' });
    await response.arrayBuffer();
  }
  assert.equal((await f.signal(watcher)).status, 200);
  assert.equal(plain(await f.call('bridge_watch_get', { watcherId: watcher.watcherId }))[0].status, 'succeeded');
});
