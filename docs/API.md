# Referência da API e ferramentas — Ponte MCP 0.10.0

[Índice da documentação](README.md) · [Integrações](INTEGRACOES.md) · [Dots](DOTS.md) · [Watchers](WATCHERS.md)

Esta referência descreve a implementação atual. O schema devolvido pelo catálogo da sua instalação é a fonte dos argumentos aceitos, especialmente para ferramentas de servidores MCP externos. As rotas são definidas em [src/http.ts](../src/http.ts), as ferramentas da fachada em [src/mcp/server.ts](../src/mcp/server.ts) e o schema Actions em [src/openapi.ts](../src/openapi.ts).

## Interfaces e autenticação

| Interface | Endereço padrão | Autenticação |
|---|---|---|
| Painel e `/admin/*` | `http://127.0.0.1:4317` | Token `admin` nas operações administrativas |
| MCP HTTP | `http://127.0.0.1:4318/mcp` ou origem pública + `/mcp` | Bearer OAuth com scope `ponte:tools`, ou token API |
| REST `/v1/*` e proxy `/v1/mcp/*` | API na porta 4318 | Somente token `api`; não aceita o token OAuth nem o administrativo |
| Callback de watcher | `/hooks/watchers/{watcherId}/signal` na API | Bearer exclusivo daquele watcher |
| `GET /health` | Painel ou API | Sem token; confirma que o listener responde |
| `GET /openapi.json` | API | Sem token; exporta o schema usando a origem configurada |
| Descoberta e endpoints OAuth | API | Contrato próprio de OAuth; veja [ChatGPT](CHATGPT.md) |

Os controles de Host e Origin ainda se aplicam às rotas públicas. Para acesso remoto, configure `publicUrl` com uma origem HTTPS e encaminhe toda a API. Não publique o painel administrativo.

Tokens OAuth representam uma autorização específica; clientes REST/stdio que compartilham o token API compartilham a mesma identidade. Um cliente não consulta ou cancela um job/watcher de outra identidade apenas por conhecer seu ID. Jobs e watchers criados pelo painel usam a identidade API da instalação, compartilhada com esses clientes, e não a identidade de um grant OAuth. A autenticação do painel continua exigindo o token administrativo.

O MCP HTTP é stateless e usa POST. Um GET autenticado em `/mcp` retorna 405; isso não indica falha de instalação. O adaptador moderno oferece o subconjunto implementado do protocolo `2026-07-28`; clientes legados são atendidos pelo SDK. [MCP Events](MCP-EVENTS.md) documenta os cabeçalhos e métodos modernos.

## Perfis de conexão para Gemini e Grok

O estado administrativo `GET /admin/state` inclui `connection.clientProfiles` e `connection.apiTokenCommand`. São informações locais para montar o painel: os seis perfis contêm formato, conteúdo, disponibilidade, comando de cadastro quando aplicável e link oficial. Um perfil indisponível contém o motivo e não oferece um comando executável. O comando para consultar a credencial aponta para o `--state-dir` real, mas não inclui seu valor.

Esses campos não fazem parte de `bridge_status` nem de `GET /v1/status`; exportações não revelam o token API ou administrativo. `export-client` usa o mesmo gerador e escreve somente em um arquivo novo quando `--output` é informado. Os guias [Gemini](GEMINI.md) e [Grok](GROK.md) descrevem os formatos de cada cliente, os modelos de requisição `{url, body}` e a distinção entre chave do provedor e credencial MCP.

As APIs de modelos não criam uma autorização nova na Ponte quando usam o token API existente. Elas compartilham a identidade desse token com os demais clientes que o recebem. A allowlist das 12 ferramentas centrais inclui gateways capazes de alcançar o catálogo real; ela não constitui uma lista de alvos locais permitidos. As permissões, aprovações e a autorização do usuário continuam determinando o escopo das operações.

## Catálogos e descoberta

