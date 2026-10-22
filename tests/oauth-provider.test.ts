import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { PonteOAuthProvider } from '../src/auth/provider.js';

const SCOPE = 'ponte:tools';
const ORIGIN = 'https://bridge.example';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect?integration=ponte';
const CHALLENGE = createHash('sha256').update('v'.repeat(43)).digest('base64url');

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ponte-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const module = await import('../src/auth/provider.js').catch(() => assert.fail('The OAuth provider must be implemented'));
  let origin: string | undefined = ORIGIN;
  const provider = await module.PonteOAuthProvider.open(dir, () => origin);
  const client = await provider.clientsStore.registerClient!({
    redirect_uris: [REDIRECT], client_name: 'ChatGPT', token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE,
  });
  return { dir, provider, client, open: () => module.PonteOAuthProvider.open(dir, () => origin), setOrigin: (value: string | undefined) => { origin = value; } };
}

function response() {
  const result: { status: number; location?: string; body?: unknown } = { status: 200 };
  const res = {
    status(code: number) { result.status = code; return res; },
    json(body: unknown) { result.body = body; return res; },
    redirect(code: number, location: string) { result.status = code; result.location = location; return res; },
  } as unknown as Response;
  return { res, result };
}

async function begin(provider: PonteOAuthProvider, client: OAuthClientInformationFull, overrides: Partial<AuthorizationParams> = {}) {
  const { res, result } = response();
  await provider.authorize(client, {
    redirectUri: REDIRECT, codeChallenge: CHALLENGE, state: 'opaque state+value',
    scopes: [SCOPE], resource: new URL(`${ORIGIN}/mcp`), ...overrides,
  }, res);
  return result;
}

async function code(provider: PonteOAuthProvider, client: OAuthClientInformationFull) {
  const result = await begin(provider, client);
  assert.equal(result.status, 302);
  const id = new URL(result.location!).searchParams.get('request')!;
  await provider.approve(id);
  const callback = new URL(await provider.completeAuthorization(id));
  return callback.searchParams.get('code')!;
}

async function tokens(provider: PonteOAuthProvider, client: OAuthClientInformationFull) {
  return provider.exchangeAuthorizationCode(client, await code(provider, client), undefined, REDIRECT, new URL(`${ORIGIN}/mcp`));
}

test('event principal identifies the grant across token rotation and stops on revocation or issuer changes', async t => {
  const { provider, client, setOrigin } = await fixture(t);
  const issued = await tokens(provider, client);
  const verified = await provider.verifyAccessToken(issued.access_token);
  const grantId = provider.snapshot().grants[0]!.id;
  assert.deepEqual(verified.extra, { grantId, issuer: ORIGIN });
  assert.equal(provider.isGrantActive(grantId), true);
  const refreshed = await provider.exchangeRefreshToken(client, issued.refresh_token!);
  assert.deepEqual((await provider.verifyAccessToken(refreshed.access_token)).extra, verified.extra);
  assert.equal(provider.isGrantActive(grantId), true);
  setOrigin('https://another.example');
  assert.equal(provider.isGrantActive(grantId), false);
  setOrigin(ORIGIN);
  await provider.revokeGrant(grantId);
  assert.equal(provider.isGrantActive(grantId), false);
  assert.equal(provider.isGrantActive('missing'), false);
});

