import { buildApiRequest } from '../dist/clients/profiles.js';

const usage = 'Uso: node examples/grok-api.mjs [--tools]\nVariáveis: XAI_API_KEY, XAI_MODEL, PONTE_MCP_URL, PONTE_API_TOKEN e PONTE_PROMPT opcional.\n';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Configure ${name} no ambiente antes de executar.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`O valor de ${name} contém caracteres inválidos.`);
  return value;
}

function redactKnownSecrets(value) {
  let text = value;
  for (const secret of [process.env.XAI_API_KEY, process.env.PONTE_API_TOKEN]) {
    if (!secret) continue;
    text = text.split(secret).join('[CREDENCIAL OCULTA]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) text = text.split(escaped).join('[CREDENCIAL OCULTA]');
  }
  return text;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }
  if (args.length > 1 || args.some(arg => arg !== '--tools')) throw new Error(usage.trim());

  const apiKey = required('XAI_API_KEY');
  const options = {
    model: required('XAI_MODEL'),
    prompt: process.env.PONTE_PROMPT || 'Consulte bridge_status da Ponte e informe a versão observada, sem executar outra operação.',
    mcpUrl: required('PONTE_MCP_URL'),
    mcpToken: required('PONTE_API_TOKEN'),
    access: args.includes('--tools') ? 'tools' : 'status',
  };

  let request;
  try {
    request = buildApiRequest('grok', options);
  } catch {
    throw new Error('Configuração inválida. Confira XAI_MODEL, PONTE_MCP_URL (HTTPS terminado em /mcp), PONTE_API_TOKEN e PONTE_PROMPT.');
  }

  const signal = AbortSignal.timeout(120000);
  let response;
  let body;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal,
      redirect: 'error',
    });
    if (response.ok) body = await response.json();
    else await response.body?.cancel();
  } catch {
    const reason = signal.aborted ? 'A chamada atingiu o limite HTTP de 120 segundos.' : 'A comunicação com a API foi interrompida.';
    throw new Error(`${reason} O resultado da execução pode ser incerto. Nenhum reenvio foi feito. Consulte os jobs/watchers existentes na Ponte pelo mesmo ID e confira o destino antes de repetir uma ação.`);
  }

  if (!response.ok) {
    throw new Error(`A API xAI respondeu HTTP ${response.status}. Nenhum reenvio foi feito. Se a requisição envolvia uma ação, confira o job/watcher existente antes de repeti-la.`);
  }
  process.stdout.write(redactKnownSecrets(JSON.stringify(body, null, 2)) + '\n');
}

main().catch(error => {
  process.stderr.write(redactKnownSecrets(error instanceof Error ? error.message : 'Falha ao executar o exemplo Grok.') + '\n');
  process.exitCode = 1;
});
