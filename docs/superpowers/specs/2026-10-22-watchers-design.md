# Watchers nativos da Ponte MCP

## Objetivo e limite de produto

Manter na Ponte o acompanhamento de uma tarefa delegada, sem usar agendamento, cron ou automations do ChatGPT/Claude. O caso central é enviar uma demanda ao Claude em uma sessão remota e aguardar a conclusão real, não o término de `tmux send-keys`. O monitor e o resultado sobrevivem ao encerramento da chamada e a reinícios da Ponte. Uma chamada MCP ativa pode aguardar seu resultado. Nenhuma API do produto promete reabrir um turno do ChatGPT sem um transporte de retomada oferecido pelo cliente.

## Escopo da versão 0.6.0

Um serviço WatchService separado de JobManager. Gatilhos: `signal` (sinal autenticado e correlacionado de um executor externo) e `job` (estado terminal de um job da Ponte, com seu significado explicitado). Sondagens arbitrárias de shell, leitura heurística de tmux e detecção por silêncio não entram nesta versão. O executor sinaliza `succeeded`, `failed` ou `needs_input` para a tarefa identificada. Fim de um turno Claude não significa, por si só, sucesso do trabalho.

Ferramentas MCP: `bridge_watch_create`, `bridge_watch_get`, `bridge_watch_list`, `bridge_watch_wait`, `bridge_watch_cancel`. A criação passa pela política de aprovação existente como ferramenta de risco write; aguardadores e consultas são roteados diretamente, sem ocupar slots de execução. Ferramentas usuais continuam compatíveis. As instruções orientam criar o watcher antes da delegação, configurar o produtor e usar `bridge_watch_wait`, sem chamar o agendador do cliente ou reenviar a operação.

## Contrato

Criação: `{name, trigger:{type:'signal',source,runId}|{type:'job',jobId}, timeoutMs?, idempotencyKey?}`. `name` tem 1–160 caracteres; source e runId 1–128; prazo padrão 1 h, mínimo 1 s e máximo 7 dias. `idempotencyKey` segue o formato já utilizado pela Ponte. A identidade é escopada pelo principal autenticado e a chave não pode ser reutilizada com outro conteúdo.

Objeto público: `{watcherId,name,trigger,status,createdAt,updatedAt,expiresAt,result?,error?}`. Estados: waiting, succeeded, failed, needs_input, cancelled, expired, interrupted. Resultado limitado contém summary, exitCode opcional e evidence opcional (objeto JSON limitado). Consultas normais e painel não retornam credenciais ou principal. Uma criação signal retorna adicionalmente `callback:{url,token,method:'POST',body:{eventId,runId,status,summary}}`, em que a URL é uma entrada da Ponte, nunca uma URL inventada do ChatGPT. A URL é `${publicUrl || apiUrl}/hooks/watchers/:watcherId/signal`.

Endpoint de sinal: POST na URL acima, Authorization Bearer de escopo exclusivo do watcher, corpo `{eventId:UUID,runId,status,summary,exitCode?,evidence?}`. Estado apenas succeeded/failed/needs_input. Tamanho total máximo 32 KiB. Mesmo eventId e corpo é replay idempotente; qualquer conflito posterior não sobrescreve resultado terminal. Credencial inválida e watcher inexistente não revelam dados. Tokens não aparecem em URL, auditoria, lista ou mensagens de erro. A chave derivada por HMAC de um segredo da instância permite repetir uma criação idempotente sem armazenar tokens individuais em claro; só o hash é persistido por watcher.

`bridge_watch_wait` aceita watcherId e waitMs (0–300000, padrão 25000). Aguarda com listeners, retorna imediatamente em estado terminal e limita aguardadores por watcher e globais. Desconexão retira só aquele aguardador. Prazo do watcher é independente do prazo de uma chamada. O caminho stdio ajusta somente o timeout desse método. Chamadas maiores precisam ser aceitas pelo cliente; o padrão curto é compatível com clientes mais restritivos. Resposta waiting contém a próxima chamada e deixa explícito que o monitor é durável, mas não acorda um chat encerrado.

## Persistência e segurança

Arquivo privado watchers.json, validação no carregamento, gravação serializada e atômica (temporário, sync, rename). Gravar estado terminal antes de confirmar o sinal e liberar aguardadores. Limitar a 100 watchers ativos e 500 registros totais; remover apenas terminais com política de retenção. Verificar propriedade em toda consulta/cancelamento; verificar grant ativo em sinais e esperas. Revogação termina como cancelled. Watcher signal pendente continua após restart. Watcher job desaparecido após restart vira interrupted. Pausa geral impede novas criações, mas aceita conclusões de tarefas já armadas.

Não lançar ou cancelar processos remotos automaticamente. Cancelar acompanhamento não desfaz o trabalho externo. Conteúdo recebido em summary/evidence é dado não confiável, não instrução. Sem dependências novas, Node >=22.12.0, TypeScript e padrões atuais do projeto.

## Painel e produtor

Seção Acompanhamentos com contagens, lista, status, fonte, prazo, detalhe do resultado e cancelamento. Distinguir watcher ativo de cliente esperando. Poll do painel reutiliza /admin/state; nenhuma credencial é mostrada na lista.

Script Node independente `scripts/ponte-watch-notify.mjs`: lê URL/token/runId de variáveis de ambiente, recebe status e resumo explícitos, envia um evento com UUID estável nas tentativas, timeout e retries limitados, proíbe redirect, só HTTPS ou loopback HTTP. Não imprime segredo nem assume sucesso pela ociosidade do Claude. Documentar envio explícito na sessão neurolaudos e uso com wrapper de processo; não instalar hooks globais ou executar novas demandas na VPS sem solicitação.

## Critérios de aceitação

Callback correto libera espera; token/runId incorretos e outro dono são recusados; duplicidade é idempotente e conflito não muda resultado; espera não ocupa a fila dos jobs; callback persiste antes da confirmação; reinício mantém sinal pendente e resultado; expiração/cancelamento/needs_input são distintos; job de delegação não termina watcher signal; grant revogado não entrega resultado; HTTP legado, MCP2 e stdio expõem as ferramentas; produtor passa teste contra endpoint local; build e suíte existentes permanecem verdes.
