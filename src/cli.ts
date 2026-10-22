#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { access, realpath, stat, writeFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConfigStore, projectSchema, robloxPreset, publicUrlSchema } from './core/config.js';
import { startApplication, projectRoot } from './app.js';
import { makeMcpServer } from './mcp/server.js';
import { makeOpenApi } from './openapi.js';
import { CLIENT_PROFILE_IDS, exportClientProfile, type ClientProfileId } from './clients/profiles.js';
import { WATCH_DEFAULT_WAIT_MS, WATCH_MAX_WAIT_MS, WatchRecoveryError, watcherRecovery } from './watchers/types.js';

const HELP = `Ponte MCP 0.10.0 — ferramentas locais para chats\n\nComandos:\n  init [--workspace PASTA]  Criar configuração e credenciais locais\n  start                    Iniciar painel e API em loopback\n  stdio                    Expor MCP por stdio usando o serviço já iniciado\n  token admin|api          Mostrar a credencial escolhida neste terminal\n  doctor                   Verificar configuração e serviço\n  add-project ID PASTA     Autorizar pasta (reinicie o serviço após configurar)\n  add-roblox               Adicionar o MCP oficial do Roblox Studio\n  export-openapi [--url HTTPS] [--output ARQUIVO]\n  export-client PERFIL [--url HTTPS] [--output ARQUIVO]\n    Gemini: gemini-cli-stdio, gemini-cli-http, gemini-api\n    Grok: grok-build-stdio, grok-build-http, grok-api\n    Exporta sem sobrescrever arquivos ou configurar o cliente.\n\nOpções gerais:\n  --state-dir PASTA        Diretório local de configuração (padrão .ponte)\n  --port NUMERO            Porta do painel ao criar a configuração\n  --api-port NUMERO        Porta da API ao criar a configuração\n\nO serviço não remove cotas do modelo. Tokens admin e api são diferentes.\n`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, workspace: { type: 'string' }, port: { type: 'string' }, 'api-port': { type: 'string' },
    url: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { process.stdout.write(HELP); return; }
  const stateDir = path.resolve(values['state-dir'] ?? process.env.PONTE_STATE_DIR ?? path.join(projectRoot, '.ponte'));

  if (command === 'export-openapi') {
    const url = values.url ? publicUrlSchema.parse(values.url) : 'https://ponte.example.com';
    const content = JSON.stringify(makeOpenApi(url), null, 2) + '\n';
    if (values.output) { await writeFile(path.resolve(values.output), content, 'utf8'); process.stderr.write('OpenAPI exportado.\n'); }
    else process.stdout.write(content);
    return;
  }
  if (command !== 'init') {
    try { await access(path.join(stateDir, 'config.json')); }
    catch { throw new Error('Execute primeiro: node dist/cli.js init --workspace "CAMINHO_DO_PROJETO"'); }
  }
  if (command === 'start') {
    const runtime = await startApplication({ stateDir });
    process.stderr.write(`\nPonte MCP pronta.\nPainel: ${runtime.adminUrl}\nMCP: ${runtime.apiUrl}/mcp\n\nAbra outro terminal para obter seu token:\n  node dist/cli.js token admin --state-dir "${stateDir}"\n\nMantenha esta janela aberta. Ctrl+C encerra o serviço.\n`);
    let stopping = false;
    const shutdown = async () => { if (stopping) return; stopping = true; await runtime.close(); process.exitCode = 0; };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
    return;
  }
  const store = await ConfigStore.open(stateDir, {
    workspace: values.workspace ? path.resolve(values.workspace) : undefined,
    port: values.port ? Number(values.port) : undefined, apiPort: values['api-port'] ? Number(values['api-port']) : undefined,
  });
  if (command === 'init') {
    process.stderr.write(`Configuração pronta em ${stateDir}.\nProjeto: ${store.config.projects[0]?.root ?? '(nenhum)'}\nPróximo passo: npm start\nToken do painel: node dist/cli.js token admin\n`); return;
  }
  if (command === 'export-client') {
    const id = positionals[1];
    if (positionals.length !== 2 || !CLIENT_PROFILE_IDS.includes(id as ClientProfileId)) {
      throw new Error(`Informe um perfil de cliente: ${CLIENT_PROFILE_IDS.join(', ')}.`);
    }
    const profile = exportClientProfile(id as ClientProfileId, {
      platform: process.platform, nodePath: process.execPath,
      cliPath: path.join(projectRoot, 'dist', 'cli.js'), stateDir,
      publicUrl: values.url ? publicUrlSchema.parse(values.url) : store.config.publicUrl,
    });
    if (values.output) {
      try { await writeFile(path.resolve(values.output), profile.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('O arquivo de saída já existe. Escolha outro nome e mescle a configuração no cliente.');
        throw error;
      }
      process.stderr.write(`Perfil ${id} exportado. Mescle a configuração sem substituir as entradas existentes.\n`);
    } else process.stdout.write(profile.content);
    return;
  }
  if (command === 'token') {
    if (positionals[1] !== 'admin' && positionals[1] !== 'api') throw new Error('Use token admin ou token api.');
    process.stdout.write(store.secrets[positionals[1] === 'admin' ? 'adminToken' : 'apiToken'] + '\n'); return;
  }
  if (command === 'add-project') {
    const root = await realpath(path.resolve(positionals[2] ?? ''));
    if (!positionals[2] || !(await stat(root)).isDirectory() || path.parse(root).root === root) throw new Error('Use add-project ID PASTA_EXISTENTE, apontando para uma pasta de projeto.');
    const project = projectSchema.parse({ id: positionals[1], name: positionals[1], root, allowWrite: true, allowExec: false });
    await store.update(config => ({ ...config, projects: [...config.projects.filter(item => item.id !== project.id), project] }));
    process.stderr.write('Projeto adicionado. Reinicie o serviço para carregar esta configuração.\n'); return;
  }
  if (command === 'add-roblox') {
    const server = robloxPreset();
    await store.update(config => ({ ...config, upstreams: [...config.upstreams.filter(item => item.id !== server.id), server] }));
    process.stderr.write('Roblox adicionado. Habilite o MCP no Studio e reinicie a ponte.\n'); return;
  }
  const apiUrl = `http://127.0.0.1:${store.config.apiPort}`;
  if (command === 'doctor') {
    const projects = await Promise.all(store.config.projects.map(async project => ({ id: project.id, accessible: await stat(project.root).then(value => value.isDirectory()).catch(() => false) })));
    let service: unknown;
    try { service = await requestJson(apiUrl + '/v1/status', store.secrets.apiToken); }
    catch { service = { connected: false, nextStep: 'Inicie com npm start e confira as portas.' }; }
    process.stdout.write(JSON.stringify({ node: process.versions.node, platform: process.platform, projects, service }, null, 2) + '\n'); return;
  }
  if (command === 'stdio') {
    await requestJson(apiUrl + '/v1/status', store.secrets.apiToken);
    const server = makeMcpServer(
      async () => ListToolsResultSchema.parse(await requestJson(apiUrl + '/v1/mcp/tools', store.secrets.apiToken)).tools,
      async (name, arguments_, signal) => CallToolResultSchema.parse(await requestJson(apiUrl + '/v1/mcp/call', store.secrets.apiToken, { name, arguments: arguments_ }, signal)),
    );
    await server.connect(new StdioServerTransport());
    const shutdown = () => { void server.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); process.stdin.once('end', shutdown);
    return;
  }
  throw new Error('Comando desconhecido. Use --help.');
}

