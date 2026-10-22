#!/usr/bin/env node
// Standalone producer: Node >=22.12, built-ins only. Never infer task completion.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

class NotifyError extends Error {}

function input() {
  const options = new Map();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--status', '--summary', '--exit-code'].includes(flag) || value === undefined || options.has(flag)) {
      throw new NotifyError('use --status succeeded|failed|needs_input --summary TEXT [--exit-code INTEGER].');
    }
    options.set(flag, value);
  }
  const status = options.get('--status');
  const summary = options.get('--summary');
  if (!['succeeded', 'failed', 'needs_input'].includes(status) || !summary?.trim()) {
    throw new NotifyError('status válido e resumo explícito são obrigatórios.');
  }
  const runId = process.env.PONTE_WATCH_RUN_ID;
  if (!runId?.trim() || runId.length > 128 || /[\x00-\x1f\x7f]/.test(runId)) {
    throw new NotifyError('PONTE_WATCH_RUN_ID deve ter entre 1 e 128 caracteres, sem controles.');
  }
  const token = process.env.PONTE_WATCH_TOKEN;
  if (!token || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new NotifyError('PONTE_WATCH_TOKEN ausente ou inválido.');
  }
  const rawUrl = process.env.PONTE_WATCH_URL;
  let url;
  try { url = new URL(rawUrl); } catch { throw new NotifyError('PONTE_WATCH_URL ausente ou inválida.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (/[?#\x00-\x20\x7f]/.test(rawUrl) || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new NotifyError('PONTE_WATCH_URL exige HTTPS ou HTTP loopback, sem credenciais, query ou fragmento.');
  }
  const event = { eventId: randomUUID(), runId, status, summary };
  if (options.has('--exit-code')) {
    const value = options.get('--exit-code');
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new NotifyError('--exit-code deve ser um inteiro seguro.');
    }
    event.exitCode = Number(value);
  }
  // Serialize exactly once: every retry must carry the same eventId and bytes.
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body, 'utf8') > 32 * 1024) {
    throw new NotifyError('o sinal excede o limite de 32 KiB.');
  }
  return { url, token, body };
}

function transientNetworkError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
      'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']
      .includes(error?.cause?.code ?? error?.code);
}

async function notify({ url, token, body }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      });
    } catch (error) {
      if (!transientNetworkError(error) || attempt === 2) {
        throw new NotifyError('falha de rede ou timeout ao entregar o sinal.');
      }
      await delay(200 * 2 ** attempt);
      continue;
    }
    // The status is sufficient. Do not read, log or buffer an untrusted response.
    await response.body?.cancel();
    if (response.ok) return;
    const transient = response.status === 408 || response.status === 429 || response.status >= 500;
    if (!transient || attempt === 2) {
      throw new NotifyError(`sinal não confirmado (HTTP ${response.status}).`);
    }
    await delay(200 * 2 ** attempt);
  }
}

try {
  await notify(input());
  process.stdout.write('Sinal confirmado pela Ponte.\n');
} catch (error) {
  // Never print raw exceptions: fetch errors may contain URLs or credentials.
  process.stderr.write(`ponte-watch-notify: ${error instanceof NotifyError ? error.message : 'não foi possível entregar o sinal.'}\n`);
  process.exitCode = 1;
}
