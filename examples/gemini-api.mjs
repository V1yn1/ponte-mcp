import { buildApiRequest } from '../dist/clients/profiles.js';

const DEFAULT_PROMPT = 'Use somente bridge_status da Ponte e informe a versão, a conexão e a disponibilidade das ferramentas. Não execute outra operação.';
const TIMEOUT_MS = 120_000;
const USAGE = 'Uso: node examples/gemini-api.mjs [--tools]\nVariáveis: GEMINI_API_KEY, GEMINI_MODEL, PONTE_MCP_URL, PONTE_API_TOKEN e PONTE_PROMPT opcional.\nSem --tools, somente bridge_status é disponibilizada.\n';

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Defina ${name} no ambiente antes de executar o exemplo.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`O valor de ${name} contém caracteres inválidos.`);
  return value;
}

function redactKnownSecrets(value) {
  let text = value;
  for (const secret of [process.env.GEMINI_API_KEY, process.env.PONTE_API_TOKEN]) {
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
    process.stdout.write(USAGE);
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--tools')) {
    throw new Error(USAGE.trim());
  }
  const apiKey = requiredEnvironment('GEMINI_API_KEY');
  const request = buildApiRequest('gemini', {
    model: requiredEnvironment('GEMINI_MODEL'),
    prompt: process.env.PONTE_PROMPT ?? DEFAULT_PROMPT,
    mcpUrl: requiredEnvironment('PONTE_MCP_URL'),
    mcpToken: requiredEnvironment('PONTE_API_TOKEN'),
    access: args.includes('--tools') ? 'tools' : 'status',
  });
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(request.body),
      signal,
      redirect: 'error',
    });
  } catch {
    throw new Error(signal.aborted
      ? 'A chamada à Gemini API excedeu 120 segundos. Ela pode continuar no provedor. Confira a execução e recupere os IDs existentes na Ponte antes de decidir outra ação; o exemplo não reenviou a tarefa.'
      : 'A comunicação com a Gemini API falhou. O resultado pode ser incerto; confira a execução na Ponte antes de repetir. Nenhuma repetição automática foi feita.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`A Gemini API respondeu HTTP ${response.status}. O corpo de erro foi omitido para não expor credenciais. Confira a configuração e o estado da tarefa antes de repetir.`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(signal.aborted
      ? 'A leitura da resposta excedeu 120 segundos. Recupere os jobs/watchers existentes na Ponte; não reenvie a operação para consultar seu resultado.'
      : 'A Gemini API não devolveu JSON completo. Confira a execução na Ponte antes de repetir; o exemplo não reenviou a tarefa.');
  }
  process.stdout.write(redactKnownSecrets(JSON.stringify(result, null, 2)) + '\n');
}

main().catch(error => {
  process.stderr.write(redactKnownSecrets(error instanceof Error ? error.message : 'Falha ao executar o exemplo Gemini.') + '\n');
  process.exitCode = 1;
});