test('authorization waits for local consent and completes once with state and issuer', async t => {
  const { provider, client } = await fixture(t);
  const result = await begin(provider, client);
  const consent = new URL(result.location!);
  assert.equal(consent.origin, ORIGIN);
  assert.equal(consent.pathname, '/oauth/consent');
  const id = consent.searchParams.get('request')!;
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(provider.consentStatus(id)?.status, 'pending');
  await assert.rejects(provider.completeAuthorization(id), /pending|approval|aprova/i);
  assert.deepEqual(provider.snapshot().grants, []);
  const pending = provider.snapshot().pending[0]!;
  assert.equal(pending.clientName, 'ChatGPT');
  assert.equal(pending.redirectUri, REDIRECT);
  assert.match(pending.verificationCode, /^[A-Z0-9]{8}$/);
  assert.deepEqual(Object.keys(pending).sort(), ['clientName', 'expiresAt', 'id', 'redirectUri', 'scopes', 'verificationCode']);
  await provider.approve(id);
  assert.equal(provider.consentStatus(id)?.status, 'approved');
  const callback = new URL(await provider.completeAuthorization(id));
  assert.equal(callback.origin + callback.pathname, 'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.equal(callback.searchParams.get('integration'), 'ponte');
  assert.equal(callback.searchParams.get('state'), 'opaque state+value');
  assert.equal(callback.searchParams.get('iss'), ORIGIN);
  assert.match(callback.searchParams.get('code')!, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(provider.completeAuthorization(id));
});

test('rejected consent returns access_denied without issuing a code', async t => {
  const { provider, client } = await fixture(t);
  const result = await begin(provider, client, { state: '' });
  const id = new URL(result.location!).searchParams.get('request')!;
  await provider.reject(id);
  assert.equal(provider.consentStatus(id)?.status, 'rejected');
  const callback = new URL(await provider.completeAuthorization(id));
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('iss'), ORIGIN);
  assert.equal(callback.searchParams.get('state'), '');
  assert.equal(callback.searchParams.has('code'), false);
  await assert.rejects(provider.approve(id));
});

test('authorization binds exact redirect, resource, scope, PKCE and bounded state', async t => {
  const { provider, client } = await fixture(t);
  for (const params of [{ redirectUri: 'https://attacker.example/callback' }, { redirectUri: `${REDIRECT}&extra=true` }]) {
    const result = await begin(provider, client, params);
    assert.equal(result.status, 400);
    assert.equal(result.location, undefined);
  }
  for (const [overrides, expected] of [
    [{ resource: new URL('https://attacker.example/mcp') }, 'invalid_target'],
    [{ scopes: ['files:all'] }, 'invalid_scope'],
    [{ scopes: [SCOPE, SCOPE] }, 'invalid_scope'],
    [{ codeChallenge: 'plain' }, 'invalid_request'],
    [{ state: 'x'.repeat(513) }, 'invalid_request'],
  ] as const) {
    const result = await begin(provider, client, overrides as Partial<AuthorizationParams>);
    assert.equal(result.status, 302);
    const callback = new URL(result.location!);
    assert.equal(callback.searchParams.get('error'), expected);
    assert.equal(callback.searchParams.get('iss'), ORIGIN);
  }
  assert.equal(provider.snapshot().pending.length, 0);
  const valid = await begin(provider, client, { scopes: [], resource: undefined });
  assert.equal(new URL(valid.location!).pathname, '/oauth/consent');
  assert.deepEqual(provider.snapshot().pending[0]?.scopes, [SCOPE]);
});

test('registration rejects unsafe redirects and unsupported client capabilities', async t => {
  const { provider } = await fixture(t);
  const register = provider.clientsStore.registerClient!;
  for (const redirect of [
    'http://example.com/callback', 'https://user:pass@example.com/callback', 'https://@example.com/callback', 'https://example.com/callback#fragment',
    'javascript:alert(1)', 'https://example.com/callback?code=collision', 'https://example.com/callback?state=collision',
    'https://example.com/callback?iss=collision', 'https://example.com/callback?error=collision',
  ]) await assert.rejects(Promise.resolve().then(() => register({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' })));
  for (const metadata of [
    { redirect_uris: [] }, { redirect_uris: Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`) },
    { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
    { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
    { redirect_uris: [REDIRECT], response_types: ['token'] },
    { redirect_uris: [REDIRECT], scope: 'files:all' },
    { redirect_uris: [REDIRECT], client_name: 'x'.repeat(201) },
  ]) await assert.rejects(Promise.resolve().then(() => register(metadata)));
  const loopback = await register({ redirect_uris: ['http://127.0.0.1:3456/callback'], token_endpoint_auth_method: 'none' });
  const result = await begin(provider, loopback, { redirectUri: 'http://127.0.0.1:9876/callback' });
  assert.equal(result.status, 400);
  const confidential = await register({ redirect_uris: [REDIRECT] });
  assert.equal(confidential.token_endpoint_auth_method, 'client_secret_post');
  assert.ok(confidential.client_secret && confidential.client_secret.length >= 32);
  assert.equal(confidential.client_secret_expires_at, 0);
  assert.equal(loopback.client_secret, undefined);
});

test('authorization codes bind client, redirect and resource and are single-use under races', async t => {
  const { provider, client } = await fixture(t);
  const other = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const authorizationCode = await code(provider, client);
  assert.equal(await provider.challengeForAuthorizationCode(client, authorizationCode), CHALLENGE);
  await assert.rejects(provider.challengeForAuthorizationCode(other, authorizationCode));
  await assert.rejects(provider.exchangeAuthorizationCode(other, authorizationCode, undefined, REDIRECT));
  await assert.rejects(provider.exchangeAuthorizationCode(client, authorizationCode, undefined, `${REDIRECT}&extra=true`));
  await assert.rejects(provider.exchangeAuthorizationCode(client, authorizationCode, undefined, undefined));
  await assert.rejects(provider.exchangeAuthorizationCode(client, authorizationCode, undefined, REDIRECT, new URL('https://other.example/mcp')));
  const outcomes = await Promise.allSettled([
    provider.exchangeAuthorizationCode(client, authorizationCode, undefined, REDIRECT),
    provider.exchangeAuthorizationCode(client, authorizationCode, undefined, REDIRECT),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  await assert.rejects(provider.challengeForAuthorizationCode(client, authorizationCode));
});

test('access tokens have canonical audience and safe admin summaries', async t => {
  const { provider, client } = await fixture(t);
  const issued = await tokens(provider, client);
  assert.equal(issued.token_type, 'Bearer');
  assert.equal(issued.expires_in, 3600);
  assert.equal(issued.scope, SCOPE);
  assert.ok(issued.refresh_token);
  const auth = await provider.verifyAccessToken(issued.access_token);
  assert.equal(auth.token, issued.access_token);
  assert.equal(auth.clientId, client.client_id);
  assert.deepEqual(auth.scopes, [SCOPE]);
  assert.equal(auth.resource?.href, `${ORIGIN}/mcp`);
  assert.equal(provider.skipLocalPkceValidation, false);
  const summary = provider.snapshot();
  assert.equal(summary.grants.length, 1);
  assert.deepEqual(Object.keys(summary.grants[0]!).sort(), ['clientName', 'createdAt', 'expiresAt', 'id', 'resource', 'scopes']);
  assert.equal(JSON.stringify(summary).includes(issued.access_token), false);
  assert.equal(JSON.stringify(summary).includes(issued.refresh_token!), false);
  await assert.rejects(provider.verifyAccessToken(issued.refresh_token!));
});

test('refresh rotation persists across restart and replay revokes the complete family', async t => {
  const { provider, client, dir, open } = await fixture(t);
  const first = await tokens(provider, client);
  const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
  assert.notEqual(second.refresh_token, first.refresh_token);
  const disk = await readFile(path.join(dir, 'oauth.json'), 'utf8');
  for (const secret of [first.access_token, first.refresh_token!, second.access_token, second.refresh_token!]) assert.equal(disk.includes(secret), false);
  assert.equal((await stat(path.join(dir, 'oauth.json'))).mode & 0o777, 0o600);
  const reopened = await open();
  assert.equal((await reopened.clientsStore.getClient(client.client_id))?.client_id, client.client_id);
  assert.equal((await reopened.verifyAccessToken(second.access_token)).clientId, client.client_id);
  await assert.rejects(reopened.exchangeRefreshToken(client, first.refresh_token!));
  await assert.rejects(reopened.verifyAccessToken(first.access_token));
  await assert.rejects(reopened.verifyAccessToken(second.access_token));
  await assert.rejects(reopened.exchangeRefreshToken(client, second.refresh_token!));
  assert.equal(reopened.snapshot().grants.length, 0);
  const afterReplay = await open();
  await assert.rejects(afterReplay.verifyAccessToken(second.access_token));
});

test('simultaneous refresh replay revokes the token returned by the winning request', async t => {
  const { provider, client } = await fixture(t);
  const first = await tokens(provider, client);
  const outcomes = await Promise.allSettled([
    provider.exchangeRefreshToken(client, first.refresh_token!),
    provider.exchangeRefreshToken(client, first.refresh_token!),
  ]);
  const succeeded = outcomes.filter(result => result.status === 'fulfilled');
  assert.equal(succeeded.length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  await assert.rejects(provider.verifyAccessToken(succeeded[0]!.value.access_token));
});

test('refresh and token revocation remain client, scope and resource bound', async t => {
  const { provider, client } = await fixture(t);
  const other = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const first = await tokens(provider, client);
  await assert.rejects(provider.exchangeRefreshToken(other, first.refresh_token!));
  await assert.rejects(provider.exchangeRefreshToken(client, first.refresh_token!, ['files:all']));
  await assert.rejects(provider.exchangeRefreshToken(client, first.refresh_token!, [SCOPE], new URL('https://other.example/mcp')));
  await provider.revokeToken(other, { token: first.refresh_token! });
  assert.equal((await provider.verifyAccessToken(first.access_token)).clientId, client.client_id);
  const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!);
  await provider.revokeToken(client, { token: rotated.access_token });
  await assert.rejects(provider.verifyAccessToken(first.access_token));
  await assert.rejects(provider.exchangeRefreshToken(client, rotated.refresh_token!));
  await provider.revokeToken(client, { token: 'unknown' });
});

test('local revocation is persistent and invalidates access and refresh tokens', async t => {
  const { provider, client, open } = await fixture(t);
  const issued = await tokens(provider, client);
  await provider.revokeGrant(provider.snapshot().grants[0]!.id);
  await assert.rejects(provider.verifyAccessToken(issued.access_token));
  await assert.rejects(provider.exchangeRefreshToken(client, issued.refresh_token!));
  const reopened = await open();
  await assert.rejects(reopened.verifyAccessToken(issued.access_token));
});

test('consent, code, access and refresh grants expire at their exact deadlines', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { provider, client } = await fixture(t);
  const pending = new URL((await begin(provider, client)).location!).searchParams.get('request')!;
  t.mock.timers.tick(600_000);
  assert.equal(provider.consentStatus(pending)?.status, 'expired');
  await assert.rejects(provider.approve(pending));
  const denied = new URL(await provider.completeAuthorization(pending));
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  const expiredCode = await code(provider, client);
  t.mock.timers.tick(120_000);
  await assert.rejects(provider.challengeForAuthorizationCode(client, expiredCode));
  await assert.rejects(provider.exchangeAuthorizationCode(client, expiredCode, undefined, REDIRECT));
  const issued = await tokens(provider, client);
  const grantExpiry = provider.snapshot().grants[0]!.expiresAt;
  t.mock.timers.tick(3_600_000);
  await assert.rejects(provider.verifyAccessToken(issued.access_token));
  const rotated = await provider.exchangeRefreshToken(client, issued.refresh_token!);
  assert.equal(provider.snapshot().grants[0]!.expiresAt, grantExpiry);
  t.mock.timers.setTime(grantExpiry * 1000);
  await assert.rejects(provider.exchangeRefreshToken(client, rotated.refresh_token!));
  await assert.rejects(provider.verifyAccessToken(rotated.access_token));
});

test('changing or disabling the public origin permanently invalidates prior grants', async t => {
  const { provider, client, setOrigin, open } = await fixture(t);
  const issued = await tokens(provider, client);
  setOrigin('https://new-bridge.example');
  await assert.rejects(provider.verifyAccessToken(issued.access_token));
  await assert.rejects(provider.exchangeRefreshToken(client, issued.refresh_token!));
  assert.equal(provider.snapshot().grants.length, 0);
  setOrigin(ORIGIN);
  const reopened = await open();
  await assert.rejects(reopened.verifyAccessToken(issued.access_token));
  const current = await tokens(reopened, client);
  setOrigin(undefined);
  await assert.rejects(reopened.verifyAccessToken(current.access_token));
});

test('the settings hook invalidates tokens and codes even when the origin changed back before observation', async t => {
  const { provider, client, setOrigin, open } = await fixture(t);
  const issued = await tokens(provider, client);
  const authorizationCode = await code(provider, client);
  const pending = new URL((await begin(provider, client)).location!).searchParams.get('request')!;
  setOrigin('https://replacement.example');
  setOrigin(ORIGIN);
  await provider.publicUrlChanged();
  await assert.rejects(provider.verifyAccessToken(issued.access_token));
  await assert.rejects(provider.exchangeRefreshToken(client, issued.refresh_token!));
  await assert.rejects(provider.challengeForAuthorizationCode(client, authorizationCode));
  assert.equal(provider.consentStatus(pending)?.status, 'expired');
  const reopened = await open();
  await assert.rejects(reopened.verifyAccessToken(issued.access_token));
});

test('grant lifetime and token lifetime use a single issuance timestamp', async t => {
  const { provider, client } = await fixture(t);
  let clock = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => { clock += 1000; return clock; });
  const issued = await tokens(provider, client);
  const grant = provider.snapshot().grants[0]!;
  assert.equal(grant.expiresAt - grant.createdAt, 30 * 24 * 60 * 60);
  assert.equal(issued.expires_in, 3600);
});

test('pending consent and authorization codes are deliberately lost on restart', async t => {
  const { provider, client, open } = await fixture(t);
  await begin(provider, client);
  const authorizationCode = await code(provider, client);
  const reopened = await open();
  assert.deepEqual(reopened.snapshot().pending, []);
  await assert.rejects(reopened.challengeForAuthorizationCode(client, authorizationCode));
});

test('OAuth state refuses symlinks and malformed existing data', async t => {
  const { dir, open } = await fixture(t);
  await rm(path.join(dir, 'oauth.json'));
  const target = path.join(dir, 'unrelated.json');
  await writeFile(target, 'do not overwrite');
  await symlink(target, path.join(dir, 'oauth.json'));
  await assert.rejects(open());
  assert.equal(await readFile(target, 'utf8'), 'do not overwrite');
  await rm(path.join(dir, 'oauth.json'));
  await writeFile(path.join(dir, 'oauth.json'), '{"version":1,"clients":[]}');
  await assert.rejects(open());
});

test('registration evicts the oldest never-authorized client while keeping its storage bound', async t => {
  const { provider, client, dir, open } = await fixture(t);
  for (let i = 1; i < 100; i++) await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const legitimate = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  assert.equal(await provider.clientsStore.getClient(client.client_id), undefined);
  assert.ok(await provider.clientsStore.getClient(legitimate.client_id));
  assert.equal(JSON.parse(await readFile(path.join(dir, 'oauth.json'), 'utf8')).clients.length, 100);
  const reopened = await open();
  assert.equal(await reopened.clientsStore.getClient(client.client_id), undefined);
  assert.ok(await reopened.clientsStore.getClient(legitimate.client_id));
});

test('registration preserves authorization history across grant revocation and restart', async t => {
  const { provider, client, dir, open } = await fixture(t);
  await tokens(provider, client);
  const saved = JSON.parse(await readFile(path.join(dir, 'oauth.json'), 'utf8'));
  assert.equal(saved.clients[0].authorizedAt, provider.snapshot().grants[0]!.createdAt);
  // Older state without the internal marker can reconstruct history from its grants.
  delete saved.clients[0].authorizedAt;
  await writeFile(path.join(dir, 'oauth.json'), JSON.stringify(saved));
  const migrated = await open();
  await migrated.revokeGrant(migrated.snapshot().grants[0]!.id);
  const reopened = await open();
  for (let i = 0; i < 105; i++) await reopened.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const retained = await reopened.clientsStore.getClient(client.client_id);
  assert.ok(retained);
  assert.equal('authorizedAt' in retained, false);
  assert.deepEqual(reopened.snapshot().grants, []);
});

test('registration never evicts clients with live consent requests or authorization codes', async t => {
  const { provider, client } = await fixture(t);
  const pending = new URL((await begin(provider, client)).location!).searchParams.get('request')!;
  const exchanging = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const authorizationCode = await code(provider, exchanging);
  const unused = await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  for (let i = 0; i < 100; i++) await provider.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  assert.equal(await provider.clientsStore.getClient(unused.client_id), undefined);
  assert.ok(await provider.clientsStore.getClient(client.client_id));
  assert.ok(await provider.clientsStore.getClient(exchanging.client_id));
  assert.equal(provider.consentStatus(pending)?.status, 'pending');
  assert.equal(await provider.challengeForAuthorizationCode(exchanging, authorizationCode), CHALLENGE);
});
