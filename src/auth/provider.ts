import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { z } from 'zod';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientError, InvalidClientMetadataError, InvalidGrantError, InvalidRequestError,
  InvalidScopeError, InvalidTargetError, InvalidTokenError, OAuthError, ServerError, TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

const SCOPE = 'ponte:tools';
const PENDING_SECONDS = 600;
const CODE_SECONDS = 120;
const ACCESS_SECONDS = 3600;
const GRANT_SECONDS = 30 * 24 * 60 * 60;
const MAX_CLIENTS = 100;
const MAX_GRANTS = 100;
const MAX_PENDING = 100;
const MAX_TOKENS = 10_000;
const MAX_GRANT_TOKENS = 2_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const RESERVED_QUERY = new Set([
  'code', 'state', 'iss', 'error', 'error_description', 'error_uri', 'access_token', 'refresh_token', 'id_token',
  'token_type', 'expires_in', 'scope', 'client_id', 'client_secret', 'redirect_uri', 'response_type', 'grant_type',
  'resource', 'code_challenge', 'code_challenge_method', 'code_verifier',
]);

const now = () => Math.floor(Date.now() / 1000);
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenHash = (value: string) => typeof value === 'string' && OPAQUE.test(value) ? digest(value) : undefined;

function publicOrigin(value: string | undefined): string | undefined {
  if (!value || value.length > 2048 || /[\s?#]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') return undefined;
    return url.origin;
  } catch { return undefined; }
}

function safeRedirect(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u0020\u007f#]/.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return false;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => RESERVED_QUERY.has(key.toLowerCase()));
  } catch { return false; }
}

const scopeSchema = z.array(z.literal(SCOPE)).length(1);
const metadataSchema = z.object({
  redirect_uris: z.array(z.string().refine(safeRedirect)).min(1).max(8).refine(items => new Set(items).size === items.length),
  client_name: z.string().trim().min(1).max(200).default('Cliente MCP'),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).default('client_secret_post'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1).max(2)
    .refine(items => items.includes('authorization_code') && new Set(items).size === items.length)
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).length(1).default(['code']),
  scope: z.literal(SCOPE).default(SCOPE),
});
const clientSchema = metadataSchema.extend({
  client_id: z.string().regex(OPAQUE),
  client_id_issued_at: z.number().int().nonnegative(),
  client_secret: z.string().regex(OPAQUE).optional(),
  client_secret_expires_at: z.literal(0).optional(),
  authorizedAt: z.number().int().nonnegative().optional(),
}).strict().refine(client => client.token_endpoint_auth_method === 'none'
  ? client.client_secret === undefined && client.client_secret_expires_at === undefined
  : client.client_secret !== undefined && client.client_secret_expires_at === 0);
const grantSchema = z.object({
  id: z.string().regex(OPAQUE), clientId: z.string().regex(OPAQUE),
  issuer: z.string().refine(value => publicOrigin(value) === value), resource: z.string(), scopes: scopeSchema,
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
}).strict().refine(grant => grant.resource === `${grant.issuer}/mcp` && grant.expiresAt > grant.createdAt
  && grant.expiresAt - grant.createdAt <= GRANT_SECONDS);
const tokenSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(['access', 'refresh']), grantId: z.string().regex(OPAQUE),
  expiresAt: z.number().int().nonnegative(), used: z.boolean(),
}).strict().refine(token => !token.used || token.kind === 'refresh');
const stateSchema = z.object({
  version: z.literal(1), issuer: z.string().refine(value => publicOrigin(value) === value).optional(),
  clients: z.array(clientSchema).max(MAX_CLIENTS), grants: z.array(grantSchema).max(MAX_GRANTS),
  tokens: z.array(tokenSchema).max(MAX_TOKENS),
}).strict().superRefine((state, ctx) => {
  const clients = new Set(state.clients.map(client => client.client_id));
  const grants = new Map(state.grants.map(grant => [grant.id, grant]));
  if (clients.size !== state.clients.length || grants.size !== state.grants.length
    || new Set(state.tokens.map(token => token.hash)).size !== state.tokens.length
    || state.grants.some(grant => !clients.has(grant.clientId) || grant.issuer !== state.issuer)
    || state.tokens.some(token => !grants.has(token.grantId) || token.expiresAt > grants.get(token.grantId)!.expiresAt)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent OAuth state' });
  }
});
type PersistentState = z.infer<typeof stateSchema>;
type RegisteredClient = PersistentState['clients'][number];
type Grant = PersistentState['grants'][number];
type Token = PersistentState['tokens'][number];

