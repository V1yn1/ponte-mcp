import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { startApplication } from '../src/app.js';

const issuer = 'https://ponte.example';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-oauth-http-'));
  const runtime = await startApplication({ stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  await fetch(runtime.adminUrl + '/admin/settings', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ publicUrl: issuer }) });
  // Exercise HTTPS discovery identifiers over a real local HTTP listener. This is
  // a test tunnel, not evidence of external TLS or a live ChatGPT connection.
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, issuer, 'OAuth client must not contact another issuer');
    return fetch(runtime.apiUrl + url.pathname + url.search, { ...init, redirect: 'manual' });
  };
  const json = (route: string, body: unknown) => localFetch(issuer + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const form = (route: string, body: Record<string, string>) => localFetch(issuer + route, { method: 'POST', body: new URLSearchParams(body) });
  const admin = (route: string, body: unknown = {}) => fetch(runtime.adminUrl + route, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) });
  return { root, runtime, localFetch, json, form, admin, adminHeaders };
}

test('MCP advertises public OAuth discovery with exact issuer, resource and supported grants', async t => {
  const f = await fixture(t);
  const blocked = await f.localFetch(issuer + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 401);
  assert.match(blocked.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/ponte.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const res = await f.localFetch(issuer + route);
    assert.equal(res.status, 200);
    const metadata = await res.json();
    assert.equal(metadata.resource, issuer + '/mcp');
    assert.deepEqual(metadata.authorization_servers, [issuer]);
    assert.deepEqual(metadata.scopes_supported, ['ponte:tools']);
  }
  const metadata = await f.localFetch(issuer + '/.well-known/oauth-authorization-server').then(res => res.json());
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['client_secret_post', 'none']);
  assert.equal(metadata.registration_endpoint, issuer + '/register');
  assert.equal(metadata.revocation_endpoint, issuer + '/revoke');
});

test('official MCP OAuth client discovers, registers, obtains local consent and calls real tools', async t => {
  const f = await fixture(t);
  let clientInfo: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = '';
  let authorizationUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    clientMetadata: { client_name: 'Interop SDK / ChatGPT callback', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    state: () => 'expected-oauth-state', clientInformation: () => clientInfo,
    saveClientInformation: value => { clientInfo = value; }, tokens: () => tokens, saveTokens: value => { tokens = value; },
    redirectToAuthorization: value => { authorizationUrl = value; }, saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
  };
  assert.equal(await auth(provider, { serverUrl: issuer + '/mcp', fetchFn: f.localFetch }), 'REDIRECT');
  assert.ok(clientInfo?.client_id);
  assert.equal((clientInfo as { client_secret_expires_at?: number }).client_secret_expires_at, 0);
  assert.equal(authorizationUrl?.searchParams.get('resource'), issuer + '/mcp');
  const request = await f.localFetch(authorizationUrl!);
  assert.equal(request.status, 302);
  const consentUrl = new URL(request.headers.get('location')!, issuer);
  assert.equal(consentUrl.pathname, '/oauth/consent');
  const requestId = consentUrl.searchParams.get('request')!;
  const statusUrl = issuer + '/oauth/consent/status?request=' + requestId;
  assert.equal((await f.localFetch(statusUrl).then(res => res.json())).status, 'pending');
  assert.equal((await f.localFetch(issuer + '/oauth/complete?request=' + requestId)).status, 400);
  assert.equal((await fetch(f.runtime.adminUrl + '/admin/oauth/requests/' + requestId + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + f.runtime.store.secrets.apiToken } })).status, 401);
  assert.equal((await f.admin('/admin/oauth/requests/' + requestId + '/approve')).status, 200);
  const completed = await f.localFetch(issuer + '/oauth/complete?request=' + requestId);
  assert.equal(completed.status, 302);
  const callback = new URL(completed.headers.get('location')!);
  assert.equal(callback.origin + callback.pathname, redirect);
  assert.equal(callback.searchParams.get('state'), 'expected-oauth-state');
  assert.equal(callback.searchParams.get('iss'), issuer);
  assert.equal(await auth(provider, { serverUrl: issuer + '/mcp', authorizationCode: callback.searchParams.get('code')!, fetchFn: f.localFetch }), 'AUTHORIZED');
  assert.ok(tokens?.access_token);
  assert.ok(tokens?.refresh_token);
  const client = new Client({ name: 'ponte-oauth-integration', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(issuer + '/mcp'), { fetch: f.localFetch, authProvider: provider });
  await client.connect(transport);
  t.after(() => client.close());
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'local_read_file'));
  // The SDK client strips unknown top-level descriptor fields. Inspect the
  // actual protocol response for ChatGPT's securitySchemes extension as well.
  const wire = await f.localFetch(issuer + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens!.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} }) }).then(res => res.json());
  for (const tool of wire.result.tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['ponte:tools'] }]);
    assert.deepEqual(tool._meta?.securitySchemes, tool.securitySchemes);
  }
  assert.ok(catalog.tools.every(tool => Array.isArray(tool._meta?.securitySchemes)));
  const status = await client.callTool({ name: 'bridge_status', arguments: {} });
  assert.ok(JSON.stringify(status).includes('Ponte MCP'));
  // The OAuth token is limited to MCP: neither admin nor legacy Actions accepts it.
  assert.equal((await fetch(f.runtime.adminUrl + '/admin/state', { headers: { Authorization: 'Bearer ' + tokens!.access_token } })).status, 401);
  assert.equal((await f.localFetch(issuer + '/v1/status', { headers: { Authorization: 'Bearer ' + tokens!.access_token } })).status, 401);
  const state = await fetch(f.runtime.adminUrl + '/admin/state', { headers: f.adminHeaders }).then(res => res.json());
  assert.equal(state.connection.oauth.grants.length, 1);
  assert.ok(!JSON.stringify(state).includes(tokens!.access_token));
  const stored = await readFile(path.join(f.root, 'state', 'oauth.json'), 'utf8');
  assert.ok(!stored.includes(tokens!.access_token));
  assert.ok(!stored.includes(tokens!.refresh_token!));
  assert.equal((await f.admin('/admin/oauth/grants/' + state.connection.oauth.grants[0].id + '/revoke')).status, 200);
  const denied = await f.localFetch(issuer + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens!.access_token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
});

