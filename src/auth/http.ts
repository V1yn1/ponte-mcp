import { urlencoded, type Express, type RequestHandler, type Response } from 'express';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Application } from '../app.js';
import { projectRoot } from '../app.js';
import { matchesRegisteredRedirect } from './provider.js';

export const MCP_SCOPE = 'ponte:tools';
const protocolPaths = new Set(['/authorize', '/register', '/token', '/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
export const isOAuthProtocolPath = (pathname: string): boolean => protocolPaths.has(pathname.replace(/\/$/, ''));

export function oauthConnectionState(runtime: Application) {
  const issuer = runtime.store.config.publicUrl ? new URL(runtime.store.config.publicUrl).origin : null;
  return {
    enabled: Boolean(issuer), issuer, resource: issuer ? issuer + '/mcp' : null, scopes: [MCP_SCOPE],
    metadataUrl: issuer ? issuer + '/.well-known/oauth-protected-resource/mcp' : null,
    authorizationServerMetadataUrl: issuer ? issuer + '/.well-known/oauth-authorization-server' : null,
    ...runtime.oauth.snapshot(),
  };
}

/** OAuth discovery/consent live on the API listener; decisions live only on admin. */
export function mountOAuth(admin: Express, api: Express, runtime: Application): void {
  const configured: RequestHandler = (_req, res, next) => {
    if (!runtime.store.config.publicUrl) {
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Configure a origem HTTPS pública no painel local antes de conectar o cliente MCP.' }); return;
    }
    next();
  };
  const issuer = () => new URL(runtime.store.config.publicUrl!).origin;
  const resourceMetadata = () => ({ resource: issuer() + '/mcp', authorization_servers: [issuer()], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ['header'], resource_name: 'Ponte MCP' });
  const authorizationMetadata = () => ({
    issuer: issuer(), authorization_response_iss_parameter_supported: true,
    authorization_endpoint: issuer() + '/authorize', token_endpoint: issuer() + '/token',
    registration_endpoint: issuer() + '/register', revocation_endpoint: issuer() + '/revoke',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], scopes_supported: [MCP_SCOPE],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  });
  api.use('/.well-known/oauth-authorization-server', configured, (req, res, next) => metadataHandler(authorizationMetadata())(req, res, next));
  for (const route of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    api.use(route, configured, (req, res, next) => metadataHandler(resourceMetadata())(req, res, next));
  }

  // Keep trust proxy disabled. Behind a tunnel these limits intentionally apply
  // to its shared loopback peer, never an attacker-controlled forwarded IP.
  const rateLimit = { validate: { xForwardedForHeader: false, forwardedHeader: false } };
  const withIssuer: RequestHandler = (req, res, next) => {
    const currentIssuer = issuer();
    const original = res.redirect.bind(res);
    // SDK 1.x omits RFC 9207 on its validation-error redirects. Add it to every
    // authorization response before advertising stable-callback support.
    res.redirect = ((statusOrUrl: number | string, destination?: string) => {
      const status = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      const target = new URL(typeof statusOrUrl === 'string' ? statusOrUrl : destination!, currentIssuer);
      if (target.searchParams.has('code') || target.searchParams.has('error')) {
        target.searchParams.set('iss', currentIssuer);
        const state: unknown = req.method === 'POST' ? req.body?.state : req.query.state;
        if (typeof state === 'string' && state.length <= 512 && !target.searchParams.has('state')) target.searchParams.set('state', state);
      }
      return original(status, target.href);
    }) as Response['redirect'];
    next();
  };
  const validateRedirect: RequestHandler = async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') { next(); return; }
    const params = req.method === 'POST' ? req.body : req.query;
    if (typeof params?.client_id === 'string' && typeof params.redirect_uri === 'string') {
      const client = await runtime.oauth.clientsStore.getClient(params.client_id);
      // The SDK checks request parameters before provider.authorize and can
      // redirect errors itself. Apply the same safe callback policy first.
      if (client && !matchesRegisteredRedirect(params.redirect_uri, client.redirect_uris)) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Unregistered or unsafe redirect URI.' }); return;
      }
    }
    next();
  };
  api.use('/authorize', configured, urlencoded({ extended: false }), validateRedirect, withIssuer, authorizationHandler({ provider: runtime.oauth, rateLimit }));
  api.use('/token', configured, tokenHandler({ provider: runtime.oauth, rateLimit: { ...rateLimit, max: 120 } }));
  api.use('/register', configured, clientRegistrationHandler({ clientsStore: runtime.oauth.clientsStore, clientSecretExpirySeconds: 0, rateLimit }));
  api.use('/revoke', configured, revocationHandler({ provider: runtime.oauth, rateLimit }));

  api.get('/oauth/consent/status', configured, (req, res) => {
    const id = typeof req.query.request === 'string' ? req.query.request : '';
    const status = runtime.oauth.consentStatus(id);
    if (!status) { res.status(404).json({ error: 'Solicitação não encontrada ou expirada. Inicie a conexão novamente no cliente MCP.' }); return; }
    res.json({ ...status, adminUrl: runtime.adminUrl });
  });
  api.get('/oauth/complete', configured, async (req, res) => {
    if (req.method !== 'GET') { res.set('Allow', 'GET').status(405).end(); return; }
    const id = typeof req.query.request === 'string' ? req.query.request : '';
    res.redirect(302, await runtime.oauth.completeAuthorization(id));
  });
  for (const [route, file] of [['/oauth/consent', 'consent.html'], ['/oauth/consent.js', 'consent.js'], ['/oauth/consent.css', 'consent.css']] as const) {
    api.get(route, configured, (_req, res) => { res.sendFile(path.join(projectRoot, 'public', file), { cacheControl: false }); });
  }
  api.get('/assets/ponte-mark.png', configured, (_req, res) => {
    res.sendFile(path.join(projectRoot, 'public', 'assets', 'ponte-mark.png'), { cacheControl: false });
  });
  for (const decision of ['approve', 'reject'] as const) {
    admin.post('/admin/oauth/requests/:id/' + decision, async (req, res) => {
      await runtime.oauth[decision](String(req.params.id)); res.json({ ok: true });
    });
  }
  admin.post('/admin/oauth/grants/:id/revoke', async (req, res) => {
    await runtime.oauth.revokeGrant(String(req.params.id)); res.json({ ok: true });
  });
}

export function authenticateMcp(runtime: Application, legacyBearer: RequestHandler): RequestHandler {
  let windowStart = Date.now(); let authenticatedRequests = 0;
  return (req, res, next) => {
    const value = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const supplied = Buffer.from(value); const expected = Buffer.from(runtime.store.secrets.apiToken);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return legacyBearer(req, res, next);
    const origin = runtime.store.config.publicUrl;
    if (!origin) return legacyBearer(req, res, next);
    const resource = new URL(origin).origin + '/mcp';
    const metadataUrl = new URL(origin).origin + '/.well-known/oauth-protected-resource/mcp';
    return requireBearerAuth({ verifier: runtime.oauth, requiredScopes: [MCP_SCOPE], expectedResource: new URL(resource), resourceMetadataUrl: metadataUrl })(req, res, error => {
      if (error) { next(error); return; }
      if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); authenticatedRequests = 0; }
      if (++authenticatedRequests > 600) { res.set('Retry-After', '60').status(429).json({ error: 'Limite local de 600 requisições por minuto.' }); return; }
      next();
    });
  };
}