function clientInformation(client: RegisteredClient): OAuthClientInformationFull {
  const { authorizedAt: _internal, ...metadata } = client;
  return structuredClone(metadata);
}

export interface ConsentSummary {
  id: string; verificationCode: string; clientName: string; redirectUri: string; scopes: string[]; expiresAt: number;
}
export interface GrantSummary {
  id: string; clientName: string; createdAt: number; expiresAt: number; resource: string; scopes: string[];
}
export interface ConsentStatus {
  status: 'pending' | 'approved' | 'rejected' | 'expired'; request: ConsentSummary;
}
interface Pending extends ConsentSummary {
  clientId: string; issuer: string; resource: string; codeChallenge: string; state?: string;
  decision: 'pending' | 'approved' | 'rejected'; invalidated?: boolean;
}
interface AuthorizationCode {
  clientId: string; issuer: string; resource: string; redirectUri: string; scopes: string[]; codeChallenge: string; expiresAt: number;
}

function checkOwnedFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('OAuth state must be a regular, privately owned file without links.');
  }
}

async function existingFile(filename: string): Promise<Stats | undefined> {
  try {
    const info = await lstat(filename);
    checkOwnedFile(info);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Local approval is the resource owner's consent; the public consent page cannot approve. */
export class PonteOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = false;
  readonly clientsStore: OAuthRegisteredClientsStore;
  private chain: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, AuthorizationCode>();

  private constructor(private readonly stateDir: string, private state: PersistentState, private readonly getPublicUrl: () => string | undefined) {
    this.clientsStore = {
      getClient: async id => {
        await this.chain;
        const client = this.state.clients.find(item => item.client_id === id);
        return client ? clientInformation(client) : undefined;
      },
      registerClient: input => this.serialized(async () => {
        await this.synchronizeIssuer();
        const parsed = metadataSchema.safeParse(input);
        if (!parsed.success) throw new InvalidClientMetadataError('Unsupported or invalid OAuth client metadata.');
        const next = this.cleanState();
        if (next.clients.length >= MAX_CLIENTS) {
          this.pruneVolatile();
          const protectedClients = new Set(next.grants.map(grant => grant.clientId));
          for (const request of this.pending.values()) {
            if (['pending', 'approved'].includes(this.requestStatus(request))) protectedClients.add(request.clientId);
          }
          for (const code of this.codes.values()) protectedClients.add(code.clientId);
          const oldestUnused = next.clients.filter(client => client.authorizedAt === undefined && !protectedClients.has(client.client_id))
            .sort((a, b) => a.client_id_issued_at - b.client_id_issued_at)[0];
          if (!oldestUnused) throw new TemporarilyUnavailableError('The client registration limit has been reached.');
          next.clients = next.clients.filter(client => client.client_id !== oldestUnused.client_id);
        }
        const client: RegisteredClient = {
          ...parsed.data, client_id: opaque(), client_id_issued_at: now(),
          ...(parsed.data.token_endpoint_auth_method === 'none' ? {} : { client_secret: opaque(), client_secret_expires_at: 0 as const }),
        };
        next.clients.push(client);
        await this.commit(next);
        return clientInformation(client);
      }),
    };
  }

  static async open(stateDir: string, getPublicUrl: () => string | undefined): Promise<PonteOAuthProvider> {
    stateDir = path.resolve(stateDir);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw new Error('OAuth state directory is unsafe.');
    await chmod(stateDir, 0o700);
    const filename = path.join(stateDir, 'oauth.json');
    let state: PersistentState = { version: 1, clients: [], grants: [], tokens: [] };
    const info = await existingFile(filename);
    if (info) {
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await file.stat();
        checkOwnedFile(opened);
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_STATE_BYTES) throw new Error('OAuth state file is unsafe or too large.');
        await file.chmod(0o600);
        const parsed = stateSchema.safeParse(JSON.parse(await file.readFile('utf8')));
        if (!parsed.success) throw new Error('OAuth state is invalid.');
        state = parsed.data;
      } finally { await file.close(); }
    }
    let migrated = false;
    for (const grant of state.grants) {
      const client = state.clients.find(item => item.client_id === grant.clientId)!;
      if (client.authorizedAt === undefined || client.authorizedAt > grant.createdAt) {
        client.authorizedAt = grant.createdAt;
        migrated = true;
      }
    }
    const provider = new PonteOAuthProvider(stateDir, state, getPublicUrl);
    await provider.synchronizeIssuer();
    if ((!info || migrated) && provider.state === state) await provider.commit(state);
    return provider;
  }

  private serialized<T>(action: () => Promise<T> | T): Promise<T> {
    const task = this.chain.then(action);
    this.chain = task.then(() => {}, () => {});
    return task;
  }

  private async commit(next: PersistentState): Promise<void> {
    const destination = path.join(this.stateDir, 'oauth.json');
    const temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
    const body = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new TemporarilyUnavailableError('OAuth storage limit reached.');
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(body, 'utf8'); await file.sync(); } finally { await file.close(); }
      await existingFile(destination);
      await rename(temporary, destination);
      this.state = next;
    } finally { await rm(temporary, { force: true }); }
  }

  private async synchronizeIssuer(force = false): Promise<void> {
    const issuer = publicOrigin(this.getPublicUrl());
    if (!force && issuer === this.state.issuer) return;
    await this.commit({ ...this.state, issuer, grants: [], tokens: [] });
    for (const request of this.pending.values()) request.invalidated = true;
    this.codes.clear();
  }

  /** Call after a public URL setting changes, even if another edit has already changed it back. */
  publicUrlChanged(): Promise<void> {
    return this.serialized(() => this.synchronizeIssuer(true));
  }

  private cleanState(): PersistentState {
    const next = structuredClone(this.state);
    next.grants = next.grants.filter(grant => grant.expiresAt > now());
    const grants = new Set(next.grants.map(grant => grant.id));
    // Used refresh hashes remain for the entire grant lifetime to detect replay.
    next.tokens = next.tokens.filter(token => grants.has(token.grantId) && token.expiresAt > now());
    return next;
  }

  private pruneVolatile(): void {
    for (const [id, request] of this.pending) if (request.expiresAt + PENDING_SECONDS <= now()) this.pending.delete(id);
    for (const [hash, code] of this.codes) if (code.expiresAt <= now()) this.codes.delete(hash);
  }

  private registered(client: OAuthClientInformationFull): RegisteredClient {
    const registered = this.state.clients.find(item => item.client_id === client.client_id);
    if (!registered) throw new InvalidClientError('Unknown OAuth client.');
    return registered;
  }

  private scopes(input: string[] | undefined, allowDefault: boolean): [typeof SCOPE] {
    if ((input === undefined || (allowDefault && input.length === 0))) return [SCOPE];
    if (input.length !== 1 || input[0] !== SCOPE) throw new InvalidScopeError('Only the ponte:tools scope is supported.');
    return [SCOPE];
  }

  private resource(input: URL | undefined, expected: string): string {
    if (input !== undefined && input.href !== expected) throw new InvalidTargetError('The resource must be this Ponte MCP endpoint.');
    return expected;
  }

  private requestSummary(request: Pending): ConsentSummary {
    return { id: request.id, verificationCode: request.verificationCode, clientName: request.clientName,
      redirectUri: request.redirectUri, scopes: [...request.scopes], expiresAt: request.expiresAt };
  }

  private requestStatus(request: Pending): ConsentStatus['status'] {
    return request.invalidated || request.expiresAt <= now() || request.issuer !== publicOrigin(this.getPublicUrl()) ? 'expired' : request.decision;
  }

  private callback(request: Pick<Pending, 'redirectUri' | 'issuer' | 'state'>, result: Record<string, string>): string {
    const callback = new URL(request.redirectUri);
    for (const [name, value] of Object.entries(result)) callback.searchParams.set(name, value);
    if (request.state !== undefined) callback.searchParams.set('state', request.state);
    callback.searchParams.set('iss', request.issuer);
    return callback.href;
  }

  snapshot(): { pending: ConsentSummary[]; grants: GrantSummary[] } {
    const issuer = publicOrigin(this.getPublicUrl());
    return {
      pending: [...this.pending.values()].filter(request => this.requestStatus(request) === 'pending').map(request => this.requestSummary(request)),
      grants: this.state.grants.filter(grant => issuer !== undefined && grant.issuer === issuer && grant.expiresAt > now()).map(grant => ({
        id: grant.id, clientName: this.state.clients.find(client => client.client_id === grant.clientId)?.client_name ?? 'Cliente MCP',
        createdAt: grant.createdAt, expiresAt: grant.expiresAt, resource: grant.resource, scopes: [...grant.scopes],
      })),
    };
  }

  consentStatus(id: string): ConsentStatus | undefined {
    const request = this.pending.get(id);
    return request ? { status: this.requestStatus(request), request: this.requestSummary(request) } : undefined;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    await this.serialized(async () => {
      await this.synchronizeIssuer();
      const registered = this.state.clients.find(item => item.client_id === client.client_id);
      // The SDK permits variable loopback ports; Ponte deliberately requires exact registration.
      if (!registered || !registered.redirect_uris.includes(params.redirectUri)) {
        res.status(400).json(new InvalidRequestError('Unregistered client or redirect URI.').toResponseObject());
        return;
      }
      const issuer = this.state.issuer;
      if (!issuer) {
        res.status(503).json(new TemporarilyUnavailableError('Configure the public HTTPS origin first.').toResponseObject());
        return;
      }
      try {
        const scopes = this.scopes(params.scopes, true);
        const resource = this.resource(params.resource, `${issuer}/mcp`);
        if (!OPAQUE.test(params.codeChallenge) || Buffer.from(params.codeChallenge, 'base64url').toString('base64url') !== params.codeChallenge) {
          throw new InvalidRequestError('A SHA-256 PKCE challenge is required.');
        }
        if (params.state !== undefined && (typeof params.state !== 'string' || params.state.length > 512)) throw new InvalidRequestError('The state parameter is too long.');
        this.pruneVolatile();
        if (this.pending.size >= MAX_PENDING) throw new TemporarilyUnavailableError('Too many pending authorization requests.');
        const id = opaque();
        this.pending.set(id, {
          id, verificationCode: randomBytes(4).toString('hex').toUpperCase(), clientName: registered.client_name,
          clientId: registered.client_id, issuer, resource, redirectUri: params.redirectUri, scopes,
          state: params.state, codeChallenge: params.codeChallenge, expiresAt: now() + PENDING_SECONDS, decision: 'pending',
        });
        res.redirect(302, `${issuer}/oauth/consent?request=${id}`);
      } catch (error) {
        const oauthError = error instanceof OAuthError ? error : new ServerError('Authorization could not be started.');
        res.redirect(302, this.callback({ redirectUri: params.redirectUri, issuer,
          state: typeof params.state === 'string' && params.state.length <= 512 ? params.state : undefined }, {
          error: oauthError.errorCode, error_description: oauthError.message,
        }));
      }
    });
  }

  private decide(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      const request = this.pending.get(id);
      if (!request || this.requestStatus(request) !== 'pending') throw new InvalidRequestError('Authorization request is unavailable or expired.');
      request.decision = decision;
    });
  }

  approve(id: string): Promise<void> { return this.decide(id, 'approved'); }
  reject(id: string): Promise<void> { return this.decide(id, 'rejected'); }

  completeAuthorization(id: string): Promise<string> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      const request = this.pending.get(id);
      if (!request) throw new InvalidRequestError('Authorization request is unavailable.');
      const status = this.requestStatus(request);
      if (status === 'pending') throw new InvalidRequestError('Local approval is still pending.');
      let result: Record<string, string> = { error: 'access_denied' };
      if (status === 'approved') {
        this.pruneVolatile();
        if (this.codes.size >= MAX_PENDING) throw new TemporarilyUnavailableError('Too many outstanding authorization codes.');
        const code = opaque();
        this.codes.set(digest(code), {
          clientId: request.clientId, issuer: request.issuer, resource: request.resource, redirectUri: request.redirectUri,
          scopes: [...request.scopes], codeChallenge: request.codeChallenge, expiresAt: now() + CODE_SECONDS,
        });
        result = { code };
      }
      const callback = this.callback(request, result);
      this.pending.delete(id);
      return callback;
    });
  }

  private authorizationCode(client: OAuthClientInformationFull, value: string): AuthorizationCode {
    const hash = tokenHash(value);
    const code = hash ? this.codes.get(hash) : undefined;
    if (!code || code.clientId !== client.client_id || code.expiresAt <= now() || !this.state.issuer || code.issuer !== this.state.issuer) {
      throw new InvalidGrantError('Authorization code is invalid, expired or already used.');
    }
    this.registered(client);
    return code;
  }

  challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      return this.authorizationCode(client, authorizationCode).codeChallenge;
    });
  }

  private issueTokens(next: PersistentState, grant: Grant, refresh: boolean): OAuthTokens {
    const required = refresh ? 2 : 1;
    if (next.tokens.length + required > MAX_TOKENS || next.tokens.filter(token => token.grantId === grant.id).length + required > MAX_GRANT_TOKENS) {
      throw new TemporarilyUnavailableError('OAuth token storage limit reached; reconnect this client.');
    }
    const access = opaque();
    const issuedAt = now();
    const expiresAt = Math.min(issuedAt + ACCESS_SECONDS, grant.expiresAt);
    next.tokens.push({ hash: digest(access), kind: 'access', grantId: grant.id, expiresAt, used: false });
    const result: OAuthTokens = { access_token: access, token_type: 'Bearer', expires_in: expiresAt - issuedAt, scope: grant.scopes.join(' ') };
    if (refresh) {
      const value = opaque();
      next.tokens.push({ hash: digest(value), kind: 'refresh', grantId: grant.id, expiresAt: grant.expiresAt, used: false });
      result.refresh_token = value;
    }
    return result;
  }

  exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      const code = this.authorizationCode(client, authorizationCode);
      if (redirectUri !== code.redirectUri) throw new InvalidGrantError('The redirect URI does not match the authorization request.');
      this.resource(resource, code.resource);
      const registered = this.registered(client);
      const next = this.cleanState();
      if (next.grants.length >= MAX_GRANTS) throw new TemporarilyUnavailableError('Revoke an existing connection before adding another.');
      const refresh = registered.grant_types.includes('refresh_token');
      const createdAt = now();
      const grant: Grant = {
        id: opaque(), clientId: registered.client_id, issuer: code.issuer, resource: code.resource, scopes: this.scopes(code.scopes, false),
        createdAt, expiresAt: createdAt + (refresh ? GRANT_SECONDS : ACCESS_SECONDS),
      };
      next.grants.push(grant);
      next.clients.find(item => item.client_id === registered.client_id)!.authorizedAt ??= createdAt;
      const result = this.issueTokens(next, grant, refresh);
      // The SDK tokenHandler has checked S256 PKCE; serialized consumption closes exchange races.
      await this.commit(next);
      this.codes.delete(digest(authorizationCode));
      return result;
    });
  }

  private tokenGrant(value: string, kind: Token['kind']): { token: Token; grant: Grant } | undefined {
    const hash = tokenHash(value);
    const token = this.state.tokens.find(item => item.hash === hash && item.kind === kind);
    const grant = token ? this.state.grants.find(item => item.id === token.grantId) : undefined;
    if (!token || !grant || token.expiresAt <= now() || grant.expiresAt <= now() || !this.state.issuer || grant.issuer !== this.state.issuer) return undefined;
    return { token, grant };
  }

  private withoutGrant(id: string): PersistentState {
    const next = this.cleanState();
    next.grants = next.grants.filter(grant => grant.id !== id);
    next.tokens = next.tokens.filter(token => token.grantId !== id);
    return next;
  }

  exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      const found = this.tokenGrant(refreshToken, 'refresh');
      if (!found || found.grant.clientId !== client.client_id) throw new InvalidGrantError('Refresh token is invalid or expired.');
      const registered = this.registered(client);
      if (!registered.grant_types.includes('refresh_token')) throw new InvalidGrantError('This client cannot refresh tokens.');
      if (found.token.used) {
        await this.commit(this.withoutGrant(found.grant.id));
        throw new InvalidGrantError('Refresh token reuse revoked this connection.');
      }
      this.scopes(scopes, false);
      this.resource(resource, found.grant.resource);
      const next = this.cleanState();
      next.tokens.find(token => token.hash === found.token.hash)!.used = true;
      const result = this.issueTokens(next, found.grant, true);
      await this.commit(next);
      return result;
    });
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      const found = this.tokenGrant(token, 'access');
      if (!found) throw new InvalidTokenError('Access token is invalid, expired or revoked.');
      return { token, clientId: found.grant.clientId, scopes: [...found.grant.scopes], expiresAt: found.token.expiresAt, resource: new URL(found.grant.resource) };
    });
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      const found = this.tokenGrant(request.token, 'access') ?? this.tokenGrant(request.token, 'refresh');
      if (found && found.grant.clientId === client.client_id) await this.commit(this.withoutGrant(found.grant.id));
    });
  }

  revokeGrant(id: string): Promise<void> {
    return this.serialized(async () => {
      await this.synchronizeIssuer();
      if (!this.state.grants.some(grant => grant.id === id)) throw new InvalidRequestError('Connection is unavailable.');
      await this.commit(this.withoutGrant(id));
    });
  }
}