test('authorization error redirects include exact issuer and rejected requests never issue a code', async t => {
  const f = await fixture(t);
  const registration = await f.json('/register', { client_name: 'Public test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: issuer + '/mcp', state: 'error-state', scope: 'ponte:tools' });
  for (const [key, invalid] of [['scope', 'admin:all'], ['code_challenge_method', 'plain'], ['resource', 'https://other.example/mcp'], ['response_type', 'token']]) {
    const values = new URLSearchParams(params); values.set(key!, invalid!);
    const result = await f.localFetch(issuer + '/authorize?' + values);
    assert.equal(result.status, 302);
    const callback = new URL(result.headers.get('location')!);
    assert.ok(callback.searchParams.get('error'));
    assert.equal(callback.searchParams.get('iss'), issuer);
    assert.equal(callback.searchParams.get('state'), 'error-state');
    assert.equal(callback.searchParams.has('code'), false);
  }
  const result = await f.localFetch(issuer + '/authorize?' + params);
  const id = new URL(result.headers.get('location')!, issuer).searchParams.get('request')!;
  assert.equal((await f.admin('/admin/oauth/requests/' + id + '/reject')).status, 200);
  const callback = new URL((await f.localFetch(issuer + '/oauth/complete?request=' + id)).headers.get('location')!);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('iss'), issuer);
  assert.equal(callback.searchParams.get('state'), 'error-state');
  params.set('redirect_uri', 'https://attacker.example/callback');
  const invalidRedirect = await f.localFetch(issuer + '/authorize?' + params);
  assert.equal(invalidRedirect.status, 400);
  assert.equal(invalidRedirect.headers.has('location'), false);
});

test('HTTP token endpoint rejects wrong PKCE, audience, redirect and authorization-code replay', async t => {
  const f = await fixture(t);
  const { client_id } = await f.json('/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }).then(res => res.json());
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: issuer + '/mcp', scope: 'ponte:tools' });
  const consent = new URL((await f.localFetch(issuer + '/authorize?' + params)).headers.get('location')!, issuer);
  const id = consent.searchParams.get('request')!;
  assert.equal((await f.admin('/admin/oauth/requests/' + id + '/approve')).status, 200);
  assert.equal((await f.localFetch(issuer + '/oauth/complete?request=' + id, { method: 'HEAD' })).status, 405);
  const callback = new URL((await f.localFetch(issuer + '/oauth/complete?request=' + id)).headers.get('location')!);
  const tokenParams = { client_id, grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect, resource: issuer + '/mcp' };
  for (const wrong of [{ code_verifier: randomBytes(32).toString('base64url') }, { resource: 'https://other.example/mcp' }, { redirect_uri: 'https://attacker.example/callback' }]) {
    const result = await f.form('/token', { ...tokenParams, ...wrong });
    assert.equal(result.status, 400);
    const body = await result.json();
    assert.ok(['invalid_grant', 'invalid_target', 'invalid_request'].includes(body.error));
    assert.equal(body.access_token, undefined);
  }
  const success = await f.form('/token', tokenParams);
  assert.equal(success.status, 200);
  const tokens = await success.json();
  assert.equal((await f.form('/token', tokenParams)).status, 400);
  assert.equal((await f.form('/token', { client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: issuer + '/mcp', scope: 'admin:all' })).status, 400);
  const refreshed = await f.form('/token', { client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: issuer + '/mcp' });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await f.form('/revoke', { client_id, token: rotated.refresh_token, token_type_hint: 'refresh_token' })).status, 200);
  assert.equal((await f.localFetch(issuer + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + rotated.access_token, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

test('OAuth endpoints refuse unsupported registration and remain disabled until public HTTPS is configured', async t => {
  const f = await fixture(t);
  for (const invalid of [
    { redirect_uris: ['javascript:alert(1)'], token_endpoint_auth_method: 'none' },
    { redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_basic' },
    { redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['client_credentials'] },
  ]) {
    assert.equal((await f.json('/register', invalid)).status, 400);
  }
  await fetch(f.runtime.adminUrl + '/admin/settings', { method: 'PATCH', headers: f.adminHeaders, body: JSON.stringify({ publicUrl: '' }) });
  assert.equal((await f.localFetch(issuer + '/.well-known/oauth-authorization-server')).status, 503);
  assert.equal((await f.json('/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' })).status, 503);
  assert.equal((await fetch(f.runtime.apiUrl + '/v1/status', { headers: { Authorization: 'Bearer ' + f.runtime.store.secrets.apiToken } })).status, 200);
});
