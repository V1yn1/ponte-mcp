'use strict';

(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const pretty = value => JSON.stringify(value ?? {}, null, 2);
  const number = value => Math.max(0, Number(value) || 0).toLocaleString('pt-BR');
  const markup = new WeakMap();
  const TOKEN_KEY = 'ponte-mcp.admin-session';
  const views = {
    overview: { title: 'Visão geral', eyebrow: 'SEU CENTRO DE CONTROLE', description: 'Conecte ferramentas. Revise ações. Acompanhe o que acontece.' },
    projects: { title: 'Projetos', eyebrow: 'SEU AMBIENTE DE TRABALHO', description: 'Escolha onde sua ponte pode ler, escrever e executar.' },
    connections: { title: 'Conexões MCP', eyebrow: 'FERRAMENTAS, CONECTADAS', description: 'Seus servidores MCP, reunidos em uma única ponte.' },
    tools: { title: 'Ferramentas', eyebrow: 'EXPLORE E EXPERIMENTE', description: 'Inspecione parâmetros e envie solicitações com contexto.' },
    jobs: { title: 'Execuções', eyebrow: 'CADA AÇÃO, VISÍVEL', description: 'Revise solicitações e acompanhe o resultado de cada execução.' },
    connect: { title: 'Conectar ChatGPT', eyebrow: 'SEU CHAT, SUAS FERRAMENTAS', description: 'Configure o OAuth, revise conexões e controle o acesso ao seu ambiente.' }
  };
  const statuses = {
    pending_approval: ['Aguardando aprovação', 'warning', 'clock'],
    queued: ['Na fila', 'neutral', 'clock'],
    running: ['Em execução', 'blue', 'activity'],
    succeeded: ['Concluída', 'success', 'check'],
    failed: ['Falhou', 'danger', 'close'],
    rejected: ['Recusada', 'neutral', 'close'],
    cancelled: ['Cancelada', 'neutral', 'close'],
    expired: ['Expirada', 'neutral', 'clock']
  };
  const serverStatuses = {
    connected: ['Conectado', 'success'],
    connecting: ['Conectando', 'warning'],
    disabled: ['Desativado', 'neutral'],
    error: ['Erro de conexão', 'danger']
  };
  const risks = {
    read: ['Leitura', 'neutral', 'folder'],
    write: ['Escrita', 'warning', 'edit'],
    execute: ['Execução', 'warning', 'terminal']
  };
  const app = {
    token: '', state: null, tools: [], view: 'overview', offline: false,
    refreshing: false, refreshQueued: false, refreshToolsQueued: false, toolsLoading: false, selectedTool: null, jobId: null,
    jobLoading: false, job: null, jobActions: new Set(), publicUrlDirty: false,
    serverEditing: false, confirmResolve: null, navOpen: false, lastSync: null,
    pendingToken: '', sessionGeneration: 0, serverOriginalUrl: '',
    oauthRequestId: null, oauthRequestSnapshot: '', oauthActions: new Set()
  };

  function badge(label, variant = 'neutral', iconName) {
    return `<span class="badge badge-${variant}">${iconName ? icon(iconName) : ''}${escape(label)}</span>`;
  }

  function statusBadge(status) {
    const [label, variant, iconName] = statuses[status] || [status || 'Desconhecido', 'neutral', 'info'];
    return badge(label, variant, iconName);
  }

  function riskBadge(risk) {
    const [label, variant, iconName] = risks[risk] || ['Revisão necessária', 'warning', 'shield'];
    return badge(label, variant, iconName);
  }

  function dateLabel(value, full = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('pt-BR', full
      ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function relativeTime(value) {
    const date = new Date(value).getTime();
    if (!Number.isFinite(date)) return '—';
    const minutes = Math.max(0, Math.floor((Date.now() - date) / 60000));
    if (minutes < 1) return 'Agora';
    if (minutes < 60) return `Há ${minutes} min`;
    if (minutes < 1440) return `Há ${Math.floor(minutes / 60)} h`;
    return dateLabel(value);
  }

  function replaceMarkup(element, html) {
    if (!element || markup.get(element) === html) return;
    const active = document.activeElement;
    const activeKey = element.contains(active) && active instanceof HTMLElement
      ? { action: active.dataset.action, id: active.dataset.id, tool: active.dataset.tool } : null;
    element.innerHTML = html;
    markup.set(element, html);
    if (activeKey?.action) {
      const replacement = $$('[data-action]', element).find(node => node.dataset.action === activeKey.action && node.dataset.id === activeKey.id && node.dataset.tool === activeKey.tool);
      replacement?.focus({ preventScroll: true });
    }
  }

  function emptyState(iconName, title, description, actionHtml = '', compact = false) {
    return `<div class="empty-state${compact ? ' compact' : ''}"><span class="empty-icon">${icon(iconName)}</span><h3>${escape(title)}</h3><p>${escape(description)}</p>${actionHtml}</div>`;
  }

  function toast(message, error = false) {
    const element = document.createElement('div');
    element.className = `toast${error ? ' error' : ''}`;
    element.innerHTML = `${icon(error ? 'info' : 'check')}<span>${escape(message)}</span><button class="icon-button" type="button" aria-label="Dispensar aviso">${icon('close')}</button>`;
    $('button', element).addEventListener('click', () => element.remove());
    $('#toast-container').append(element);
    setTimeout(() => element.remove(), error ? 9000 : 5000);
  }

  function showFormError(id, message = '') {
    const node = $(id);
    node.textContent = message;
    node.hidden = !message;
  }

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function request(path, { method = 'GET', body, token = app.token, timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new ApiError(data?.error || `A solicitação falhou (HTTP ${response.status}).`, response.status);
      if (data === null) throw new ApiError('O serviço retornou uma resposta inválida.', response.status);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('O serviço demorou para responder. Tente novamente.', 0);
      if (error instanceof TypeError) throw new ApiError('Não foi possível alcançar a ponte. Verifique se o serviço está em execução.', 0);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function handleError(error, formId) {
    if (error.status === 401 || error.status === 403) {
      lock('Sua sessão não foi autorizada. Informe um token de administração válido.');
      return;
    }
    if (formId) showFormError(formId, error.message || 'Não foi possível concluir a solicitação.');
    else toast(error.message || 'Não foi possível concluir a solicitação.', true);
  }

  function rememberToken(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* A sessão ainda funciona em memória quando o armazenamento está indisponível. */ }
  }

  function lock(message = '') {
    app.sessionGeneration += 1;
    app.token = '';
    app.pendingToken = '';
    app.state = null;
    app.tools = [];
    app.selectedTool = null;
    app.jobId = null;
    app.job = null;
    app.oauthRequestId = null;
    app.oauthRequestSnapshot = '';
    app.publicUrlDirty = false;
    app.refreshQueued = false;
    app.refreshToolsQueued = false;
    $('#tool-search').value = '';
    $('#tool-risk-filter').value = 'all';
    $('#job-search').value = '';
    $('#job-status-filter').value = 'all';
    replaceMarkup($('#tool-detail'), '<div class="empty-state tall"><span class="empty-icon">' + icon('tool') + '</span><h3>Explore suas ferramentas.</h3><p>Selecione uma ferramenta para ver os parâmetros e enviar uma solicitação.</p></div>');
    rememberToken('');
    $$('dialog[open]').forEach(dialog => dialog.close());
    $('#workspace').hidden = true;
    $('#auth-screen').hidden = false;
    $('#admin-token').value = '';
    showFormError('#login-error', message);
    document.title = 'Ponte MCP — Painel local';
    closeNavigation(false);
    $('#admin-token').focus({ preventScroll: true });
  }

  async function authenticate(token) {
    const button = $('#login-form button[type=submit]');
    button.disabled = true;
    showFormError('#login-error');
    app.pendingToken = token;
    const generation = app.sessionGeneration;
    try {
      const state = await request('/admin/state', { token });
      if (app.pendingToken !== token || generation !== app.sessionGeneration) return;
      app.token = token;
      app.pendingToken = '';
      app.state = state;
      app.offline = false;
      app.lastSync = new Date();
      rememberToken(token);
      $('#admin-token').value = '';
      $('#auth-screen').hidden = true;
      $('#workspace').hidden = false;
      renderState();
      navigate(routeFromHash(), false);
      await refreshTools();
    } catch (error) {
      if (generation !== app.sessionGeneration) return;
      app.pendingToken = '';
      rememberToken('');
      showFormError('#login-error', error.status === 401 || error.status === 403
        ? 'Token inválido ou sem permissão de administração. Confira e tente novamente.' : error.message);
      $('#admin-token').focus();
    } finally {
      button.disabled = false;
    }
  }

  async function refresh({ tools = false, silent = true } = {}) {
    if (!app.token) return;
    if (app.refreshing) {
      app.refreshQueued = true;
      app.refreshToolsQueued ||= tools;
      return;
    }
    app.refreshing = true;
    const token = app.token;
    const generation = app.sessionGeneration;
    const refreshIcon = $('#refresh-button .icon');
    if (!silent) refreshIcon.classList.add('busy-spin');
    try {
      const previousTools = app.state?.stats?.tools;
      const previousServers = JSON.stringify(app.state?.servers?.map(server => [server.id, server.status, server.toolCount]));
      const state = await request('/admin/state');
      if (token !== app.token || generation !== app.sessionGeneration) return;
      app.state = state;
      app.offline = false;
      app.lastSync = new Date();
      renderState();
      const serversChanged = previousServers !== JSON.stringify(state.servers?.map(server => [server.id, server.status, server.toolCount]));
      if (tools || previousTools !== state.stats?.tools || serversChanged) await refreshTools();
      if ($('#job-dialog').open && app.jobId) {
        const latest = state.jobs?.find(job => job.id === app.jobId);
        if (!app.job || !latest || ['pending_approval', 'queued', 'running'].includes(app.job.status) || app.job.updatedAt !== latest.updatedAt) {
          await refreshJob(true);
        }
      }
    } catch (error) {
      if (token !== app.token || generation !== app.sessionGeneration) return;
      if (error.status === 401 || error.status === 403) handleError(error);
      else {
        app.offline = true;
        updateConnectionStatus();
        $('#offline-banner').textContent = `${error.message} Os dados exibidos são da última sincronização.`;
        $('#offline-banner').hidden = false;
        if (!silent) toast(error.message, true);
      }
    } finally {
      app.refreshing = false;
      refreshIcon.classList.remove('busy-spin');
      if (app.refreshQueued && app.token) {
        const refreshToolsNext = app.refreshToolsQueued;
        app.refreshQueued = false;
        app.refreshToolsQueued = false;
        void refresh({ tools: refreshToolsNext });
      }
    }
  }

  async function refreshTools() {
    if (!app.token || app.toolsLoading) return;
    app.toolsLoading = true;
    const token = app.token;
    try {
      const response = await request('/admin/tools');
      if (token !== app.token) return;
      const previousSelected = app.tools.find(item => item.name === app.selectedTool);
      app.tools = Array.isArray(response.tools) ? response.tools : [];
      renderToolsList();
      if (app.selectedTool) {
        const tool = app.tools.find(item => item.name === app.selectedTool);
        if (!tool) {
          app.selectedTool = null;
          replaceMarkup($('#tool-detail'), emptyState('tool', 'Ferramenta indisponível', 'A conexão mudou. Selecione outra ferramenta no catálogo.'));
        } else if (previousSelected && JSON.stringify(previousSelected) !== JSON.stringify(tool)) {
          selectTool(tool.name, true);
        }
      }
    } catch (error) {
      if (token === app.token) handleError(error);
    } finally {
      app.toolsLoading = false;
    }
  }

  function updateConnectionStatus() {
    const node = $('#connection-status');
    const paused = Boolean(app.state?.paused);
    node.classList.toggle('offline', app.offline);
    node.classList.toggle('paused', paused && !app.offline);
    $('span:last-child', node).textContent = app.offline ? 'Sem conexão' : paused ? 'Ponte pausada' : 'Ponte online';
    $('#offline-banner').hidden = !app.offline;
    $('#paused-banner').hidden = !paused;
    if (!$('#pause-button').disabled) replaceMarkup($('#pause-button'), `${icon(paused ? 'play' : 'pause')}<span>${paused ? 'Retomar execuções' : 'Pausar execuções'}</span>`);
    $('#pause-button').setAttribute('aria-pressed', String(paused));
    $('#pause-button').setAttribute('aria-label', paused ? 'Retomar execuções' : 'Pausar execuções');
    if (app.lastSync) $('#last-updated').textContent = `Sincronizado às ${app.lastSync.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  function renderState() {
    const state = app.state;
    if (!state) return;
    updateConnectionStatus();
    $('#sidebar-version').textContent = `Ponte MCP · v${state.version || '0.2.1'}`;
    $('#nav-project-count').textContent = number(state.config?.projects?.length);
    $('#nav-pending-count').textContent = number(state.stats?.pending);
    $('#nav-pending-count').hidden = !state.stats?.pending;
    const mode = $('#approval-mode');
    if (document.activeElement !== mode && !mode.disabled) mode.value = state.config?.approvalMode || 'mutations';
    $('#approval-mode-help').textContent = state.config?.approvalMode === 'all'
      ? 'Todas as ferramentas, incluindo leituras, aguardam sua aprovação.'
      : 'Leituras podem executar diretamente. Alterações e comandos aguardam sua aprovação.';
    if (!app.publicUrlDirty && document.activeElement !== $('#public-url')) $('#public-url').value = state.config?.publicUrl || '';
    renderOverview();
    renderProjects();
    renderServers();
    renderJobs();
    renderConnect();
    const requestNotice = $('#tool-request-notice');
    if (requestNotice && app.selectedTool) {
      const selected = app.tools.find(tool => tool.name === app.selectedTool);
      const approval = state.config?.approvalMode === 'all' || selected?.risk !== 'read';
      requestNotice.className = `notice ${approval ? 'notice-warning' : 'notice-subtle'} tool-request-notice`;
      replaceMarkup(requestNotice, `${icon(approval ? 'shield' : 'info')}<span>${approval ? 'Esta solicitação passará pela sua aprovação antes de executar.' : 'Esta ferramenta é de leitura e pode executar assim que for enviada.'}</span>`);
    }
  }

  function renderOverview() {
    const { stats = {}, jobs = [], servers = [] } = app.state;
    const metrics = [
      ['Ferramentas disponíveis', stats.tools, 'tool', 'Prontas para receber solicitações'],
      ['Projetos configurados', stats.projects, 'folder', 'Diretórios autorizados'],
      ['Aguardando aprovação', stats.pending, 'shield', stats.pending ? 'Precisam da sua revisão' : 'Nenhuma revisão pendente'],
      ['Em execução', stats.running, 'activity', stats.running ? 'Trabalhos em andamento' : 'Nenhuma execução em andamento']
    ];
    replaceMarkup($('#overview-stats'), metrics.map(([label, value, iconName, foot], index) => `<div class="stat-card${index === 2 && value ? ' stat-attention' : ''}"><div class="stat-label"><span>${label}</span>${icon(iconName)}</div><div class="stat-value">${number(value)}</div><div class="stat-foot"><span class="mini-dot"></span>${foot}</div></div>`).join(''));
    const pending = jobs.filter(job => job.status === 'pending_approval');
    $('#approval-count').textContent = number(stats.pending);
    replaceMarkup($('#approval-list'), pending.length ? pending.slice(0, 4).map(job => `<article class="approval-card"><div class="approval-top"><div class="approval-name"><span class="soft-icon">${icon((risks[job.risk] || risks.execute)[2])}</span><div><h3>${escape(job.tool)}</h3><p>${escape(job.source)} · ${escape(relativeTime(job.createdAt))}</p></div></div>${riskBadge(job.risk)}</div><p class="approval-arguments">Confira os argumentos e a prévia nos detalhes antes de aprovar.</p><div class="approval-actions"><button class="text-link plain-button" data-action="job-detail" data-id="${escape(job.id)}">Revisar detalhes${icon('arrow')}</button><button class="button button-ghost" data-action="reject-job" data-id="${escape(job.id)}">Recusar</button><button class="button button-primary" data-action="approve-job" data-id="${escape(job.id)}">${icon('check')}Aprovar</button></div></article>`).join('')
      : emptyState('check', 'Sua fila está em dia.', 'As solicitações que precisarem da sua aprovação aparecerão aqui.'));
    const recent = [...jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    replaceMarkup($('#recent-activity'), recent.length ? recent.map(job => `<button class="activity-row ${job.status === 'failed' ? 'failed' : ''}" data-action="job-detail" data-id="${escape(job.id)}"><span class="activity-indicator">${icon((statuses[job.status] || statuses.queued)[2])}</span><span class="activity-main"><strong>${escape(job.tool)}</strong><span>${escape(job.source)} · ${escape(String(job.id).slice(0, 12))}</span></span>${statusBadge(job.status)}<time datetime="${escape(job.createdAt)}">${escape(relativeTime(job.createdAt))}</time></button>`).join('')
      : emptyState('activity', 'O primeiro passo começa com você.', 'Envie uma solicitação pelo catálogo ou por um cliente conectado.', '<a href="#tools" class="text-link">Explorar ferramentas' + icon('arrow') + '</a>'));
    replaceMarkup($('#overview-servers'), servers.length ? servers.slice(0, 4).map(server => `<div class="server-mini" data-status="${escape(server.status)}"><span class="server-mini-icon">${icon(server.transport === 'stdio' ? 'terminal' : 'plug')}</span><div><strong>${escape(server.name || server.id)}</strong><p>${escape((serverStatuses[server.status] || ['Indisponível'])[0])} · ${number(server.toolCount)} ferramentas</p></div><span class="status-dot" title="${escape((serverStatuses[server.status] || ['Indisponível'])[0])}"></span></div>`).join('')
      : emptyState('plug', 'Espaço para novas conexões.', 'Adicione um servidor para ampliar suas ferramentas.', '<a href="#connections" class="text-link">Adicionar conexão' + icon('arrow') + '</a>', true));
  }

  function renderProjects() {
    const projects = app.state.config?.projects || [];
    $('#projects-summary').textContent = `${number(projects.length)} ${projects.length === 1 ? 'projeto configurado' : 'projetos configurados'} neste ambiente.`;
    replaceMarkup($('#projects-list'), projects.length ? projects.map(project => `<article class="config-card"><div class="config-card-top"><span class="soft-icon">${icon('folder')}</span><div class="config-card-heading"><h3>${escape(project.name)}</h3><span class="mono">${escape(project.id)}</span></div><div class="card-actions"><button class="icon-button" data-action="edit-project" data-id="${escape(project.id)}" aria-label="Editar projeto ${escape(project.name)}" title="Editar projeto">${icon('edit')}</button><button class="icon-button danger" data-action="delete-project" data-id="${escape(project.id)}" aria-label="Remover projeto ${escape(project.name)}" title="Remover projeto">${icon('trash')}</button></div></div><div class="config-path">${icon('folder')}<code>${escape(project.root)}</code></div><div class="config-card-footer">${badge('Leitura', 'success', 'check')}${badge(project.allowWrite ? 'Escrita habilitada' : 'Sem escrita', project.allowWrite ? 'warning' : 'neutral', project.allowWrite ? 'edit' : 'lock')}${badge(project.allowExec ? 'Comandos habilitados' : 'Sem comandos', project.allowExec ? 'warning' : 'neutral', project.allowExec ? 'terminal' : 'lock')}</div></article>`).join('')
      : emptyState('folder', 'Dê um lugar para suas ideias.', 'Adicione um diretório local para disponibilizar os arquivos do seu projeto às ferramentas da ponte.', `<button class="button button-primary" data-action="new-project">${icon('plus')}Adicionar primeiro projeto</button>`));
  }

  function renderServers() {
    const upstreams = app.state.config?.upstreams || [];
    const servers = app.state.servers || [];
    replaceMarkup($('#servers-list'), upstreams.length ? upstreams.map(config => {
      const server = servers.find(item => item.id === config.id) || {};
      const [statusLabel, statusVariant] = serverStatuses[server.status] || ['Não iniciado', 'neutral'];
      const endpoint = config.transport === 'stdio' ? [config.command, ...(config.args || [])].filter(Boolean).join(' ') : config.url;
      const secretCount = Object.keys(config.env || {}).length + Object.keys(config.headers || {}).length;
      const allowedLabel = Array.isArray(config.allowedTools) ? `${number(config.allowedTools.length)} permitidas` : 'Todas permitidas';
      return `<article class="config-card"><div class="config-card-top"><span class="soft-icon">${icon(config.transport === 'stdio' ? 'terminal' : 'plug')}</span><div class="config-card-heading"><h3>${escape(config.name || config.id)}</h3><span class="mono">${escape(config.id)} · ${escape(config.transport)}</span></div><div class="card-actions"><button class="icon-button" data-action="edit-server" data-id="${escape(config.id)}" aria-label="Editar conexão ${escape(config.name || config.id)}" title="Editar conexão">${icon('edit')}</button><button class="icon-button danger" data-action="delete-server" data-id="${escape(config.id)}" aria-label="Remover conexão ${escape(config.name || config.id)}" title="Remover conexão">${icon('trash')}</button></div></div><div class="config-path">${icon(config.transport === 'stdio' ? 'terminal' : 'plug')}<code>${escape(endpoint || 'Sem endpoint configurado')}</code></div><div class="config-card-footer">${badge(statusLabel, statusVariant)}${badge(`${number(server.toolCount)} ferramentas`, 'neutral')}${secretCount ? badge('Credenciais configuradas', 'neutral', 'lock') : ''}</div><p class="config-description">${number(config.readOnlyTools?.length)} ${config.readOnlyTools?.length === 1 ? 'ferramenta declarada' : 'ferramentas declaradas'} como leitura · ${allowedLabel}</p>${server.error ? `<pre class="server-card-error">${escape(server.error)}</pre>` : ''}<div class="server-card-bottom"><p>${config.enabled === false ? 'Conexão desativada na configuração.' : Array.isArray(config.allowedTools) && !config.allowedTools.length ? 'Nenhuma ferramenta está exposta por esta conexão.' : config.readOnlyTools?.length ? 'Demais ferramentas exigem aprovação.' : 'Todas as ferramentas exigem aprovação.'}</p><button class="button button-secondary" data-action="reconnect-server" data-id="${escape(config.id)}" ${config.enabled === false ? 'disabled' : ''}>${icon('refresh')}Reconectar</button></div></article>`;
    }).join('') : emptyState('plug', 'Sua ponte pode ir além.', 'Conecte um servidor MCP local ou remoto para reunir suas ferramentas neste painel.', `<button class="button button-primary" data-action="new-server">${icon('plus')}Adicionar primeira conexão</button>`));
  }

  function renderToolsList() {
    const query = $('#tool-search').value.trim().toLocaleLowerCase('pt-BR');
    const risk = $('#tool-risk-filter').value;
    const tools = app.tools.filter(tool => (risk === 'all' || tool.risk === risk) && [tool.name, tool.title, tool.description, tool.source].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query)));
    $('#tools-count').textContent = `${number(tools.length)} ${tools.length === 1 ? 'ferramenta' : 'ferramentas'}`;
    replaceMarkup($('#tools-list'), tools.length ? tools.map(tool => `<button class="tool-item" data-action="select-tool" data-tool="${escape(tool.name)}" aria-pressed="${tool.name === app.selectedTool}">${icon((risks[tool.risk] || risks.execute)[2])}<span class="tool-item-main"><strong>${escape(tool.name)}</strong><p>${escape(tool.description || tool.title || 'Sem descrição fornecida.')}</p><span class="tool-item-bottom">${riskBadge(tool.risk)}<span>${escape(tool.source)}</span></span></span></button>`).join('')
      : emptyState('search', query || risk !== 'all' ? 'Nenhuma correspondência.' : 'Nenhuma ferramenta disponível.', query || risk !== 'all' ? 'Tente outro termo ou altere o filtro.' : 'Configure um projeto ou conecte um servidor MCP para começar.', '', true));
  }

  function sampleFromSchema(schema = {}, root = schema, depth = 0) {
    if (depth > 5) return null;
    if (schema.$ref?.startsWith('#/')) {
      const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
      return target ? sampleFromSchema(target, root, depth + 1) : null;
    }
    if (schema.default !== undefined) return schema.default;
    if (schema.examples?.length) return schema.examples[0];
    if (schema.enum?.length) return schema.enum[0];
    if (schema.const !== undefined) return schema.const;
    const variant = schema.oneOf?.[0] || schema.anyOf?.find(item => item.type !== 'null');
    if (variant) return sampleFromSchema(variant, root, depth + 1);
    const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
    if (type === 'object' || schema.properties) {
      return Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) => !schema.required?.length || schema.required.includes(key)).map(([key, value]) => [key, sampleFromSchema(value, root, depth + 1)]));
    }
    if (type === 'array') return schema.minItems ? [sampleFromSchema(schema.items || {}, root, depth + 1)] : [];
    if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
    if (type === 'boolean') return false;
    if (type === 'null') return null;
    return '';
  }

  function selectTool(name, preserveArguments = false) {
    const tool = app.tools.find(item => item.name === name);
    if (!tool) return;
    if (app.selectedTool === name && $('#tool-form') && !preserveArguments) return;
    const previousArguments = preserveArguments ? $('#tool-arguments')?.value : undefined;
    const argumentFocus = document.activeElement === $('#tool-arguments');
    app.selectedTool = name;
    renderToolsList();
    const needsApproval = app.state?.config?.approvalMode === 'all' || tool.risk !== 'read';
    const sample = sampleFromSchema(tool.inputSchema || { type: 'object' });
    replaceMarkup($('#tool-detail'), `<div class="tool-detail-heading"><div><span class="section-kicker">${escape(tool.source || 'FERRAMENTA LOCAL')}</span><h2>${escape(tool.name)}</h2></div>${riskBadge(tool.risk)}</div><p class="tool-description">${escape(tool.description || tool.title || 'Esta ferramenta não forneceu uma descrição.')}</p><details class="schema-details"><summary>Ver esquema dos parâmetros (JSON Schema)</summary><pre>${escape(pretty(tool.inputSchema))}</pre></details><form id="tool-form"><div class="tool-form-header"><label for="tool-arguments">Argumentos em JSON</label><button class="button button-ghost" type="button" data-action="sample-arguments">Usar exemplo</button></div><textarea id="tool-arguments" class="code-input tool-args" rows="9" spellcheck="false" required aria-describedby="tool-arguments-help">${escape(previousArguments ?? pretty(sample && typeof sample === 'object' ? sample : {}))}</textarea><p id="tool-arguments-help" class="field-help">Edite os valores do exemplo para o seu projeto.</p><div id="tool-request-notice" class="notice ${needsApproval ? 'notice-warning' : 'notice-subtle'} tool-request-notice">${icon(needsApproval ? 'shield' : 'info')}<span>${needsApproval ? 'Esta solicitação passará pela sua aprovação antes de executar.' : 'Esta ferramenta é de leitura e pode executar assim que for enviada.'}</span></div><p id="tool-error" class="form-error" role="alert" hidden></p><div class="tool-submit-row"><span class="small muted">A solicitação será registrada no histórico.</span><button class="button button-primary" type="submit">${icon('play')}Enviar solicitação</button></div><div id="tool-last-job" hidden></div></form>`);
    if (argumentFocus) $('#tool-arguments').focus({ preventScroll: true });
  }

  async function submitTool(form) {
    const tool = app.tools.find(item => item.name === app.selectedTool);
    if (!tool) return;
    showFormError('#tool-error');
    let args;
    try {
      args = JSON.parse($('#tool-arguments').value);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Os argumentos precisam ser um objeto JSON.');
    } catch (error) {
      showFormError('#tool-error', error instanceof SyntaxError ? `JSON inválido: ${error.message}` : error.message);
      $('#tool-arguments').focus();
      return;
    }
    const button = $('button[type=submit]', form);
    button.disabled = true;
    const selectedName = tool.name;
    try {
      const job = await request('/admin/invoke', { method: 'POST', body: { tool: tool.name, arguments: args, idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}` } });
      if (app.selectedTool === selectedName && $('#tool-last-job')) {
        const target = $('#tool-last-job');
        target.className = 'tool-last-job';
        replaceMarkup(target, `${icon('check')}<span>${job.status === 'pending_approval' ? 'Solicitação enviada para aprovação.' : 'Solicitação registrada.'}</span><button class="text-link plain-button" type="button" data-action="job-detail" data-id="${escape(job.id)}">Ver execução${icon('arrow')}</button>`);
        target.hidden = false;
      }
      toast(job.status === 'pending_approval' ? 'Solicitação recebida. Revise os detalhes para aprovar.' : 'Solicitação enviada para execução.');
      await refresh({ silent: true });
      await openJob(job.id);
    } catch (error) {
      handleError(error, $('#tool-error') ? '#tool-error' : undefined);
    } finally {
      button.disabled = false;
    }
  }

  function renderJobs() {
    const query = $('#job-search').value.trim().toLocaleLowerCase('pt-BR');
    const status = $('#job-status-filter').value;
    const jobs = [...(app.state?.jobs || [])].filter(job => (status === 'all' || job.status === status) && [job.tool, job.id, job.source].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    $('#jobs-count').textContent = `${number(jobs.length)} ${jobs.length === 1 ? 'solicitação' : 'solicitações'}`;
    replaceMarkup($('#jobs-list'), jobs.length ? `<table class="jobs-table"><thead><tr><th scope="col">Ferramenta / ID</th><th scope="col">Origem</th><th scope="col">Status</th><th scope="col">Permissão</th><th scope="col">Criada em</th><th scope="col"><span class="sr-only">Detalhes</span></th></tr></thead><tbody>${jobs.map(job => `<tr><td class="tool-cell"><button class="job-link" data-action="job-detail" data-id="${escape(job.id)}">${escape(job.tool)}</button><span class="job-id">${escape(String(job.id).slice(0, 16))}</span></td><td>${escape(job.source)}</td><td>${statusBadge(job.status)}</td><td>${riskBadge(job.risk)}</td><td><time datetime="${escape(job.createdAt)}">${escape(dateLabel(job.createdAt))}</time></td><td><button class="icon-button" data-action="job-detail" data-id="${escape(job.id)}" aria-label="Abrir execução ${escape(job.id)}">${icon('arrow')}</button></td></tr>`).join('')}</tbody></table>`
      : emptyState('activity', query || status !== 'all' ? 'Nenhuma execução encontrada.' : 'Seu histórico começa aqui.', query || status !== 'all' ? 'Altere os filtros para encontrar uma solicitação.' : 'As chamadas de ferramentas aparecerão aqui, com seus argumentos, status e resultados.', !query && status === 'all' ? '<a class="button button-primary" href="#tools">Explorar ferramentas' + icon('arrow') + '</a>' : ''));
  }

  function renderConnect() {
    const connection = app.state.connection || {};
    const oauth = connection.oauth || {};
    const pending = Array.isArray(oauth.pending) ? oauth.pending : [];
    const grants = Array.isArray(oauth.grants) ? oauth.grants : [];
    const enabled = Boolean(oauth.enabled && oauth.resource);
    $('#stdio-config').textContent = pretty({ mcpServers: { ponte: { command: connection.stdioCommand || 'node', args: connection.stdioArgs || [] } } });
    replaceMarkup($('#connection-endpoints'), [['API / Actions', 'apiUrl'], ['OpenAPI', 'openapiUrl']].map(([label, key]) => `<div class="endpoint-row"><div><span>${label}</span><code>${escape(connection[key] || 'Indisponível')}</code></div><button class="icon-button" data-action="copy-endpoint" data-key="${key}" aria-label="Copiar endpoint ${label}" ${connection[key] ? '' : 'disabled'}>${icon('copy')}</button></div>`).join(''));
    $('#chatgpt-mcp-url').textContent = enabled ? oauth.resource : 'Configure a URL pública primeiro';
    $('#copy-chatgpt-url').disabled = !enabled;
    $('#oauth-status').textContent = enabled ? 'OAuth disponível' : 'Configure a URL';
    $('#oauth-status').className = `badge badge-${enabled ? 'success' : 'neutral'}`;
    replaceMarkup($('#oauth-setup-note'), `${icon(enabled ? 'check' : 'info')}<span>${enabled ? 'A URL está configurada. Adicione o servidor no ChatGPT para iniciar a autorização.' : 'Salve a URL pública HTTPS para habilitar o OAuth.'}</span>`);
    const config = app.state.config || {};
    $('#tunnel-help').textContent = `Exponha apenas a API na porta ${config.apiPort || 4318}. O painel da porta ${config.port || 4317} permanece local.`;
    $('#nav-oauth-count').textContent = number(pending.length);
    $('#nav-oauth-count').hidden = !pending.length;
    $('#nav-oauth-count').setAttribute('aria-label', `${pending.length} ${pending.length === 1 ? 'conexão aguardando revisão' : 'conexões aguardando revisão'}`);
    $('#oauth-pending-notice').hidden = !pending.length;
    $('#oauth-pending-message').textContent = pending.length === 1
      ? 'Uma conexão OAuth aguarda sua revisão. Confira o código antes de autorizar.'
      : `${number(pending.length)} conexões OAuth aguardam sua revisão. Confira os códigos antes de autorizar.`;
    $('#oauth-requests-panel').hidden = !pending.length;
    $('#oauth-requests-count').textContent = number(pending.length);
    replaceMarkup($('#oauth-requests-list'), pending.map(item => `<article class="oauth-request-card"><div class="oauth-request-summary"><span class="soft-icon">${icon('lock')}</span><div><h3>${escape(item.clientName || 'Cliente sem nome')}</h3><p>Nome informado pelo cliente · não verificado</p><p>Expira em ${escape(oauthDate(item.expiresAt))}</p></div><code class="oauth-code-chip">${escape(item.verificationCode)}</code></div><div class="oauth-request-footer"><span>Compare este código com a página de autorização.</span><button class="button button-primary button-small" data-action="review-oauth" data-id="${escape(item.id)}">Revisar conexão${icon('arrow')}</button></div></article>`).join(''));
    $('#oauth-grants-count').textContent = number(grants.length);
    replaceMarkup($('#oauth-grants-list'), grants.length ? grants.map(grant => `<article class="oauth-grant"><span class="soft-icon">${icon('chat')}</span><div class="oauth-grant-main"><h3>${escape(grant.clientName || 'Cliente sem nome')}</h3><p>Nome informado pelo cliente · autorizado em ${escape(oauthDate(grant.createdAt))}</p><p>Válido até ${escape(oauthDate(grant.expiresAt))}</p><p class="mono oauth-grant-resource">${escape(grant.resource || oauth.resource || '')}</p><span class="oauth-grant-scopes">${escape((Array.isArray(grant.scopes) ? grant.scopes : []).join(', '))}</span></div><button class="button button-secondary button-small" data-action="revoke-oauth" data-id="${escape(grant.id)}" ${app.oauthActions.has(grant.id) ? 'disabled' : ''}>Revogar acesso</button></article>`).join('')
      : emptyState('shield', 'Nenhum cliente autorizado.', 'Ao concluir o OAuth, a conexão aparecerá aqui. Você poderá revogar o acesso quando quiser.', '', true));
    if ($('#oauth-dialog').open) renderOAuthReview();
  }

  function oauthDate(seconds) {
    const value = Number(seconds);
    return Number.isFinite(value) && value > 0 ? dateLabel(value * 1000, true) : '—';
  }

  function oauthPendingRequest(id = app.oauthRequestId) {
    return app.state?.connection?.oauth?.pending?.find(item => item.id === id);
  }

  function openOAuthRequest(id) {
    const pending = oauthPendingRequest(id);
    if (!pending) { toast('Esta solicitação não está mais disponível. Atualize o painel.', true); return; }
    app.oauthRequestId = id;
    app.oauthRequestSnapshot = '';
    $('#oauth-code-match').checked = false;
    showFormError('#oauth-review-error');
    renderOAuthReview();
    if (!$('#oauth-dialog').open) $('#oauth-dialog').showModal();
    $('#oauth-dialog').scrollTop = 0;
    $('#oauth-reject').focus();
  }

  function renderOAuthReview() {
    const pending = oauthPendingRequest();
    const valid = pending && Number(pending.expiresAt) * 1000 > Date.now();
    const busy = app.oauthActions.has(app.oauthRequestId);
    if (pending) {
      const snapshot = JSON.stringify(pending);
      if (app.oauthRequestSnapshot !== snapshot) {
        app.oauthRequestSnapshot = snapshot;
        $('#oauth-code-match').checked = false;
        $('#oauth-verification-code').textContent = pending.verificationCode;
        $('#oauth-client-name').textContent = pending.clientName || 'Cliente sem nome';
        $('#oauth-redirect-uri').textContent = pending.redirectUri;
        $('#oauth-request-expires').textContent = oauthDate(pending.expiresAt);
        $('#oauth-request-scopes').textContent = (Array.isArray(pending.scopes) ? pending.scopes : []).join(', ');
      }
      $('#oauth-approve').dataset.id = pending.id;
      $('#oauth-reject').dataset.id = pending.id;
    }
    $('#oauth-code-match').disabled = !valid || busy;
    $('#oauth-approve').disabled = !valid || busy || app.offline || !$('#oauth-code-match').checked;
    $('#oauth-reject').disabled = !valid || busy || app.offline;
    if (!valid) showFormError('#oauth-review-error', 'Esta solicitação expirou ou já foi respondida. Feche esta janela e inicie uma nova conexão no cliente, se necessário.');
  }

  async function oauthRequestAction(action, id, button) {
    if (!$('#oauth-dialog').open || app.oauthRequestId !== id || !$('#oauth-dialog').contains(button)) {
      openOAuthRequest(id);
      return;
    }
    const pending = oauthPendingRequest(id);
    if (!pending || Number(pending.expiresAt) * 1000 <= Date.now()) { renderOAuthReview(); return; }
    if (app.offline) { showFormError('#oauth-review-error', 'A ponte está sem conexão. Atualize o painel e tente novamente.'); return; }
    if (action === 'approve' && (!$('#oauth-code-match').checked || app.oauthRequestSnapshot !== JSON.stringify(pending))) {
      renderOAuthReview();
      showFormError('#oauth-review-error', 'Confira o código no navegador e marque a confirmação antes de autorizar.');
      return;
    }
    if (app.oauthActions.has(id)) return;
    const generation = app.sessionGeneration;
    app.oauthActions.add(id);
    showFormError('#oauth-review-error');
    renderOAuthReview();
    try {
      await request(`/admin/oauth/requests/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      if (generation !== app.sessionGeneration) return;
      if (app.oauthRequestId === id) $('#oauth-dialog').close();
      toast(action === 'approve' ? 'Conexão autorizada. Volte à página de autorização para concluir no ChatGPT.' : 'Solicitação de conexão recusada.');
      await refresh();
    } catch (error) {
      if (generation === app.sessionGeneration) handleError(error, '#oauth-review-error');
    } finally {
      app.oauthActions.delete(id);
      if ($('#oauth-dialog').open && app.oauthRequestId === id) renderOAuthReview();
    }
  }

  async function revokeOAuthGrant(id) {
    const grant = app.state?.connection?.oauth?.grants?.find(item => item.id === id);
    if (!grant || app.oauthActions.has(id)) return;
    const generation = app.sessionGeneration;
    const yes = await confirmAction('Revogar acesso do cliente?', `A conexão “${grant.clientName || 'Cliente sem nome'}” perderá o acesso às ferramentas da Ponte. Para usá-la novamente, será preciso autorizar uma nova conexão.`, 'Revogar acesso');
    if (!yes || generation !== app.sessionGeneration) return;
    app.oauthActions.add(id);
    renderConnect();
    try {
      await request(`/admin/oauth/grants/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
      if (generation !== app.sessionGeneration) return;
      toast('Acesso do cliente revogado.');
      await refresh();
    } catch (error) { if (generation === app.sessionGeneration) handleError(error); }
    finally {
      app.oauthActions.delete(id);
      if (app.state && generation === app.sessionGeneration) renderConnect();
    }
  }

  function openProject(id) {
    const project = app.state.config?.projects?.find(item => item.id === id);
    $('#project-form').reset();
    $('#project-dialog-title').textContent = project ? 'Editar projeto' : 'Adicionar projeto';
    $('#project-id').readOnly = Boolean(project);
    $('#project-id').value = project?.id || '';
    $('#project-name').value = project?.name || '';
    $('#project-root').value = project?.root || '';
    $('#project-write').checked = Boolean(project?.allowWrite);
    $('#project-exec').checked = Boolean(project?.allowExec);
    showFormError('#project-error');
    $('#project-dialog').showModal();
    $('#project-name').focus();
  }

  async function submitProject() {
    const button = $('#project-form button[type=submit]');
    const project = { id: $('#project-id').value.trim(), name: $('#project-name').value.trim(), root: $('#project-root').value.trim(), allowWrite: $('#project-write').checked, allowExec: $('#project-exec').checked };
    showFormError('#project-error');
    if (!project.name || !project.root || !project.id) { showFormError('#project-error', 'Preencha o nome, identificador e diretório raiz.'); return; }
    button.disabled = true;
    try {
      await request('/admin/projects', { method: 'POST', body: project });
      $('#project-dialog').close();
      toast('Projeto salvo. As permissões já estão atualizadas.');
      await refresh({ tools: true });
    } catch (error) { handleError(error, '#project-error'); }
    finally { button.disabled = false; }
  }

  function updateTransportFields() {
    const stdio = $('#server-transport').value === 'stdio';
    $('#server-stdio-fields').hidden = !stdio;
    $('#server-http-fields').hidden = stdio;
    $('#server-command').required = stdio;
    $('#server-url').required = !stdio;
    $('#server-url').disabled = stdio;
  }

  function updateAllowedTools() {
    const restricted = $('#server-restrict-tools').checked;
    $('#server-allowed-tools').disabled = !restricted;
    $('#server-allowed-tools-help').textContent = restricted
      ? 'Somente os nomes exatos desta lista serão expostos, um por linha. Lista vazia: nenhuma ferramenta será exposta.'
      : 'Todas as ferramentas do servidor serão expostas. Marque a opção acima para limitar a uma lista de nomes.';
  }

  function openServer(id) {
    const server = app.state.config?.upstreams?.find(item => item.id === id);
    app.serverEditing = Boolean(server);
    app.serverOriginalUrl = server?.url || '';
    $('#server-form').reset();
    $('#server-dialog-title').textContent = server ? 'Editar conexão' : 'Adicionar conexão';
    $('#server-id').readOnly = Boolean(server);
    $('#server-id').value = server?.id || '';
    $('#server-name').value = server?.name || '';
    $('#server-transport').value = server?.transport || 'stdio';
    $('#server-timeout').value = server?.timeoutMs || 60000;
    $('#server-command').value = server?.command || '';
    $('#server-args').value = pretty(server?.args || []);
    $('#server-cwd').value = server?.cwd || '';
    $('#server-url').value = server?.url || '';
    $('#server-read-tools').value = (server?.readOnlyTools || []).join('\n');
    $('#server-restrict-tools').checked = Array.isArray(server?.allowedTools);
    $('#server-allowed-tools').value = (server?.allowedTools || []).join('\n');
    $('#server-env').value = '';
    $('#server-headers').value = '';
    $('#server-enabled').checked = server?.enabled !== false;
    $('#server-secret-help').textContent = server
      ? 'Por segurança, os valores existentes ficam ocultos. Campo vazio preserva as credenciais atuais. Um objeto substitui todos os valores desse campo; {} remove todos. Informe valores reais, nunca REDACTED.'
      : 'Objetos JSON com valores de texto. Credenciais não aparecem na lista de conexões.';
    $('#server-form details').open = false;
    showFormError('#server-error');
    updateTransportFields();
    updateAllowedTools();
    $('#server-dialog').showModal();
    $('#server-name').focus();
  }

  function parseStringObject(value, label) {
    let object;
    try { object = JSON.parse(value); } catch { throw new Error(`${label}: informe um objeto JSON válido.`); }
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.values(object).some(item => typeof item !== 'string')) throw new Error(`${label}: use um objeto JSON com valores de texto.`);
    if (Object.values(object).some(item => /^(?:\[?REDACTED\]?|\*{3,})$/i.test(item.trim()))) throw new Error(`${label}: substitua REDACTED pelo valor real ou deixe o campo vazio para preservar os valores atuais.`);
    return object;
  }

  async function submitServer() {
    const button = $('#server-form button[type=submit]');
    showFormError('#server-error');
    let server;
    try {
      const transport = $('#server-transport').value;
      server = {
        id: $('#server-id').value.trim(), name: $('#server-name').value.trim(), transport,
        enabled: $('#server-enabled').checked, timeoutMs: Number($('#server-timeout').value),
        readOnlyTools: [...new Set($('#server-read-tools').value.split('\n').map(item => item.trim()).filter(Boolean))],
        allowedTools: $('#server-restrict-tools').checked
          ? $('#server-allowed-tools').value.split('\n').map(item => item.trim()).filter(Boolean)
          : null
      };
      if (!server.id || !server.name) throw new Error('Preencha o nome e o identificador da conexão.');
      if (transport === 'stdio') {
        server.command = $('#server-command').value.trim();
        if (!server.command) throw new Error('Informe o comando do servidor.');
        try { server.args = JSON.parse($('#server-args').value || '[]'); } catch { throw new Error('Argumentos: informe um array JSON válido, como ["servidor.js"].'); }
        if (!Array.isArray(server.args) || server.args.some(value => typeof value !== 'string')) throw new Error('Argumentos: use um array JSON com valores de texto.');
        server.cwd = $('#server-cwd').value.trim();
      } else {
        server.url = $('#server-url').value.trim();
        let url;
        try { url = new URL(server.url); } catch { throw new Error('Informe uma URL válida para o servidor MCP.'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('A URL do servidor precisa usar HTTP ou HTTPS.');
        if (app.serverEditing && server.url === app.serverOriginalUrl) delete server.url;
        else if (decodeURIComponent(url.href).includes('[REDACTED]')) throw new Error('Informe a URL completa com os valores reais. Para preservar os valores existentes, mantenha a URL sem alterações.');
      }
      const env = $('#server-env').value.trim();
      const headers = $('#server-headers').value.trim();
      if (env) server.env = parseStringObject(env, 'Variáveis de ambiente');
      if (headers) server.headers = parseStringObject(headers, 'Cabeçalhos');
    } catch (error) { showFormError('#server-error', error.message); return; }
    button.disabled = true;
    try {
      await request('/admin/servers', { method: 'POST', body: server, timeoutMs: 150000 });
      $('#server-dialog').close();
      toast('Conexão salva. Acompanhe o estado do servidor no painel.');
      await refresh({ tools: true });
    } catch (error) { handleError(error, '#server-error'); }
    finally { button.disabled = false; }
  }

  async function openJob(id) {
    if (!id) return;
    app.jobId = id;
    app.job = null;
    $('#job-dialog-title').textContent = 'Carregando execução…';
    replaceMarkup($('#job-detail-body'), '<div class="empty-state"><span class="empty-icon">' + icon('clock') + '</span><p>Buscando argumentos e resultados.</p></div>');
    replaceMarkup($('#job-detail-actions'), '<button class="button button-secondary" data-close-dialog>Fechar</button>');
    if (!$('#job-dialog').open) $('#job-dialog').showModal();
    await refreshJob(false);
  }

  async function refreshJob(silent) {
    if (!app.jobId || app.jobLoading === app.jobId || !app.token) return;
    const id = app.jobId;
    app.jobLoading = id;
    const generation = app.sessionGeneration;
    try {
      const job = await request(`/admin/jobs/${encodeURIComponent(id)}`);
      if (app.jobId !== id || generation !== app.sessionGeneration) return;
      app.job = job;
      renderJobDetail(job);
    } catch (error) {
      if (!silent && app.jobId === id) {
        if (error.status === 401 || error.status === 403) handleError(error);
        else {
          $('#job-dialog-title').textContent = 'Não foi possível abrir a execução';
          replaceMarkup($('#job-detail-body'), `<div class="notice notice-warning">${icon('info')}<span>${escape(error.message)}</span></div>`);
          replaceMarkup($('#job-detail-actions'), `<button class="button button-secondary" data-close-dialog>Fechar</button><button class="button button-primary" data-action="job-detail" data-id="${escape(id)}">Tentar novamente</button>`);
        }
      }
    } finally { if (app.jobLoading === id) app.jobLoading = false; }
  }

  function resultMarkup(result) {
    const blocks = Array.isArray(result) ? result : Array.isArray(result?.content) ? result.content : null;
    if (!blocks) return `<pre>${escape(typeof result === 'string' ? result : pretty(result))}</pre>`;
    if (!blocks.length) return '<pre>A ferramenta retornou um resultado vazio.</pre>';
    return blocks.map(block => {
      if (block.type === 'text') return `<pre class="job-result-block">${escape(block.text || '')}</pre>`;
      if (block.type === 'image' && /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType || '') && /^[A-Za-z0-9+/=\s]+$/.test(block.data || '')) return `<div class="job-result-block"><img class="job-result-image" src="data:${escape(block.mimeType)};base64,${escape(block.data)}" alt="Imagem retornada pela ferramenta"></div>`;
      if (block.type === 'resource' && block.resource?.text !== undefined) return `<pre class="job-result-block">${escape(block.resource.text)}</pre>`;
      if (block.data) return `<pre class="job-result-block">${escape(pretty({ ...block, data: `[Conteúdo ${block.type || 'binário'} em base64 — ${block.data.length} caracteres]` }))}</pre>`;
      return `<pre class="job-result-block">${escape(pretty(block))}</pre>`;
    }).join('');
  }

  function renderJobDetail(job) {
    const dialog = $('#job-dialog');
    const body = $('#job-detail-body');
    const scroll = dialog.scrollTop;
    const detailsOpen = Object.fromEntries($$('details[data-section]', body).map(element => [element.dataset.section, element.open]));
    const open = key => detailsOpen[key] === false ? '' : 'open';
    $('#job-dialog-title').textContent = job.tool || 'Execução';
    const notes = {
      pending_approval: 'Revise os argumentos e a prévia abaixo. Aprovar libera esta solicitação para execução.',
      queued: app.state?.paused ? 'A solicitação está na fila. A ponte está pausada.' : 'A solicitação está na fila e aguarda execução.',
      running: 'A ferramenta está em execução. O resultado aparecerá aqui quando a chamada terminar.',
      rejected: 'A solicitação foi recusada e não foi executada.',
      cancelled: 'A solicitação foi cancelada. Consulte os registros disponíveis para verificar se houve efeitos antes do cancelamento.',
      expired: 'A solicitação expirou antes de ser aprovada.'
    };
    const preview = typeof job.preview === 'string' ? job.preview : job.preview ? job.preview.diff || pretty(job.preview) : '';
    const diff = preview ? preview.split('\n').map(line => `<span class="diff-line${line.startsWith('+') && !line.startsWith('+++') ? ' diff-add' : line.startsWith('-') && !line.startsWith('---') ? ' diff-remove' : line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---') ? ' diff-header' : ''}">${escape(line)}</span>`).join('') : '';
    replaceMarkup(body, `<div class="job-detail-meta">${statusBadge(job.status)}${riskBadge(job.risk)}${badge(job.source || 'Origem desconhecida', 'neutral')}</div>${notes[job.status] ? `<div class="job-status-note">${escape(notes[job.status])}</div>` : ''}<dl class="job-meta-grid"><div><dt>ID da solicitação</dt><dd>${escape(job.id)}</dd></div><div><dt>Origem</dt><dd>${escape(job.source)}</dd></div><div><dt>Criada em</dt><dd>${escape(dateLabel(job.createdAt, true))}</dd></div><div><dt>Atualizada em</dt><dd>${escape(dateLabel(job.updatedAt, true))}</dd></div></dl><details class="job-section" data-section="arguments" ${open('arguments')}><summary>Argumentos</summary><pre>${escape(pretty(job.arguments))}</pre></details>${preview ? `<details class="job-section" data-section="preview" ${open('preview')}><summary>Prévia de alterações</summary><pre class="diff-preview">${diff}</pre></details>` : job.status === 'pending_approval' ? '<p class="job-no-preview">Esta ferramenta não forneceu uma prévia de alterações. Confira os argumentos antes de aprovar.</p>' : ''}${job.error ? `<div class="form-error" role="status">${escape(typeof job.error === 'string' ? job.error : pretty(job.error))}</div>` : ''}${job.result !== undefined && job.result !== null ? `<details class="job-section" data-section="result" ${open('result')}><summary>Resultado</summary>${resultMarkup(job.result)}</details>` : job.status === 'succeeded' ? '<p class="job-no-preview">Execução concluída sem conteúdo de resultado.</p>' : ''}`);
    const busy = app.jobActions.has(job.id) ? 'disabled' : '';
    let actions = '<button class="button button-secondary" data-close-dialog>Fechar</button>';
    if (job.status === 'pending_approval') actions = `<span class="footer-note">A decisão vale para esta solicitação.</span><button class="button button-secondary" data-action="reject-job" data-id="${escape(job.id)}" ${busy}>Recusar</button><button class="button button-primary" data-action="approve-job" data-id="${escape(job.id)}" ${busy}>${icon('check')}Aprovar e executar</button>`;
    if (job.status === 'running' || job.status === 'queued') actions = `<span class="footer-note">Atualização automática</span><button class="button button-secondary" data-close-dialog>Fechar</button><button class="button button-danger" data-action="cancel-job" data-id="${escape(job.id)}" ${busy}>${icon('close')}Cancelar execução</button>`;
    replaceMarkup($('#job-detail-actions'), actions);
    dialog.scrollTop = scroll;
  }

  async function jobAction(action, id, button) {
    if (action === 'approve' && (!$('#job-dialog').open || app.jobId !== id || !$('#job-dialog').contains(button))) {
      await openJob(id);
      return;
    }
    if (app.jobActions.has(id)) return;
    app.jobActions.add(id);
    button.disabled = true;
    const labels = { approve: 'Solicitação aprovada.', reject: 'Solicitação recusada.', cancel: 'Cancelamento solicitado.' };
    try {
      const job = await request(`/admin/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      if (app.jobId === id) { app.job = job; renderJobDetail(job); }
      toast(labels[action]);
      await refresh();
    } catch (error) { handleError(error); }
    finally {
      app.jobActions.delete(id);
      button.disabled = false;
      if (app.job?.id === id && $('#job-dialog').open) renderJobDetail(app.job);
    }
  }

  function confirmAction(title, description, label = 'Remover') {
    if (app.confirmResolve) app.confirmResolve(false);
    $('#confirm-title').textContent = title;
    $('#confirm-description').textContent = description;
    $('#confirm-accept').textContent = label;
    $('#confirm-dialog').showModal();
    $('#confirm-cancel').focus();
    return new Promise(resolve => { app.confirmResolve = resolve; });
  }

  function resolveConfirmation(accepted) {
    const resolve = app.confirmResolve;
    app.confirmResolve = null;
    $('#confirm-dialog').close();
    resolve?.(accepted);
  }

  async function removeConfig(kind, id) {
    const project = kind === 'projects';
    const item = (project ? app.state.config?.projects : app.state.config?.upstreams)?.find(value => value.id === id);
    if (!item) return;
    const yes = await confirmAction(`Remover ${project ? 'projeto' : 'conexão'}?`, project
      ? `O projeto “${item.name}” será removido da configuração da ponte. Os arquivos no diretório permanecerão no disco.`
      : `A conexão “${item.name || item.id}” será removida da ponte e suas ferramentas deixarão de estar disponíveis.`);
    if (!yes) return;
    try {
      await request(`/admin/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: kind === 'servers' ? 150000 : 20000 });
      toast(project ? 'Projeto removido da ponte.' : 'Conexão removida da ponte.');
      await refresh({ tools: true });
    } catch (error) { handleError(error); }
  }

  async function copyText(value) {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const textarea = document.createElement('textarea');
        textarea.className = 'clipboard-helper';
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('copy');
      }
      toast('Copiado para a área de transferência.');
    } catch { toast('Não foi possível copiar automaticamente. Selecione o texto e copie pelo teclado.', true); }
  }

  function routeFromHash() {
    const route = location.hash.slice(1);
    return Object.hasOwn(views, route) ? route : 'overview';
  }

  function navigate(view, focus = true) {
    if (!Object.hasOwn(views, view)) view = 'overview';
    app.view = view;
    const data = views[view];
    $$('.view').forEach(element => { element.hidden = element.id !== `view-${view}`; });
    $$('#main-nav [data-view]').forEach(element => {
      if (element.dataset.view === view) element.setAttribute('aria-current', 'page');
      else element.removeAttribute('aria-current');
    });
    $('#page-title').textContent = data.title;
    $('#page-eyebrow').textContent = data.eyebrow;
    $('#page-description').textContent = data.description;
    $('#breadcrumb-current').textContent = data.title;
    document.title = `${data.title} · Ponte MCP`;
    closeNavigation(false);
    if (focus && app.token) { $('#main-content').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }

  function closeNavigation(restoreFocus = true) {
    app.navOpen = false;
    $('#sidebar').classList.remove('open');
    $('#nav-backdrop').hidden = true;
    $('#menu-button').setAttribute('aria-expanded', 'false');
    $('#sidebar').inert = matchMedia('(max-width: 820px)').matches;
    document.body.classList.remove('nav-open');
    if (restoreFocus) $('#menu-button').focus();
  }

  function openNavigation() {
    app.navOpen = true;
    $('#sidebar').inert = false;
    $('#sidebar').classList.add('open');
    $('#nav-backdrop').hidden = false;
    $('#menu-button').setAttribute('aria-expanded', 'true');
    document.body.classList.add('nav-open');
    $('#main-nav [aria-current=page]')?.focus();
  }

  document.addEventListener('click', async event => {
    const close = event.target.closest('[data-close-dialog]');
    if (close) { event.preventDefault(); close.closest('dialog')?.close(); return; }
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled || !app.token) return;
    const { action, id } = button.dataset;
    if (action === 'new-project' || action === 'edit-project') openProject(id);
    else if (action === 'delete-project') await removeConfig('projects', id);
    else if (action === 'new-server' || action === 'edit-server') openServer(id);
    else if (action === 'delete-server') await removeConfig('servers', id);
    else if (action === 'reconnect-server') {
      button.disabled = true;
      try {
        await request(`/admin/servers/${encodeURIComponent(id)}/reconnect`, { method: 'POST', body: {}, timeoutMs: 150000 });
        toast('Reconexão solicitada.');
        await refresh({ tools: true });
      } catch (error) { handleError(error); }
      finally { button.disabled = false; }
    } else if (action === 'select-tool') selectTool(button.dataset.tool);
    else if (action === 'sample-arguments') {
      const tool = app.tools.find(item => item.name === app.selectedTool);
      if (tool) { $('#tool-arguments').value = pretty(sampleFromSchema(tool.inputSchema || { type: 'object' })); showFormError('#tool-error'); }
    } else if (action === 'job-detail') await openJob(id);
    else if (['approve-job', 'reject-job', 'cancel-job'].includes(action)) await jobAction(action.split('-')[0], id, button);
    else if (action === 'review-oauth') openOAuthRequest(id);
    else if (['approve-oauth', 'reject-oauth'].includes(action)) await oauthRequestAction(action.split('-')[0], id, button);
    else if (action === 'revoke-oauth') await revokeOAuthGrant(id);
    else if (action === 'copy-stdio') await copyText($('#stdio-config').textContent);
    else if (action === 'copy-endpoint') await copyText(app.state?.connection?.[button.dataset.key]);
    else if (action === 'copy-chatgpt-url') await copyText(app.state?.connection?.oauth?.resource);
    else if (action === 'copy-api-command') await copyText('node dist/cli.js token api');
  });

  document.addEventListener('submit', async event => {
    // A control named "id" shadows HTMLFormElement.id; read the attribute.
    const formId = event.target.getAttribute('id');
    if (formId === 'login-form') {
      event.preventDefault();
      const token = $('#admin-token').value.trim();
      if (token) await authenticate(token);
    } else if (formId === 'project-form') { event.preventDefault(); await submitProject(); }
    else if (formId === 'server-form') { event.preventDefault(); await submitServer(); }
    else if (formId === 'tool-form') { event.preventDefault(); await submitTool(event.target); }
    else if (formId === 'public-url-form') {
      event.preventDefault();
      const button = $('button', event.target);
      const publicUrl = $('#public-url').value.trim();
      if (publicUrl) {
        let url;
        try { url = new URL(publicUrl); } catch { toast('Informe uma URL pública válida.', true); return; }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
          toast('Use uma origem HTTPS, sem caminho, credenciais ou parâmetros.', true);
          return;
        }
      }
      button.disabled = true;
      try {
        await request('/admin/settings', { method: 'PATCH', body: { publicUrl } });
        app.publicUrlDirty = false;
        toast('URL pública atualizada nos endpoints e no esquema.');
        await refresh();
      } catch (error) { handleError(error); }
      finally { button.disabled = false; }
    }
  });

  $('#approval-mode').addEventListener('change', async event => {
    const select = event.target;
    select.disabled = true;
    try {
      await request('/admin/settings', { method: 'PATCH', body: { approvalMode: select.value } });
      toast('Política de aprovação atualizada.');
      await refresh();
    } catch (error) { handleError(error); select.value = app.state?.config?.approvalMode || 'mutations'; }
    finally { select.disabled = false; }
  });

  $('#pause-button').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    const paused = !app.state?.paused;
    try {
      await request('/admin/pause', { method: 'POST', body: { paused } });
      toast(paused ? 'Novas execuções pausadas.' : 'Execuções retomadas.');
      await refresh();
    } catch (error) { handleError(error); }
    finally { button.disabled = false; updateConnectionStatus(); }
  });

  $('#roblox-button').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await request('/admin/roblox', { method: 'POST', body: {}, timeoutMs: 150000 });
      toast('Preset Roblox adicionado. Confira o estado e a configuração da conexão.');
      await refresh({ tools: true });
    } catch (error) { handleError(error); }
    finally { button.disabled = false; }
  });

  $('#download-openapi').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const schema = await request('/admin/openapi');
      const url = URL.createObjectURL(new Blob([pretty(schema)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ponte-mcp-openapi.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Esquema OpenAPI pronto para download.');
    } catch (error) { handleError(error); }
    finally { button.disabled = false; }
  });

  $('#refresh-button').addEventListener('click', () => refresh({ tools: true, silent: false }));
  $('#logout-button').addEventListener('click', () => lock());
  $('#public-url').addEventListener('input', () => { app.publicUrlDirty = true; });
  $('#tool-search').addEventListener('input', renderToolsList);
  $('#tool-risk-filter').addEventListener('change', renderToolsList);
  $('#job-search').addEventListener('input', renderJobs);
  $('#job-status-filter').addEventListener('change', renderJobs);
  $('#server-transport').addEventListener('change', updateTransportFields);
  $('#server-restrict-tools').addEventListener('change', updateAllowedTools);
  $('#confirm-cancel').addEventListener('click', () => resolveConfirmation(false));
  $('#confirm-accept').addEventListener('click', () => resolveConfirmation(true));
  $('#confirm-dialog').addEventListener('close', () => { const resolve = app.confirmResolve; app.confirmResolve = null; resolve?.(false); });
  $('#server-dialog').addEventListener('close', () => { $('#server-env').value = ''; $('#server-headers').value = ''; });
  $('#job-dialog').addEventListener('close', () => { app.jobId = null; app.job = null; });
  $('#oauth-code-match').addEventListener('change', renderOAuthReview);
  $('#oauth-dialog').addEventListener('close', () => { app.oauthRequestId = null; app.oauthRequestSnapshot = ''; $('#oauth-code-match').checked = false; });
  $('#menu-button').addEventListener('click', () => app.navOpen ? closeNavigation() : openNavigation());
  $('#nav-backdrop').addEventListener('click', () => closeNavigation());
  window.addEventListener('hashchange', () => { if (app.token) navigate(routeFromHash()); });
  window.addEventListener('resize', () => {
    if (!matchMedia('(max-width: 820px)').matches) closeNavigation(false);
    else if (!app.navOpen) $('#sidebar').inert = true;
  });
  document.addEventListener('keydown', event => {
    if (!app.navOpen || $('dialog[open]')) return;
    if (event.key === 'Escape') { closeNavigation(); event.preventDefault(); }
    if (event.key === 'Tab') {
      const items = $$('a[href],button:not([disabled])', $('#sidebar'));
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
      else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && app.token) refresh(); }, 2500);

  closeNavigation(false);
  let savedToken = '';
  try { savedToken = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* Sem armazenamento: solicite o token normalmente. */ }
  if (savedToken) authenticate(savedToken);
})();