| Chamada | Conteúdo |
|---|---|
| MCP `tools/list`, perfil `full` | Oito ferramentas gerais da fachada, cinco de watchers, três de gerenciamento MCP, ferramentas locais e upstream |
| MCP `tools/list`, perfil `compact` | Oito ferramentas gerais da fachada e quatro controles de watchers: 12 descritores |
| `bridge_list_tools` | Catálogo real de ferramentas locais/upstream, `bridge_watch_create`, três `bridge_mcp_*` e quatro controles de watchers, nos dois perfis; paginação, pesquisa e filtro por origem |
| `GET /v1/tools` | Ferramentas que podem virar jobs, incluindo `bridge_watch_create` e as três `bridge_mcp_*`; não inclui os quatro controles diretos de watchers |
| `GET /v1/mcp/tools` | Catálogo MCP anunciado conforme `full` ou `compact`, usado pelo adaptador stdio |

`mcpToolExposure` escolhe o perfil em **Conectar IA → Catálogo MCP**, persistido pelo `PATCH /admin/settings`. `full` é o padrão, inclusive para configurações anteriores sem esse campo. `compact` reduz os descritores anunciados; não filtra o catálogo real nem controla acesso. Nomes diretos já conhecidos continuam chamáveis nos dois perfis. O endpoint `/mcp`, OAuth, a política de aprovação e as permissões permanecem os mesmos.

`bridge_list_tools` aceita `search`, `source`, `offset`, `limit` (padrão 25, máximo 50) e `includeSchemas` (padrão `true`). Use `includeSchemas: false` para pesquisar com descritores resumidos e `bridge_tool_schema` para obter o contrato completo do alvo escolhido. A rota REST `/v1/tools` mantém `search`, `source`, `offset` e `limit`, com padrão 20 e máximo 50; `includeSchemas` pertence à ferramenta MCP. `source` seleciona uma origem exata. Ambas as listagens devolvem `total`, `tools` e `nextOffset`.

As origens são `local`, `bridge:watchers`, `bridge:mcps` e `mcp:ID_DO_SERVIDOR`. O nome exportado de uma ferramenta upstream contém um namespace e pode incluir um hash. Nunca deduza esse nome a partir de um exemplo; descubra-o e use o `inputSchema` recebido.

## Ferramentas gerais da fachada

| Ferramenta | Argumentos | Comportamento |
|---|---|---|
| `bridge_status` | `{}` | Estado, versão, projetos, upstreams, política e contrato `directExecution` do servidor |
| `bridge_list_tools` | `search?`, `source?`, `offset?`, `limit?`, `includeSchemas?` | Catálogo real paginado; schemas incluídos por padrão |
| `bridge_tool_schema` | `tool` | Descritor atual do alvo e orientação `invocation`; não executa a ferramenta |
| `bridge_read` | `tool`, `argumentsJson`, `idempotencyKey?` | Chamar somente um alvo de risco `read`, com argumentos em string JSON |
| `bridge_invoke` | `tool`, `argumentsJson`, `idempotencyKey?` | Chamar um alvo do catálogo real, com argumentos em string JSON e as permissões existentes |
| `bridge_call` | `tool`, `arguments`, `idempotencyKey?` | Chamar um nome descoberto; ferramentas comuns criam jobs; controles de watchers seguem a rota direta |
| `bridge_job` | `jobId`, `waitMs?` | Consultar o mesmo job; espera de 0–25000 ms, padrão 0 |
| `bridge_cancel` | `jobId` | Solicitar cancelamento do job; não desfaz efeitos já ocorridos |

O perfil compacto anuncia essas oito ferramentas e `bridge_watch_get`, `bridge_watch_list`, `bridge_watch_wait` e `bridge_watch_cancel`. `bridge_watch_create` continua no catálogo real e pode ser chamado pelo gateway. Ferramentas locais, upstream, criação de watchers e gerenciamento MCP também aceitam seus nomes diretos quando o cliente já os conhece. Os wrappers permitem enviar a chave de idempotência e usar nomes recém-descobertos mesmo com `tools/list` em cache.

### Schema do alvo e argumentos JSON

