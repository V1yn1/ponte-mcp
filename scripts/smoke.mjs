import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

// Runs against the compiled application; no TypeScript loader or existing user
// configuration is used. Port 0 asks the OS to allocate distinct available ports.
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Tempo limite de 30 segundos.')), 30_000);
const interrupted = () => controller.abort(new Error('Smoke interrompido.'));
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

let temporaryRoot;
let runtime;
let client;
let stage = 'carregar o build compilado';
let failure;
const secrets = [];
const log = (message) => writeSync(1, message + '\n');
const hash = (content) => createHash('sha256').update(content).digest('hex');
const options = () => ({ signal: controller.signal, timeout: 5_000 });

function jsonText(result, index = 0) {
  assert.equal(result.content?.[index]?.type, 'text', 'Resposta MCP deve conter o JSON esperado.');
  return JSON.parse(result.content[index].text);
}

async function callTool(name, arguments_) {
  const result = await client.callTool({ name, arguments: arguments_ }, undefined, options());
  assert.notEqual(result.isError, true, `A chamada MCP ${name} retornou erro.`);
  return result;
}

async function completed(result) {
  const limit = Date.now() + 10_000;
  while (true) {
    const state = jsonText(result);
    if (state.status === 'succeeded') return result;
    assert.ok(['queued', 'running'].includes(state.status), `Estado inesperado: ${state.status}.`);
    assert.ok(Date.now() < limit, 'O trabalho não terminou dentro de 10 segundos.');
    await delay(40, undefined, { signal: controller.signal });
    result = await callTool('bridge_job', { jobId: state.jobId });
  }
}

async function adminRequest(route, method = 'GET', token = runtime.store.secrets.adminToken, payload) {
  const response = await fetch(runtime.adminUrl + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(payload !== undefined || method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  });
  const body = await response.json();
  return { status: response.status, body };
}