async function requestJson(url: string, token: string, body?: unknown, callerSignal?: AbortSignal): Promise<unknown> {
  const toolCall = new URL(url).pathname === '/v1/mcp/call';
  const request = body as { name?: string; arguments?: Record<string, unknown> } | undefined;
  const wrapper = ['bridge_call', 'bridge_read', 'bridge_invoke'].includes(request?.name ?? '');
  const invocation = wrapper ? request?.arguments?.tool : request?.name;
  let invocationArgs: unknown = wrapper ? request?.arguments?.arguments : request?.arguments;
  if (request?.name === 'bridge_read' || request?.name === 'bridge_invoke') {
    const encoded = request.arguments?.argumentsJson;
    if (typeof encoded === 'string' && Buffer.byteLength(encoded) <= 1024 * 1024) {
      try { invocationArgs = JSON.parse(encoded); } catch { /* The gateway reports malformed arguments. */ }
    }
  }
  const watcherControl = toolCall && typeof invocation === 'string' && ['bridge_watch_wait', 'bridge_watch_get', 'bridge_watch_cancel'].includes(invocation);
  const watchArgs = watcherControl && invocationArgs && typeof invocationArgs === 'object' && !Array.isArray(invocationArgs) ? invocationArgs as Record<string, unknown> : undefined;
  const watchWait = watcherControl && invocation === 'bridge_watch_wait';
  const waitMs = watchArgs?.waitMs ?? WATCH_DEFAULT_WAIT_MS;
  if (watchWait && typeof waitMs === 'number' && waitMs > WATCH_MAX_WAIT_MS) {
    const recovery = watcherRecovery(watchArgs?.watcherId, 'wait_limit_exceeded');
    const message = `waitMs excede o limite de ${WATCH_MAX_WAIT_MS} ms por chamada.`;
    if (recovery) throw new WatchRecoveryError(message, recovery);
    throw new Error(message);
  }
  // Extend only native watcher waits; keep existing catalog and ordinary tool deadlines.
  const deadlineMs = watchWait && typeof waitMs === 'number' && Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= WATCH_MAX_WAIT_MS ? waitMs + 10000 : toolCall ? 35000 : 15000;
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
  let response: globalThis.Response | undefined;
  let result: unknown;
  try {
    response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    if (watcherControl && [502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      throw new Error('Falha temporária na comunicação com a Ponte.');
    }
    result = await response.json();
    if (watcherControl && response.ok) {
      // The native controls always return tool content. SDK defaults must not turn
      // a truncated or unrelated JSON object into an apparently successful reply.
      if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) throw new Error('Resposta de acompanhamento inválida.');
      CallToolResultSchema.parse(result);
    }
  } catch (error) {
    // Access errors and missing records need investigation, not a blind retry.
    if (watcherControl && (!response || response.ok || [502, 503, 504].includes(response.status))) {
      const recovery = watcherRecovery(watchArgs?.watcherId, signal.aborted ? 'wait_interrupted' : 'communication_error');
      if (recovery) throw new WatchRecoveryError('A chamada ao acompanhamento não confirmou o estado da tarefa.', recovery);
    }
    if (toolCall && signal.aborted) throw new Error('Tempo limite ao aguardar a ferramenta. A ação pode ter sido concluída ou continuar em execução. Consulte o painel local ou bridge_job, se já tiver o jobId. Não reenvie a operação antes de conferir seu estado.');
    if (response) throw error;
    throw new Error('Não foi possível conectar à ponte local. Inicie npm start antes de conectar o cliente MCP.');
  }
  if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'A ponte recusou a solicitação.');
  return result;
}

main().catch(error => { process.stderr.write(`Ponte MCP: ${error instanceof Error ? error.message : 'falha inesperada'}\n`); process.exitCode = 1; });