`bridge_tool_schema` devolve o descritor diretamente: `name`, `title`, `description`, `inputSchema`, `risk` e `source`, acrescido de `invocation`. Não há um objeto externo `tool` envolvendo esse descritor. Em `invocation`, `tool` indica `bridge_read` ou `bridge_invoke`, `target` contém o nome exato do alvo e `argumentsJson` descreve a string obrigatória de argumentos. Esse retorno não preenche argumentos da tarefa nem é uma chamada pronta para executar.

`bridge_read` e `bridge_invoke` exigem que `argumentsJson` contenha um **objeto JSON válido**, como `"{}"` para um alvo cujo schema aceite objeto vazio. Arrays, `null`, valores escalares e JSON inválido são recusados. A string tem limite de **1 MiB**, e o envelope HTTP completo também precisa caber no limite de 1 MiB. Depois de decodificar, o `JobManager` valida os argumentos contra o schema atual do alvo antes de aceitar o job. Os controles diretos de watchers mantêm sua validação própria.

`bridge_read` recusa alvos de risco `write` ou `execute`. A restrição permanece enquanto o job aguarda: uma mudança de classificação não transforma uma leitura pendente em autorização para escrever. `bridge_invoke` anuncia anotações conservadoras para comportar alvos com efeitos externos; a classificação e a aprovação da operação efetiva continuam sendo as do alvo. `bridge_call` preserva seu contrato com `arguments` como objeto.

Exemplo de argumentos para `bridge_read`, após confirmar projeto e arquivo reais:

```json
{
  "tool": "local_read_file",
  "argumentsJson": "{\"projectId\":\"principal\",\"path\":\"README.md\"}",
  "idempotencyKey": "ler-readme-001"
}
```

Use o `inputSchema` retornado por `bridge_tool_schema` para construir chamadas de upstreams. A string JSON simplifica o schema do gateway, mas não relaxa a validação dos argumentos nem dispensa os identificadores exigidos pelo alvo. O guia [Dots](DOTS.md) mostra edição com `expectedHash` e descoberta sem nomes de upstream inventados.

A chamada inicial aguarda até 25 segundos enquanto o job estiver `queued` ou `running`; `pending_approval` retorna imediatamente. `bridge_job` pode aguardar também durante a aprovação. A aprovação `all` continua abrangendo leituras submetidas ao `JobManager`, inclusive por `bridge_read`.

Exemplo de argumentos para `bridge_call`:

```json
{
  "tool": "local_read_file",
  "arguments": { "projectId": "principal", "path": "README.md" },
  "idempotencyKey": "ler-readme-001"
}
```

A resposta é um `CallToolResult` MCP. Seu primeiro bloco de texto contém o estado com `jobId`, `status` e a ferramenta. Os blocos seguintes contêm o resultado da ferramenta, quando disponível, incluindo conteúdo não textual. Não presuma que todo resultado é um único objeto JSON plano. O `isError` e o estado terminal devem ser considerados ao interpretar o retorno.

Os gateways preservam os blocos de conteúdo e dados do resultado, inclusive imagens, dentro dos limites existentes. Não convertem o resultado completo em uma única string nem aumentam cotas, tamanho de resposta ou prazo de execução.

### O que `directExecution` confirma

Em `bridge_status`, `directExecution` descreve a capacidade da **Ponte**: `supported: true`, `executionLocation: "ponte_host"`, `requiresWorkSession: false`, `requiresCodexSession: false`, `toolExposure`, os nomes dos controles de catálogo/schema/leitura/invocação, `argumentEncoding: "json_object_string"` e `dynamicCatalog: true`. A própria resposta limita a afirmação com `clientToolAvailability: "not_observable_by_server"`, `hostPermissionsApply: true`, `clientMayDelegate: true` e `refreshClientAfterUpdate: true`.

Esses campos significam que a execução no servidor não exige criar uma sessão Work ou Codex. Não comprovam que um cliente específico carregou o plugin, disponibilizou cada ferramenta ao dot ou executou a tarefa sem delegação. [Dots](DOTS.md) separa esses testes. “Todas as ferramentas” designa as ferramentas registradas e autorizadas na Ponte, não ferramentas internas de outros plugins da conta.

