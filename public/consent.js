'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const requestId = new URLSearchParams(location.search).get('request');
  const startedAt = Date.now();
  const maximumWaitMs = 10 * 60 * 1000;
  let timer;
  let expiresAt = startedAt + maximumWaitMs;
  let stopped = false;
  let loaded = false;
  let polling = false;

  class StatusError extends Error {
    constructor(kind, status) {
      super(kind);
      this.status = status;
    }
  }

  function showStatus(state, title, description) {
    $('#consent-status').dataset.state = state;
    $('#status-title').textContent = title;
    $('#status-description').textContent = description;
  }

  function showRetryError(error, timedOut) {
    let title = 'Não foi possível consultar a Ponte';
    let description = 'Falha de rede. Confira sua conexão, o processo da Ponte e o túnel.';
    if (timedOut) {
      title = 'A Ponte demorou para responder';
      description = 'A consulta excedeu o tempo de espera. Confira se a Ponte e o túnel estão em execução.';
    } else if (error instanceof StatusError) {
      if (error.message === 'http') {
        title = `Falha ao consultar a Ponte: HTTP ${error.status}`;
        description = 'A API ou o túnel recusou a consulta. Confira o serviço e a URL pública configurada no painel.';
      } else if (error.message === 'non-json') {
        title = 'O túnel devolveu uma página inesperada';
        description = 'A consulta recebeu HTML ou outro conteúdo em vez de JSON. Confira o aviso do ngrok, a URL pública e o encaminhamento para a porta da API.';
      } else {
        title = 'Resposta inválida da Ponte';
        description = 'Os dados da solicitação não puderam ser lidos. Confira se a URL pública aponta para a instância atualizada da Ponte.';
      }
    }
    if (!loaded) {
      $('#verification-code').textContent = '—';
      $('#verification-code').classList.remove('is-loading');
    }
    showStatus('waiting', title, `${description} Tentaremos novamente em instantes.`);
  }

  function finish(state, title, description) {
    stopped = true;
    clearTimeout(timer);
    showStatus(state, title, description);
    $('#terminal-help').hidden = false;
    $('#open-dashboard').hidden = true;
    if (!loaded) {
      $('#verification-code').textContent = '—';
      $('#verification-code').classList.remove('is-loading');
    }
  }

  function setDashboard(value) {
    if (!value) return;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) return;
      url.pathname = '/';
      url.search = '';
      url.hash = 'connect';
      $('#open-dashboard').href = url.href;
      $('#open-dashboard').hidden = false;
      $('#dashboard-address').textContent = url.href;
      $('#dashboard-address').hidden = false;
    } catch { /* Sem URL local válida, a instrução manual continua disponível. */ }
  }

  function renderRequest(item, adminUrl) {
    if (!item || item.id !== requestId || typeof item.verificationCode !== 'string' || !item.verificationCode) throw new StatusError('invalid-request');
    const seconds = Number(item.expiresAt);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new StatusError('invalid-expiry');
    expiresAt = Math.min(seconds * 1000, startedAt + maximumWaitMs);
    $('#verification-code').textContent = item.verificationCode;
    $('#verification-code').classList.remove('is-loading');
    $('#client-name').textContent = item.clientName || 'Cliente sem nome';
    let origin = 'Não informada';
    try {
      const callback = new URL(item.redirectUri);
      origin = callback.origin === 'null' ? callback.protocol : callback.origin;
    } catch { /* Exiba um rótulo explícito, sem criar links de retorno. */ }
    $('#callback-origin').textContent = origin;
    $('#requested-scopes').textContent = Array.isArray(item.scopes) ? item.scopes.join(', ') : 'Não informado';
    $('#request-expiry').textContent = new Date(seconds * 1000).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    $('#request-information').hidden = false;
    setDashboard(adminUrl);
    loaded = true;
  }

  async function poll() {
    if (stopped || polling) return;
    if (Date.now() >= expiresAt) {
      finish('expired', 'O prazo de confirmação terminou', 'Esta página parou de aguardar a autorização. Inicie uma nova conexão no cliente.');
      return;
    }
    polling = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(10000, expiresAt - Date.now())));
    try {
      const response = await fetch(`/oauth/consent/status?request=${encodeURIComponent(requestId)}`, {
        // Preserve the tunnel's visitor cookie and request JSON past ngrok's browser warning.
        headers: { Accept: 'application/json', 'ngrok-skip-browser-warning': '1' },
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal
      });
      if (response.status === 404) {
        finish('error', 'Solicitação indisponível', 'O pedido não foi encontrado ou seu prazo já terminou.');
        return;
      }
      if (!response.ok) throw new StatusError('http', response.status);
      const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new StatusError('non-json');
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (error?.name === 'SyntaxError') throw new StatusError('invalid-json');
        throw error;
      }
      if (!data || !['pending', 'approved', 'rejected', 'expired'].includes(data.status)) throw new StatusError('invalid-status');
      if (data.status === 'approved' || data.status === 'rejected') {
        stopped = true;
        clearTimeout(timer);
        showStatus(data.status,
          data.status === 'approved' ? 'Conexão autorizada' : 'Conexão recusada',
          'Retornando ao cliente para concluir a solicitação…');
        location.replace(`/oauth/complete?request=${encodeURIComponent(requestId)}`);
        return;
      }
      if (data.status === 'expired') {
        finish('expired', 'Solicitação expirada', 'O prazo para confirmar este código terminou.');
        return;
      }
      renderRequest(data.request, data.adminUrl);
      if (Date.now() >= expiresAt) {
        finish('expired', 'Solicitação expirada', 'O prazo para confirmar este código terminou.');
        return;
      }
      showStatus('pending', 'Aguardando sua decisão no painel local', 'Depois de autorizar ou recusar, esta página retornará ao cliente automaticamente.');
    } catch (error) {
      if (Date.now() >= expiresAt) finish('expired', 'O prazo de confirmação terminou', 'Inicie uma nova conexão no cliente para tentar novamente.');
      else showRetryError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
      polling = false;
      if (!stopped) timer = setTimeout(poll, Math.min(2000, Math.max(0, expiresAt - Date.now())));
    }
  }

  $('#verification-code').classList.add('is-loading');
  if (!requestId || requestId.length > 1024) {
    finish('error', 'Link de autorização inválido', 'Abra a autorização a partir da configuração de conexão do cliente.');
  } else {
    void poll();
  }
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
})();