try {
  const { startApplication } = await import('../dist/app.js').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('Build ou dependências ausentes. Execute npm ci e npm run build antes de npm run smoke.');
    throw error;
  });

  stage = 'iniciar a aplicação em portas livres';
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ponte-smoke-'));
  const workspace = path.join(temporaryRoot, 'project');
  const eventSecret = 'whsec_' + Buffer.alloc(32, 11).toString('base64');
  secrets.push(eventSecret);
  const deliveries = [];
  // Controlled receiver: validates the actual signed bytes, without calling a
  // real ChatGPT conversation. The production HTTPS transport has its own tests.
  const eventPost = async (url, body, headers) => {
    assert.equal(url, 'https://receiver.example/compiled-smoke');
    const expected = 'v1,' + createHmac('sha256', Buffer.from(eventSecret.slice(6), 'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
    assert.ok(headers['webhook-signature'].split(' ').includes(expected));
    const payload = JSON.parse(body);
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
    deliveries.push(payload);
    return { status: 200, body: '' };
  };
  runtime = await startApplication({ stateDir: path.join(temporaryRoot, 'state'), workspace, adminPort: 0, apiPort: 0, eventPost });
  secrets.push(runtime.store.secrets.adminToken, runtime.store.secrets.apiToken);
  assert.notEqual(runtime.adminUrl, runtime.apiUrl, 'Administração e MCP devem usar portas diferentes.');
  const original = 'Olá, Ponte MCP. Conteúdo original.\n';
  const updated = 'Olá, Ponte MCP. Gravação aprovada pelo administrador.\n';
  const filename = path.join(workspace, 'smoke.txt');
  await writeFile(filename, original, 'utf8');

  stage = 'descobrir OAuth, registrar o cliente e aprovar a conexão';
  const issuer = 'https://ponte-smoke.example';
  await runtime.store.update(config => ({ ...config, publicUrl: issuer }));
  // This local test tunnel preserves canonical HTTPS identifiers without making
  // external requests. It does not verify a deployed tunnel or a ChatGPT account.
  const localFetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, issuer);
    return fetch(runtime.apiUrl + url.pathname + url.search, { ...init, redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) });
  };
  let registration; let oauthTokens; let verifier; let authorizationUrl;
  const oauth = {
    redirectUrl: 'https://chatgpt.com/connector_platform_oauth_redirect',
    clientMetadata: { client_name: 'Ponte compiled smoke', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    state: () => 'compiled-smoke-state', clientInformation: () => registration, saveClientInformation: value => { registration = value; },
    tokens: () => oauthTokens, saveTokens: value => { oauthTokens = value; secrets.push(value.access_token, value.refresh_token); },
    codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value; }, redirectToAuthorization: value => { authorizationUrl = value; },
  };
  assert.equal(await auth(oauth, { serverUrl: issuer + '/mcp', fetchFn: localFetch }), 'REDIRECT');
  const authorization = await localFetch(authorizationUrl);
  assert.equal(authorization.status, 302);
  const requestId = new URL(authorization.headers.get('location'), issuer).searchParams.get('request');
  const localConsent = await adminRequest('/admin/oauth/requests/' + requestId + '/approve', 'POST');
  assert.equal(localConsent.status, 200);
  const callbackResponse = await localFetch(issuer + '/oauth/complete?request=' + requestId);
  assert.equal(callbackResponse.status, 302);
  const callback = new URL(callbackResponse.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'compiled-smoke-state');
  assert.equal(callback.searchParams.get('iss'), issuer);
  assert.equal(await auth(oauth, { serverUrl: issuer + '/mcp', authorizationCode: callback.searchParams.get('code'), fetchFn: localFetch }), 'AUTHORIZED');
  log('OK: descoberta OAuth, DCR, consentimento local, PKCE e callback com emissor verificado.');

  stage = 'negociar a conexão MCP HTTP com o token OAuth';
  client = new Client({ name: 'ponte-compiled-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(issuer + '/mcp'), { fetch: localFetch, authProvider: oauth });
  await client.connect(transport, options());
  assert.equal(client.getServerVersion()?.name, 'ponte-mcp', 'Handshake deve identificar o servidor Ponte.');
  const catalog = await client.listTools({}, options());
  for (const name of ['local_projects', 'local_read_file', 'local_write_file', 'bridge_call', 'bridge_job']) {
    assert.ok(catalog.tools.some((tool) => tool.name === name), `Ferramenta ausente no catálogo: ${name}.`);
  }
  assert.ok(!catalog.tools.some((tool) => /approve/i.test(tool.name)), 'O chat não deve receber uma ferramenta de aprovação.');
  assert.ok(catalog.tools.every(tool => tool._meta?.securitySchemes?.[0]?.type === 'oauth2'));
  log('OK: handshake MCP HTTP e catálogo do build compilado.');

  stage = 'ler o projeto e o arquivo via MCP';
  const projects = jsonText(await completed(await callTool('local_projects', {})), 1);
  const project = projects.projects.find((item) => item.id === 'principal');
  assert.ok(project, 'Projeto temporário deve aparecer em local_projects.');
  assert.equal(project.allowWrite, true);
  const read = jsonText(await completed(await callTool('local_read_file', { projectId: project.id, path: 'smoke.txt' })), 1);
  assert.equal(read.content, original, 'Leitura MCP deve corresponder ao arquivo no disco.');
  assert.equal(read.sha256, hash(original), 'Leitura MCP deve retornar o SHA-256 correto.');
  log('OK: projeto e arquivo lidos via MCP, com SHA-256 verificado.');

  stage = 'submeter a gravação e verificar a espera por aprovação';
  const submitted = jsonText(await callTool('bridge_call', {
    tool: 'local_write_file',
    arguments: { projectId: project.id, path: 'smoke.txt', content: updated, expectedHash: read.sha256 },
    idempotencyKey: 'compiled-smoke-write',
  }));
  assert.equal(submitted.status, 'pending_approval');
  assert.equal(typeof submitted.jobId, 'string');
  await delay(75, undefined, { signal: controller.signal });
  assert.equal(jsonText(await callTool('bridge_job', { jobId: submitted.jobId })).status, 'pending_approval');
  assert.equal(await readFile(filename, 'utf8'), original, 'A solicitação pendente não pode alterar o disco.');
  const review = await adminRequest(`/admin/jobs/${submitted.jobId}`);
  assert.equal(review.status, 200);
  assert.equal(review.body.preview.beforeHash, hash(original));
  assert.equal(review.body.preview.afterHash, hash(updated));
  assert.equal(typeof review.body.preview.diff, 'string');
  const denied = await adminRequest(`/admin/jobs/${submitted.jobId}/approve`, 'POST', runtime.store.secrets.apiToken);
  assert.equal(denied.status, 401, 'O token do chat não pode aprovar uma gravação.');
  assert.equal(await readFile(filename, 'utf8'), original);
  log('OK: gravação pendente, diff disponível e arquivo intacto antes da aprovação.');

  stage = 'aprovar pela administração e confirmar o resultado';
  const approval = await adminRequest(`/admin/jobs/${submitted.jobId}/approve`, 'POST');
  assert.equal(approval.status, 200, 'A aprovação administrativa deve ser aceita.');
  const finished = await completed(await callTool('bridge_job', { jobId: submitted.jobId }));
  const write = jsonText(finished, 1);
  assert.equal(write.afterHash, hash(updated));
  assert.match(write.backupId, /^[a-f0-9-]{36}$/);
  assert.equal(await readFile(filename, 'utf8'), updated, 'O arquivo final deve conter a gravação aprovada.');
  assert.equal(await readFile(path.join(temporaryRoot, 'state', 'backups', `${write.backupId}.bak`), 'utf8'), original);
  log('OK: aprovação administrativa, trabalho concluído e conteúdo final/backup verificados.');

  stage = 'ativar aprovação automática e confirmar chamadas OAuth sem revisão individual';
  const queuedDirectory = jsonText(await callTool('local_create_directory', { projectId: 'principal', path: 'automatic' }));
  assert.equal(queuedDirectory.status, 'pending_approval');
  const enabled = await adminRequest('/admin/settings', 'PATCH', runtime.store.secrets.adminToken, { approvalMode: 'automatic' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.approvals.approved, 1);
  assert.equal(jsonText(await callTool('bridge_status', {})).approvalMode, 'automatic');
  const directory = jsonText(await callTool('bridge_job', { jobId: queuedDirectory.jobId, waitMs: 25_000 }));
  assert.equal(directory.status, 'succeeded');
  assert.equal(directory.approval, 'automatic');
  const automaticWrite = jsonText(await callTool('local_write_file', {
    projectId: 'principal', path: 'automatic/result.txt', content: 'Modo automático confirmado.', expectedHash: null,
  }));
  assert.equal(automaticWrite.status, 'succeeded');
  assert.equal(automaticWrite.approval, 'automatic');
  assert.equal(await readFile(path.join(workspace, 'automatic', 'result.txt'), 'utf8'), 'Modo automático confirmado.');
  assert.equal((await adminRequest('/admin/settings', 'PATCH', runtime.store.secrets.adminToken, { approvalMode: 'mutations' })).status, 200);
  const manualAgain = jsonText(await callTool('local_create_directory', { projectId: 'principal', path: 'manual-again' }));
  assert.equal(manualAgain.status, 'pending_approval');
  assert.equal((await adminRequest(`/admin/jobs/${manualAgain.jobId}/reject`, 'POST')).status, 200);
  log('OK: modo automático libera pendência e nova escrita; retorno ao modo manual exige revisão novamente.');

  stage = 'descobrir MCP 2.0 e entregar evento de conclusão assinado';
  const modern = async (method, params = {}) => {
    const response = await localFetch(issuer + '/mcp', {
      method: 'POST', headers: { Authorization: 'Bearer ' + oauthTokens.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined);
    assert.equal(body.result.resultType, 'complete');
    return body.result;
  };
  const discovery = await modern('server/discover');
  assert.ok(discovery.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(discovery.capabilities.events, {});
  assert.equal((await modern('events/list')).events[0].name, 'ponte.job.completed');
  const watched = jsonText(await callTool('local_create_directory', { projectId: 'principal', path: 'event-completed' }));
  assert.equal(watched.status, 'pending_approval');
  const subscriptionParams = { name: 'ponte.job.completed', arguments: { jobId: watched.jobId }, delivery: { mode: 'webhook', url: 'https://receiver.example/compiled-smoke', secret: eventSecret } };
  const subscribed = await modern('events/subscribe', subscriptionParams);
  assert.ok(subscribed.id);
  assert.equal(deliveries.length, 0);
  assert.equal((await adminRequest(`/admin/jobs/${watched.jobId}/approve`, 'POST')).status, 200);
  assert.equal(jsonText(await completed(await callTool('bridge_job', { jobId: watched.jobId }))).status, 'succeeded');
  await runtime.events.flush();
  await runtime.events.pump();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].data.jobId, watched.jobId);
  assert.equal(deliveries[0].data.status, 'succeeded');
  await modern('events/unsubscribe', { ...subscriptionParams, delivery: { mode: 'webhook', url: subscriptionParams.delivery.url } });
  assert.equal(runtime.events.snapshot().subscriptionCount, 0);
  log('OK: MCP 2.0, assinatura de evento, desafio, HMAC, entrega única e encerramento com receptor controlado.');

  stage = 'renovar e revogar a conexão OAuth';
  const oldRefresh = oauthTokens.refresh_token;
  assert.equal(await auth(oauth, { serverUrl: issuer + '/mcp', fetchFn: localFetch }), 'AUTHORIZED');
  assert.notEqual(oauthTokens.refresh_token, oldRefresh, 'A renovação deve rotacionar o refresh token.');
  const current = await adminRequest('/admin/state');
  const grantId = current.body.connection.oauth.grants[0].id;
  assert.equal((await adminRequest('/admin/oauth/grants/' + grantId + '/revoke', 'POST')).status, 200);
  const revoked = await localFetch(issuer + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + oauthTokens.access_token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(revoked.status, 401);
  log('OK: renovação com rotação e bloqueio do token após revogação local.');
} catch (error) {
  failure = error;
} finally {
  clearTimeout(deadline);
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  // Each cleanup runs even when an earlier cleanup fails. Application.close()
  // cancels outstanding jobs and explicitly closes the HTTP connections.
  for (const cleanup of [
    () => client?.close(),
    () => runtime?.close(),
    () => temporaryRoot && rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  ]) {
    try { await cleanup(); }
    catch (error) { if (!failure) { stage = 'limpar recursos temporários'; failure = error; } }
  }
}

if (failure) {
  let message = failure instanceof Error ? failure.message : 'Falha desconhecida.';
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  message = message.replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer [REDACTED]');
  writeSync(2, `Smoke falhou ao ${stage}: ${message}\n`);
  process.exitCode = 1;
} else {
  log('Smoke concluído com sucesso; conexões e temporários removidos.');
}