## Ferramentas locais

Todas as ferramentas desta tabela passam pelo JobManager e pela política de aprovação. As permissões `allowWrite` e `allowExec` do projeto continuam sendo exigidas no modo automático. Os schemas completos estão em [src/tools/local.ts](../src/tools/local.ts).

| Ferramenta | Risco | Argumentos principais e resultado |
|---|---|---|
| `local_projects` | `read` | `offset?`, `limit?`; lista IDs, nomes e permissões |
| `local_list_files` | `read` | `projectId`, `path?`, `recursive?`, `maxDepth?`, `offset?`, `limit?`; lista entradas permitidas |
| `local_read_file` | `read` | `projectId`, `path`; conteúdo UTF-8 completo e `sha256` |
| `local_search` | `read` | `projectId`, `query`, `path?`, `caseSensitive?`, `maxResults?`, `maxDepth?`; busca literal, sem regex |
| `local_write_file` | `write` | `projectId`, `path`, `content`, `expectedHash`; cria ou substitui o arquivo completo |
| `local_edit_file` | `write` | `projectId`, `path`, `oldText`, `newText`, `expectedHash`; substitui uma única ocorrência exata |
| `local_create_directory` | `write` | `projectId`, `path`, `recursive?`; cria diretórios, por padrão incluindo pais ausentes |
| `local_exec` | `execute` | `projectId`, `executable`, `args?`, `cwd?`, `timeoutMs?`, `maxOutputBytes?`; executa sem shell implícito |

Caminhos de arquivo e `cwd` são relativos ao projeto e usam `/`; `.` representa sua raiz quando aceito pelo schema. As ferramentas recusam escapes, links e caminhos sensíveis. Terminal e programas MCP externos executam com os privilégios da conta local, conforme [Segurança](SEGURANCA.md).

Em gravação, `expectedHash: null` significa criar somente se o arquivo não existir. Para substituir, use o SHA-256 da leitura atual. A edição recusa trecho ausente, ambíguo ou hash desatualizado. Não há ferramenta local de exclusão ou movimentação de arquivos.

| Limite local | Valor |
|---|---|
| Arquivo de texto | 1 MiB de UTF-8; o JSON HTTP completo também deve caber em 1 MiB |
| Listagem | Até 10000 entradas examinadas; página de até 200; profundidade máxima 16 |
| Busca | Até 2000 arquivos e 16 MiB lidos; até 200 resultados; trecho de linha de até 1000 caracteres |
| Diff para revisão | Até 512 KiB e 2000 linhas alteradas |
| Execução de comando | Padrão 30000 ms; intervalo 100–120000 ms |
| Saída de comando | Padrão 128 KiB; configurável de 1 KiB a 1 MiB |

Resultados com `truncated: true` exigem refinar a consulta. Em `local_exec`, executável e argumentos são separados; para um shell, ele precisa ser solicitado explicitamente. No Windows, arquivos `.cmd`/`.bat` exigem um shell explícito. A ferramenta não aceita sobrescrever variáveis de ambiente.

## Gerenciamento de MCPs pelo chat

As três ferramentas têm origem `bridge:mcps` e passam pelo JobManager. São acessíveis por MCP direto, `bridge_call` ou `POST /v1/jobs`. A listagem também exige revisão em `all`; cadastro e reconexão exigem revisão em `mutations` e `all`, e executam automaticamente em `automatic`.

| Ferramenta | Risco | Argumentos e resultado |
|---|---|---|
| `bridge_mcp_list` | `read` | `offset?`, `limit?` (padrão/máximo 30); retorna plataforma, versão do Node, conexões com status/revisão, `total` e `nextOffset` |
| `bridge_mcp_add` | `execute` | `server`, `reason`, `sourceUrl?`; registra uma nova configuração, tenta conectar e retorna estado e até 20 ferramentas descobertas |
| `bridge_mcp_reconnect` | `execute` | `serverId`, `expectedRevision`, `reason`; confere a revisão atual e tenta reconectar sem editar a configuração |

