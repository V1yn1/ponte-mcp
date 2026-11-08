import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { REQUEST_LIMIT, RESPONSE_LIMIT, ENVELOPE_LIMIT, UUID, HttpError, validateToken, authorized,
  allowedRoute, filterHeaders, decodeBody, readRequest, sendJson, transportFailure } from './protocol.mjs';

/** One private relay instance per PC. No tool requests survive an instance restart. */
export function createRelay({ token, pollMs = 20000, leaseMs = 45000, requestMs = 65000, maxPending = 16 } = {}) {
  validateToken(token);
  const pending = new Map();
  const queue = [];
  const pollers = new Set();
  let owner = null, lastSeen = 0, receiving = 0, stopped = false;
  let rateStart = Date.now(), rate = 0;
  const online = () => Boolean(owner && Date.now() - lastSeen < leaseMs);
  const remove = entry => {
    clearTimeout(entry.timer); pending.delete(entry.id);
    const index = queue.indexOf(entry.id); if (index !== -1) queue.splice(index, 1);
  };
  const failPending = reason => {
    for (const entry of [...pending.values()]) {
      remove(entry); sendJson(entry.res, 503, transportFailure(reason, entry.sent));
    }
    for (const waiter of [...pollers]) { waiter.cleanup(); sendJson(waiter.res, 409, { error: 'agent_session_required' }); }
  };
  const dispatch = () => {
    while (queue.length && pollers.size) {
      const entry = pending.get(queue.shift()); if (!entry || entry.res.destroyed) continue;
      const waiter = pollers.values().next().value; waiter.cleanup();
      if (waiter.res.destroyed) { queue.unshift(entry.id); continue; }
      entry.sent = true;
      sendJson(waiter.res, 200, { id: entry.id, method: entry.method, path: entry.path, headers: entry.headers, body: entry.body });
    }
  };
  const handle = async (req, res) => {
    if (stopped) { sendJson(res, 503, transportFailure('relay_shutting_down')); return; }
    const raw = req.url ?? '';
    if ((req.method === 'GET' || req.method === 'HEAD') && (raw === '/healthz' || raw === '/')) {
      sendJson(res, 200, { name: 'Ponte Cloud Relay', version: '0.1.0', pcOnline: online(), endpoint: '/mcp', mode: 'single-pc', adminExposed: false }); return;
    }
    if (Date.now() - rateStart >= 60000) { rateStart = Date.now(); rate = 0; }
    // Authenticate internal channels before public rate limiting; strangers cannot consume agent leases.
    if (raw.startsWith('/relay/')) {
      if (!authorized(req.headers.authorization, token) || req.headers.origin) {
        sendJson(res, 401, { error: 'unauthorized' }); return;
      }
      const agentId = req.headers['x-ponte-agent-id'];
      if (typeof agentId !== 'string' || !UUID.test(agentId)) throw new HttpError(400, 'Identidade do agente inválida.');
      if (raw === '/relay/connect' && req.method === 'POST') {
        if (online() && owner !== agentId) { sendJson(res, 409, { error: 'another_agent_connected' }); return; }
        if (owner !== agentId || !online()) failPending('agent_reconnected');
        owner = agentId; lastSeen = Date.now(); sendJson(res, 200, { connected: true }); return;
      }
      if (!online() || owner !== agentId) { sendJson(res, 409, { error: 'agent_session_required' }); return; }
      lastSeen = Date.now();
      if (raw === '/relay/heartbeat' && req.method === 'POST') { sendJson(res, 200, { connected: true }); return; }
      if (raw === '/relay/disconnect' && req.method === 'POST') {
        owner = null; failPending('agent_disconnected'); sendJson(res, 200, { connected: false }); return;
      }
      if (raw === '/relay/poll' && req.method === 'GET') {
        if (pollers.size >= 8) { sendJson(res, 429, { error: 'too_many_pollers' }); return; }
        const waiter = { res, cleanup: () => { clearTimeout(timer); pollers.delete(waiter); res.off('close', waiter.cleanup); } };
        const timer = setTimeout(() => { waiter.cleanup(); if (!res.destroyed) { res.writeHead(204); res.end(); } }, pollMs);
        timer.unref(); res.once('close', waiter.cleanup); pollers.add(waiter); dispatch(); return;
      }
      const resultId = raw.startsWith('/relay/results/') ? raw.slice('/relay/results/'.length) : '';
      if (req.method === 'POST' && UUID.test(resultId)) {
        const entry = pending.get(resultId);
        if (!entry?.sent) { sendJson(res, 410, { error: 'request_no_longer_pending' }); return; }
        if (entry.receiving) { sendJson(res, 409, { error: 'result_in_progress' }); return; }
        entry.receiving = true;
        try {
          const value = JSON.parse((await readRequest(req, ENVELOPE_LIMIT)).toString('utf8'));
          if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw new HttpError(400, 'Status inválido.');
          const body = decodeBody(value.body, RESPONSE_LIMIT);
          const responseHeaders = filterHeaders(value.headers, 'response');
          if (!pending.has(resultId) || owner !== agentId || !online()) { sendJson(res, 410, { error: 'request_no_longer_pending' }); return; }
          remove(entry);
          if (!entry.res.destroyed) { entry.res.writeHead(value.status, { ...responseHeaders, 'cache-control': 'no-store' }); entry.res.end(body); }
          sendJson(res, 200, { delivered: true });
        } finally { entry.receiving = false; }
        return;
      }
      sendJson(res, 404, { error: 'not_found' }); return;
    }
    if (++rate > 1200) { sendJson(res, 429, transportFailure('rate_limited')); return; }
    if (!allowedRoute(req.method, raw)) { sendJson(res, 404, { error: 'not_found' }); return; }
    if (!online()) { sendJson(res, 503, transportFailure('pc_offline')); return; }
    if (pending.size + receiving >= maxPending) { sendJson(res, 429, transportFailure('relay_busy')); return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Corpos comprimidos não são aceitos pelo relay.');
    const requestHeaders = filterHeaders(req.headers, 'request');
    const currentOwner = owner;
    receiving++;
    let body;
    try { body = await readRequest(req, REQUEST_LIMIT); } finally { receiving--; }
    if (res.destroyed) return;
    if (!online() || owner !== currentOwner) { sendJson(res, 503, transportFailure('pc_offline')); return; }
    const entry = { id: randomUUID(), res, method: req.method, path: raw, headers: requestHeaders, body: body.toString('base64'), sent: false };
    entry.timer = setTimeout(() => { remove(entry); sendJson(res, 504, transportFailure('relay_timeout', entry.sent)); }, requestMs);
    entry.timer.unref(); pending.set(entry.id, entry); queue.push(entry.id);
    res.once('close', () => remove(entry)); dispatch();
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      sendJson(res, error instanceof HttpError ? error.status : 400, { error: error instanceof HttpError ? error.message : 'invalid_request' });
    });
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 64; server.maxConnections = 128;
  return { server, async close() {
    stopped = true; owner = null; failPending('relay_restarted');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.PORT || 10000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
    const relay = createRelay({ token: process.env.PONTE_RELAY_TOKEN });
    relay.server.on('error', () => { console.error('Não foi possível iniciar o relay. Confira a porta.'); process.exitCode = 1; });
    relay.server.listen(port, '0.0.0.0', () => console.log('Ponte Cloud Relay iniciado. Aguardando o agente local.'));
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (!closing) { closing = true; void relay.close(); } });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
