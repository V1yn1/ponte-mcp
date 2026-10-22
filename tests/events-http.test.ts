import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApplication, type Application } from '../src/app.js';
import type { WebhookPost } from '../src/events/webhook.js';

const ORIGIN = 'https://events-bridge.example';
const CALLBACK = 'https://receiver.example/private-callback-token';
const SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const EVENT = 'ponte.job.completed';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

async function authorize(runtime: Application) {
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const client = await runtime.oauth.clientsStore.registerClient!({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'ponte:tools' });
  let consent = '';
  const response = { redirect: (_status: number, url: string) => { consent = url; } } as unknown as Response;
  await runtime.oauth.authorize(client, { redirectUri: redirect, codeChallenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), scopes: ['ponte:tools'], resource: new URL(ORIGIN + '/mcp') }, response);
  const requestId = new URL(consent).searchParams.get('request')!;
  await runtime.oauth.approve(requestId);
  const code = new URL(await runtime.oauth.completeAuthorization(requestId)).searchParams.get('code')!;
  const tokens = await runtime.oauth.exchangeAuthorizationCode(client, code, undefined, redirect, new URL(ORIGIN + '/mcp'));
  const grantId = (await runtime.oauth.verifyAccessToken(tokens.access_token)).extra!.grantId as string;
  return { tokens, grantId, client };
}

async function rpc(runtime: Application, token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(runtime.apiUrl + '/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-events-http-'));
  const received: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let deliveryStatus = 200;
  const eventPost: WebhookPost = async (url, body, headers) => {
    assert.equal(url, CALLBACK);
    const expected = 'v1,' + createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(headers['webhook-id'] + '.' + headers['webhook-timestamp'] + '.' + body).digest('base64');
    assert.ok(headers['webhook-signature']!.split(' ').includes(expected));
    const parsed = JSON.parse(body);
    received.push({ body: parsed, headers });
    return parsed.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) } : { status: deliveryStatus, body: '' };
  };
  const options = { stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0, eventPost };
  const runtime = await startApplication(options);
  const runtimes = [runtime];
  t.after(async () => { await Promise.all(runtimes.map(item => item.close())); await rm(root, { recursive: true, force: true }); });
  await runtime.store.update(config => ({ ...config, publicUrl: ORIGIN }));
  const auth = await authorize(runtime);
  const admin = (route: string, method = 'GET') => fetch(runtime.adminUrl + route, { method, headers: { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' } });
  const createJob = async (token = auth.tokens.access_token, filename = 'event.txt') => {
    const response = await rpc(runtime, token, 'tools/call', { name: 'bridge_call', arguments: { tool: 'local_write_file', arguments: { projectId: 'principal', path: filename, content: 'completed through events', expectedHash: null }, idempotencyKey: filename } });
    assert.equal(response.status, 200);
    assert.equal(response.body.result?.isError, false);
    const state = JSON.parse(response.body.result.content[0].text);
    assert.equal(state.status, 'pending_approval');
    return state.jobId as string;
  };
  const subscription = (jobId: string, token = auth.tokens.access_token) => rpc(runtime, token, 'events/subscribe', { name: EVENT, arguments: { jobId }, delivery: { mode: 'webhook', url: CALLBACK, secret: SECRET } });
  const complete = async (id: string) => {
    assert.equal((await admin('/admin/jobs/' + id + '/approve', 'POST')).status, 200);
    for (let i = 0; i < 100 && runtime.jobs.get(id).status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.jobs.get(id).status, 'succeeded');
    await runtime.events.flush();
    await runtime.events.pump();
  };
  return { root, runtime, runtimes, options, auth, received, admin, createJob, subscription, complete, setDeliveryStatus: (status: number) => { deliveryStatus = status; } };
}

test('MCP2 Events discovery shares authenticated endpoint with working legacy tools', async t => {
  const f = await fixture(t);
  const discovered = await rpc(f.runtime, f.auth.tokens.access_token, 'server/discover');
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.result.resultType, 'complete');
  assert.ok(discovered.body.result.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(discovered.body.result.capabilities.events, {});
  const listed = await rpc(f.runtime, f.auth.tokens.access_token, 'events/list');
  assert.equal(listed.body.result.events[0].name, EVENT);
  assert.deepEqual(listed.body.result.events[0].inputSchema.required, ['jobId']);
  assert.equal((await rpc(f.runtime, 'missing', 'events/list')).status, 401);
  const client = new Client({ name: 'legacy-events-regression', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.runtime.apiUrl + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + f.auth.tokens.access_token } } }));
  const legacy = await client.callTool({ name: 'bridge_status', arguments: {} });
  assert.ok(JSON.stringify(legacy).includes('Ponte MCP'));
});

test('malformed MCP2 JSON returns a protocol parse error without echoing request contents', async t => {
  const f = await fixture(t);
  const response = await fetch(f.runtime.apiUrl + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + f.auth.tokens.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'events/subscribe' }, body: '{"private":"do-not-echo",' });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.jsonrpc, '2.0');
  assert.equal(result.error.code, -32700);
  assert.equal(JSON.stringify(result).includes('do-not-echo'), false);
});