`server` aceita `id`, `name`, `transport`, `command?`, `args?`, `cwd?`, `env?`, `url?`, `headers?`, `allowedTools?` e `timeoutMs?`, de acordo com o transporte. `enabled: true` e `readOnlyTools: []` são impostos pelo serviço e não devem ser enviados. `reason` aceita 1–1000 caracteres. A referência `sourceUrl` usa HTTPS sem credenciais, query ou fragmento. A URL do upstream também não aceita query/fragmento nem credenciais embutidas no contrato do chat.

Valores de `env` aceitam somente `${NOME}`; headers aceitam `${NOME}` ou `Bearer ${NOME}`. As referências são resolvidas no ambiente da Ponte ao conectar. Não envie segredos literais. A listagem não devolve comandos, argumentos, diretórios, URLs ou valores de credenciais de servidores existentes; a revisão é um HMAC opaco da configuração.

O resultado distingue `registered: true` de `server.status: "connected"`. Uma falha de conexão mantém o cadastro salvo, retorna diagnóstico seguro e marca a ferramenta com `isError: true`. Configuração normalizada idêntica com o mesmo ID retorna `alreadyPresent: true` sem reiniciar; configuração diferente é recusada sem substituir. A reconexão recusa uma revisão desatualizada. Edição e remoção permanecem administrativas.

Depois de conectar, use `bridge_list_tools` com `source: "mcp:ID"` e os nomes completos em `bridge_call`. O guia [MCPs pelo chat](MCPS-PELO-CHAT.md) apresenta schemas, exemplos, fila, cancelamento e diagnóstico. A implementação está em [src/mcp/management.ts](../src/mcp/management.ts).

## Ferramentas de watchers

| Ferramenta | Argumentos | Aprovação e resposta |
|---|---|---|
| `bridge_watch_create` | `name`, `trigger`, `timeoutMs?`, `idempotencyKey?` | Job de risco `write`; resultado contém `watcherId` e, para `signal`, callback de configuração |
| `bridge_watch_get` | `watcherId` | Consulta direta do acompanhamento e resultado |
| `bridge_watch_list` | `offset?`, `limit?` | Lista da identidade atual; padrão 50, máximo 500 |
| `bridge_watch_wait` | `watcherId`, `waitMs?` | Espera direta, padrão 25000 ms, intervalo 0–45000 ms |
| `bridge_watch_cancel` | `watcherId` | Cancela somente o acompanhamento, sem cancelar executor/job |

Os quatro controles diretos não ocupam os slots de execução nem criam pedidos de aprovação. Eles continuam autenticados e vinculados ao proprietário. O teto de 45000 ms vale no serviço, MCP direto, `bridge_call`, stdio e REST/Actions. Valores maiores são rejeitados, sem ajuste silencioso, com o mesmo `watcherId` e `nextCall` indicando `bridge_watch_get`. O cliente ainda pode interromper a chamada antes do limite.

`trigger` aceita exclusivamente:

```json
{ "type": "signal", "source": "claude-code", "runId": "execucao-001" }
```

ou, com um `jobId` real da mesma identidade:

```json
{ "type": "job", "jobId": "00000000-0000-4000-8000-000000000001" }
```

O UUID acima é ilustrativo e não identifica um trabalho existente. O nome aceita 1–160 caracteres; `source` e `runId`, 1–128, com restrições adicionais para controles/espaços em `runId`. `timeoutMs` define o prazo total do watcher: de 1000 a 604800000 ms (sete dias), com padrão 3600000 ms (uma hora). `expiresAt` registra seu vencimento. `waitMs` limita somente uma chamada; consultar, esperar novamente ou recuperar a criação idempotente não renova esse prazo total.

