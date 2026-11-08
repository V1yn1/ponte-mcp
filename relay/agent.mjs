import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REQUEST_LIMIT, RESPONSE_LIMIT, UUID, validateToken, relayOrigin, allowedRoute,
  filterHeaders, decodeBody, readResponse, transportFailure } from './protocol.mjs';

/** Outbound-only companion. It does not read, inject or manage Ponte admin/API credentials. */
export async function startAgent({ relayUrl, token, apiPort = 4318, workers = 4, heartbeatMs = 10000,
  localTimeoutMs = 55000, log = () => {} } = {}) {
  validateToken(token);
  const origin = relayOrigin(relayUrl);
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || apiPort === 4317) throw new Error('Use a porta da API da Ponte, nunca a porta administrativa 4317.');
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('Use de 1 a 4 workers.');
  const localOrigin = `http://127.0.0.1:${apiPort}`;
  const controller = new AbortController();
  const signal = controller.signal;
  const agentId = randomUUID();
  const headers = { authorization: `Bearer ${token}`, 'x-ponte-agent-id': agentId };
  let connecting, disconnected = false;
  const sleep = ms => delay(ms, undefined, { signal });
  async function api(route, method = 'GET', body, timeoutMs = 30000) {
    return fetch(origin + route, { method, redirect: 'error', headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  }
  async function verifyLocal() {
    let response;
    try { response = await fetch(localOrigin + '/.well-known/oauth-authorization-server', { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }); }
    catch { throw new Error('A API local não respondeu. Inicie a Ponte e confira sua porta.'); }
    let metadata;
    try { metadata = JSON.parse((await readResponse(response, 32768)).toString()); }
    catch { throw new Error('A porta local não forneceu a descoberta OAuth esperada. Confira a API, não o painel.'); }
    if (!response.ok || metadata.issuer !== origin) throw new Error('Salve a origem do relay em Conectar IA → URL pública da API. A origem OAuth local precisa coincidir com a Render.');
  }
  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      await verifyLocal();
      const response = await api('/relay/connect', 'POST', undefined, 90000);
      await response.body?.cancel();
      if (!response.ok) {
        const error = new Error(response.status === 401 ? 'O relay recusou o segredo do agente.' : response.status === 409 ? 'Outro agente já está conectado a este relay.' : 'O relay não aceitou a conexão.');
        error.fatal = response.status === 401; throw error;
      }
      disconnected = false; log('Agente conectado ao relay.');
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  async function recover(error) {
    if (signal.aborted) return;
    if (error.fatal) { log('A credencial do agente foi recusada. Atualize a configuração local e reinicie.'); controller.abort(); return; }
    if (!disconnected) { disconnected = true; log('Canal interrompido; tentando reconectar sem repetir ferramentas.'); }
    await sleep(1000 + Math.floor(Math.random() * 1000));
  }
  function failure(error, sent) {
    return { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(transportFailure(error, sent))).toString('base64') };
  }
  async function forward(job) {
    let sent = false;
    try {
      if (!allowedRoute(job.method, job.path)) return failure('blocked_route', false);
      const body = decodeBody(job.body, REQUEST_LIMIT);
      if (job.method !== 'POST' && body.length) return failure('invalid_body', false);
      const forwarded = filterHeaders(job.headers, 'request');
      sent = true;
      // One fetch only. Redirects belong to the caller, never to this local agent.
      const response = await fetch(localOrigin + job.path, { method: job.method, headers: { ...forwarded, 'accept-encoding': 'identity' },
        redirect: 'manual', ...(job.method === 'POST' ? { body } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(localTimeoutMs)]) });
      return { status: response.status, headers: filterHeaders(Object.fromEntries(response.headers), 'response'),
        body: (await readResponse(response, RESPONSE_LIMIT)).toString('base64') };
    } catch { return failure(sent ? 'local_response_uncertain' : 'invalid_relay_request', sent); }
  }
  async function deliver(id, value) {
    // Retrying the result is safe; retrying the original tool is not.
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      try {
        const response = await api('/relay/results/' + id, 'POST', value, 15000);
        await response.body?.cancel();
        if (response.ok || response.status === 410) return;
        if (response.status === 401) { const error = new Error('Unauthorized'); error.fatal = true; await recover(error); return; }
        if (response.status !== 409 && response.status < 500) return;
      } catch { if (signal.aborted) return; }
      await sleep(500 * (attempt + 1));
    }
    if (!signal.aborted) log('O resultado não pôde ser entregue. A operação local NÃO será repetida.');
  }
  async function worker() {
    while (!signal.aborted) {
      try {
        const response = await api('/relay/poll');
        if (response.status === 204) continue;
        if (response.status === 409) { await response.body?.cancel(); await connect(); continue; }
        if (!response.ok) { await response.body?.cancel(); const error = new Error('Relay indisponível'); error.fatal = response.status === 401; throw error; }
        const job = JSON.parse((await readResponse(response, Math.ceil(REQUEST_LIMIT * 4 / 3) + 32768)).toString());
        if (!job || typeof job.id !== 'string' || !UUID.test(job.id)) throw new Error('Envelope inválido');
        const value = await forward(job);
        await deliver(job.id, value);
      } catch (error) { await recover(error); }
    }
  }
  async function heartbeat() {
    while (!signal.aborted) {
      await sleep(heartbeatMs);
      try {
        const response = await api('/relay/heartbeat', 'POST', undefined, 5000);
        await response.body?.cancel();
        if (response.status === 409) await connect();
        else if (!response.ok) { const error = new Error('Heartbeat indisponível'); error.fatal = response.status === 401; throw error; }
      } catch (error) { await recover(error); }
    }
  }
  await connect();
  const done = Promise.allSettled([...Array.from({ length: workers }, worker), heartbeat()]);
  return { done, async close() {
    if (signal.aborted) { await done; return; }
    controller.abort();
    try {
      const response = await fetch(origin + '/relay/disconnect', { method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
    } catch { /* The lease expires even when the relay is offline. */ }
    await done;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { 'state-dir': { type: 'string' } } });
    const stateDir = path.resolve(values['state-dir'] || process.env.PONTE_STATE_DIR || '.ponte');
    let settings, core;
    try {
      settings = JSON.parse(await readFile(path.join(stateDir, 'relay-client.json'), 'utf8'));
      core = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
    } catch { throw new Error('Leia relay/README.md e configure .ponte/relay-client.json no diretório da instalação. O agente nunca usa o token admin.'); }
    const agent = await startAgent({ relayUrl: settings.relayUrl, token: settings.relayToken, apiPort: core.apiPort,
      log: message => console.log(message) });
    for (const sign of ['SIGINT', 'SIGTERM']) process.once(sign, () => { void agent.close(); });
    await agent.done;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