test('verified OAuth subscription delivers terminal summary once and retains full result across restart', async t => {
  const f = await fixture(t);
  const jobId = await f.createJob();
  const subscribed = await f.subscription(jobId);
  assert.equal(subscribed.status, 200);
  assert.ok(subscribed.body.result.id);
  assert.equal(f.received.filter(item => item.body.type === 'verification').length, 1);
  assert.equal(f.received.filter(item => item.body.eventId).length, 0);
  await f.complete(jobId);
  const delivered = f.received.filter(item => item.body.eventId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.body.name, EVENT);
  assert.equal((delivered[0]!.body.data as Record<string, unknown>).jobId, jobId);
  assert.equal((delivered[0]!.body.data as Record<string, unknown>).status, 'succeeded');
  assert.equal(JSON.stringify(delivered).includes('completed through events'), false);
  assert.equal(await readFile(path.join(f.root, 'project', 'event.txt'), 'utf8'), 'completed through events');
  const adminState = await f.admin('/admin/state').then(response => response.json());
  for (const secret of [SECRET, CALLBACK, f.auth.tokens.access_token, f.auth.tokens.refresh_token!]) assert.equal(JSON.stringify(adminState.events).includes(secret), false);
  assert.equal(adminState.events.delivered, 1);
  await f.runtime.close();
  const reopened = await startApplication(f.options);
  f.runtimes.push(reopened);
  const result = await rpc(reopened, f.auth.tokens.access_token, 'tools/call', { name: 'bridge_job', arguments: { jobId } });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.isError, false);
  assert.equal(JSON.parse(result.body.result.content[0].text).status, 'succeeded');
  assert.ok(result.body.result.content.length > 1);
  await reopened.events.pump();
  assert.equal(f.received.filter(item => item.body.eventId).length, 1);
});

test('subscription belongs to original OAuth grant and admin can stop it before approval', async t => {
  const f = await fixture(t);
  const jobId = await f.createJob();
  const other = await authorize(f.runtime);
  const refused = await f.subscription(jobId, other.tokens.access_token);
  assert.ok(refused.body.error);
  assert.equal(f.received.length, 0);
  const accepted = await f.subscription(jobId);
  const id = accepted.body.result.id;
  assert.equal((await fetch(f.runtime.adminUrl + '/admin/events/subscriptions/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + f.runtime.store.secrets.apiToken } })).status, 401);
  assert.equal((await f.admin('/admin/events/subscriptions/' + id, 'DELETE')).status, 200);
  await f.complete(jobId);
  assert.equal(f.received.filter(item => item.body.eventId).length, 0);
});

test('live job results and cancellation stay with the creating connection while admin retains access', async t => {
  const f = await fixture(t);
  const jobId = await f.createJob();
  const other = await authorize(f.runtime);
  for (const name of ['bridge_job', 'bridge_cancel']) {
    const denied = await rpc(f.runtime, other.tokens.access_token, 'tools/call', { name, arguments: { jobId } });
    assert.equal(denied.body.result.isError, true);
    assert.equal(JSON.parse(denied.body.result.content[0].text).jobId, undefined);
    assert.equal(f.runtime.jobs.get(jobId).status, 'pending_approval');
  }
  const apiHeaders = { Authorization: 'Bearer ' + f.runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  assert.equal((await fetch(f.runtime.apiUrl + '/v1/jobs/' + jobId, { headers: apiHeaders })).status, 400);
  assert.equal((await fetch(f.runtime.apiUrl + '/v1/jobs/' + jobId + '/cancel', { method: 'POST', headers: apiHeaders, body: '{}' })).status, 400);
  assert.equal(f.runtime.jobs.get(jobId).status, 'pending_approval');
  assert.equal((await f.admin('/admin/jobs/' + jobId)).status, 200);
  const ownRead = await rpc(f.runtime, f.auth.tokens.access_token, 'tools/call', { name: 'bridge_job', arguments: { jobId } });
  assert.equal(JSON.parse(ownRead.body.result.content[0].text).status, 'pending_approval');
  const ownCancel = await rpc(f.runtime, f.auth.tokens.access_token, 'tools/call', { name: 'bridge_cancel', arguments: { jobId } });
  assert.equal(JSON.parse(ownCancel.body.result.content[0].text).status, 'cancelled');
});

test('grant revocation and changed public origin prevent subsequent event delivery', async t => {
  const f = await fixture(t);
  const jobId = await f.createJob();
  assert.equal((await f.subscription(jobId)).status, 200);
  await f.runtime.oauth.revokeGrant(f.auth.grantId);
  await f.complete(jobId);
  assert.equal(f.received.filter(item => item.body.eventId).length, 0);

  const other = await authorize(f.runtime);
  const otherJob = await f.createJob(other.tokens.access_token, 'changed-origin.txt');
  assert.equal((await f.subscription(otherJob, other.tokens.access_token)).status, 200);
  const changed = await fetch(f.runtime.adminUrl + '/admin/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + f.runtime.store.secrets.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ publicUrl: 'https://replacement.example' }) });
  assert.equal(changed.status, 200);
  await f.complete(otherJob);
  assert.equal(f.received.filter(item => item.body.eventId).length, 0);
});