Detalhe, criação, espera e cancelamento informam `monitorDurable: true` e `canWakeClosedConversation: false`. Esses valores permanecem na 0.10.0, inclusive após entrega de Events. Resultados de executor são marcados como dados não confiáveis. Quando `waiting`, a resposta orienta a próxima espera de 25000 ms pelo mesmo ID; o chat continua durante o turno ativo até terminal ou limite concreto do cliente. A lista retorna `{watchers, total, offset, limit}` sem tokens de callback.

Falhas de comunicação tratadas pela Ponte retornam recuperação estruturada para `bridge_watch_get` com o mesmo `watcherId`, sem fabricar estado do acompanhamento. Isso inclui interrupção antes dos cabeçalhos, durante a leitura do corpo e HTTP 503 no adaptador stdio. Consulte o estado antes de retomar a espera. Erros de autenticação ou registro não encontrado exigem conferir autorização/ID; não autorizam retry cego, criação de outro watcher ou reenvio da tarefa. O [roteiro de recuperação](WATCHERS.md#recuperar-uma-espera-interrompida) detalha cada resultado.

O contrato completo de criação, callback, retenção, replay, expiração e estados está em [Watchers](WATCHERS.md). O evento `ponte.watcher.completed` usa `{watcherId}` e instrui a consulta do resultado por `bridge_watch_get`; `ponte.job.completed` continua restrito a jobs.

## REST e GPT Actions

O [OpenAPI de exemplo](../examples/gpt-actions.openapi.json) contém **nove operações**. Para obter a origem da sua instalação:

```sh
node dist/cli.js export-openapi --url "https://sua-ponte.exemplo.com" --output "ponte-openapi.json"
```

Use `Authorization: Bearer <token API>` e, para enviar JSON, `Content-Type: application/json`.

| Método e rota | `operationId` | Resultado |
|---|---|---|
| `GET /v1/status` | `getBridgeStatus` | Estado do serviço |
| `GET /v1/tools` | `listTools` | Catálogo paginado de ferramentas executáveis |
| `POST /v1/jobs` | `createJob` | HTTP 202 com job e campo `id`; não confirma execução |
| `GET /v1/jobs/{jobId}` | `getJob` | Estado e resultado disponíveis |
| `POST /v1/jobs/{jobId}/cancel` | `cancelJob` | Estado após solicitar cancelamento |
| `GET /v1/watchers` | `listWatchers` | Página de acompanhamentos da identidade API |
| `GET /v1/watchers/{watcherId}` | `getWatcher` | Acompanhamento e limites da continuidade |
| `POST /v1/watchers/{watcherId}/wait` | `waitWatcher` | Espera com corpo `{ "waitMs": 25000 }`, ou `{}` para o padrão |
| `POST /v1/watchers/{watcherId}/cancel` | `cancelWatcher` | Estado do acompanhamento cancelado |

`getJob` REST é uma consulta imediata; não oferece o `waitMs` de `bridge_job`. Cadastro, listagem e reconexão de MCPs usam `createJob` com o nome `bridge_mcp_*` correspondente; não acrescentam operações ao OpenAPI. Para criar watcher por Actions, use `createJob` com `tool: "bridge_watch_create"`, obtenha o resultado da criação e só então use as rotas de watchers.

Exemplo do corpo de `createJob`:

```json
{
  "tool": "local_read_file",
  "argumentsJson": "{\"projectId\":\"principal\",\"path\":\"README.md\"}",
  "idempotencyKey": "ler-readme-001"
}
```

A rota REST aceita **exatamente um** de `arguments` (objeto) e `argumentsJson` (string contendo objeto JSON). O schema de Actions usa `argumentsJson` e torna `idempotencyKey` obrigatório para orientar o cliente; a rota REST permite omitir a chave. Também aceita o cabeçalho `Idempotency-Key`; se houver chave no corpo e no cabeçalho, ambas precisam ser iguais.

O proxy local adicional `POST /v1/mcp/call` recebe `{ "name": "bridge_status", "arguments": {} }` e devolve um `CallToolResult`. Ele é usado pelo adaptador stdio e não faz parte das nove operações exportadas para Actions. HTTP 200 nesse proxy não significa sucesso da ferramenta: confira `isError`, estado e resultado.

## Estados, prazos e idempotência

| Entidade | Estados em andamento | Estados finais |
|---|---|---|
| Job | `pending_approval`, `queued`, `running` | `succeeded`, `failed`, `rejected`, `cancelled`, `expired` |
| Watcher | `waiting` | `succeeded`, `failed`, `needs_input`, `cancelled`, `expired`, `interrupted` |

`needs_input` encerra aquele acompanhamento: o chat deve apresentar a pendência e pedir intervenção, sem repetir esperas. Uma nova etapa explicitamente autorizada exige outro watcher. `expired` informa o vencimento do acompanhamento e não prova falha externa. `succeeded` de um job descreve a execução da ferramenta. Se ela apenas enviou uma mensagem a outro executor, isso não comprova o sucesso da tarefa delegada. O chat deve conferir a evidência pertinente do resultado.

| Controle | Regra da implementação |
|---|---|
| Jobs | Até 200 registros; quatro execuções simultâneas; resultado até 4 MiB; poda de registros finais ao submeter novos trabalhos quando a quantidade ou o total de registros excede o orçamento de 64 MiB |
| Aprovação | Pedido expira após 15 minutos |
| Execução de job | Até 120 segundos; ferramentas podem ter limite menor |
| Watchers | Até 100 ativos e 500 registros; descarte por capacidade somente de registros finais mais antigos |
| Esperas de watcher | Até 20 por watcher e 200 no serviço; não ocupam os quatro slots de jobs |
| HTTP geral | Corpo JSON até 1 MiB |
| Sinal de watcher | Corpo até 32 KiB; até 60 requisições autenticadas por watcher por minuto |

Há três níveis distintos de repetição:

1. **Job:** `idempotencyKey` do wrapper/REST recupera o mesmo job para a mesma identidade e os mesmos argumentos enquanto ele está retido em memória. Não é garantia persistente depois de reiniciar.
2. **Criação de watcher:** `idempotencyKey` **dentro dos argumentos** de `bridge_watch_create` recupera o mesmo acompanhamento enquanto seu registro persistido existir, inclusive após reiniciar. Se usar também a chave externa do job, mantenha ambas estáveis no reenvio.
3. **Sinal do executor:** o mesmo `eventId` e conteúdo podem ser reenviados sem duplicar o resultado. Um sinal conflitante depois de um estado final é recusado. O produtor preserva o ID nas tentativas da mesma invocação.

As chaves de job e criação de watcher aceitam letras, números, `.`, `_`, `:` e `-`, de 1 a 128 caracteres. Não reutilize uma chave para argumentos diferentes. Cancelamento, desconexão ou timeout não autorizam reenviar automaticamente uma operação com efeitos externos.

## Callback de sinal e MCP Events

`POST /hooks/watchers/{watcherId}/signal` recebe a conclusão do executor, com token exclusivo e corpo `{eventId, runId, status, summary, exitCode?, evidence?}`. `status` aceita `succeeded`, `failed` e `needs_input`. O serviço salva o resultado antes de confirmar sucesso. Detalhes de 400/401/409/413/429/503 e tentativas estão em [Watchers](WATCHERS.md).

No sentido oposto, MCP Events envia um evento da Ponte para o cliente. `events/list`, `events/subscribe` e `events/unsubscribe` são métodos do protocolo em `/mcp`, não ferramentas para `bridge_call`, rotas de sinal ou operações do OpenAPI. Desde a 0.8.0, a Ponte publica `ponte.job.completed` com `arguments: {jobId}` e `ponte.watcher.completed` com `arguments: {watcherId}`. Ambos exigem inscrição do cliente, escopo à identidade proprietária e webhook verificado/assinado. O evento de watcher contém somente `watcherId`, `status`, `createdAt` e `updatedAt`; resultado e credencial de sinal ficam fora do aviso. Veja [MCP Events](MCP-EVENTS.md).
