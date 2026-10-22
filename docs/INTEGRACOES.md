# Conexão com chats e outros servidores

[Índice da documentação](README.md) · [Referência da API](API.md) · [Operação](OPERACAO.md) · [Segurança](SEGURANCA.md)

Este guia descreve as entradas e os contratos de integração da Ponte MCP **0.7.0**. Os roteiros específicos estão em [CHATGPT.md](CHATGPT.md) e [CLAUDE.md](CLAUDE.md); os testes efetivamente realizados estão em [VALIDACAO.md](VALIDACAO.md). As referências externas foram consultadas em **22 de outubro de 2026**. Disponibilidade e permissões dos clientes dependem da conta, do workspace e do produto utilizado.

## Escolha a entrada do cliente

| Cliente ou fluxo | Entrada da Ponte | Requisitos |
|---|---|---|
| ChatGPT com MCP remoto | `https://SUA_ORIGEM/mcp`, OAuth com DCR | API acessível por HTTPS, `publicUrl` configurada e consentimento no painel local |
| Claude com conector remoto | `https://SUA_ORIGEM/mcp`, OAuth com DCR público | Origem HTTPS e aprovação local; roteiro em [CLAUDE.md](CLAUDE.md) |
| Claude Code | MCP HTTP com OAuth ou adaptador stdio | Escolher um transporte e seguir o [guia do cliente](CLAUDE.md) |
| Claude Desktop local ou outro cliente stdio | `node CAMINHO/dist/cli.js stdio --state-dir CAMINHO_DO_ESTADO` | Ponte já iniciada no mesmo computador; caminhos absolutos |
| Cliente MCP com Bearer configurável | `/mcp` em loopback ou HTTPS | Token API; access token OAuth também é aceito quando emitido pela Ponte |
| GPT personalizado com Actions | REST `/v1/*` e `/openapi.json` | Origem HTTPS e autenticação API Key/Bearer com o token API |
| Cliente compatível com MCP Events | Mesma entrada HTTP `/mcp`, protocolo `2026-07-28` | Descoberta de eventos e assinatura explícita do job pelo cliente; detalhes abaixo |
| ChatGPT com Secure MCP Tunnel | Entrada MCP HTTP ou stdio alcançável pelo cliente do túnel | Configuração e permissões próprias do túnel; detalhes abaixo |

Um chat sem ferramentas não executa operações da Ponte somente por receber uma URL ou instruções em texto. A Ponte não fornece uma chave de modelo e não remove cotas ou custos do chat ou dos serviços conectados.

## Acompanhar tarefas com watchers nativos

Para uma tarefa assíncrona delegada a outro executor, use as cinco ferramentas `bridge_watch_*` da própria Ponte. O fluxo não cria cron, automations ou agendamentos no ChatGPT/Claude:

1. Crie `bridge_watch_create` com `trigger.type: "signal"`, um `runId` exclusivo e uma `idempotencyKey` persistente.
2. Se a criação retornar `pending_approval`, aguarde esse `jobId` com `bridge_job` e conclua a aprovação no painel. Só prossiga quando o resultado contiver `watcherId` e callback.
3. Configure no executor a URL, o token exclusivo e o `runId` retornados. Para outro computador, use a URL pública HTTPS da API.
4. Delegue a tarefa uma única vez. O executor envia o recibo quando souber o resultado real: `succeeded`, `failed` ou `needs_input`.
5. Chame `bridge_watch_wait` para o mesmo `watcherId`. Se continuar `waiting`, use novas esperas limitadas dentro do turno ativo. Após reconectar, recupere o estado com `bridge_watch_get` ou `bridge_watch_list`.

O token de callback serve apenas para sinalizar aquele watcher. Não o substitua pelo token API, pelo token administrativo ou pelo access token OAuth; não o exponha em mensagens ou logs. O endpoint de entrada é `/hooks/watchers/:watcherId/signal`, que precisa ser encaminhado junto da API quando houver um executor remoto.

O gatilho `job` serve quando o próprio job da Ponte representa toda a operação observada. Um job que só enviou texto para tmux ou iniciou a delegação confirma somente esse envio. Para esperar a conclusão real do executor, use `signal`. A criação de um watcher também é um job curto: seu sucesso confirma a criação do acompanhamento.

Watchers e resultados limitados persistem, mas uma espera HTTP não dura para sempre. O padrão de `bridge_watch_wait` é **25000 ms**, com faixa de 0 a **300000 ms**, respeitando o timeout do cliente e dos intermediários. A desconexão encerra somente a espera; ela não cancela o monitor. O watcher não reabre uma conversa encerrada. `bridge_watch_cancel` encerra apenas o acompanhamento e não interrompe o executor ou o job original.

O roteiro completo, o recibo e a recuperação estão em [WATCHERS.md](WATCHERS.md). Os limites e as diferenças entre reinício de watchers `signal` e `job` estão em [ARQUITETURA.md](ARQUITETURA.md#watchers-acompanhamento-nativo-e-durável).

## MCP HTTP e OAuth

Configure `publicUrl` com a **origem HTTPS da API**, sem caminho, query, fragmento ou credenciais. A URL configurada identifica o emissor OAuth; o recurso protegido é essa origem acrescida de `/mcp`. A porta padrão da API é 4318. A porta administrativa, 4317 por padrão, permanece local.

O encaminhamento HTTPS precisa alcançar os caminhos da API sem adicionar um prefixo. Publicar apenas `/mcp` deixa descoberta, consentimento, renovação ou sinais de watchers inacessíveis.

| Caminho | Finalidade | Autenticação ou controle |
|---|---|---|
| `/.well-known/oauth-protected-resource` | Descoberta do recurso | Pública |
| `/.well-known/oauth-protected-resource/mcp` | Descoberta específica de `/mcp` | Pública |
| `/.well-known/oauth-authorization-server` | Metadados OAuth | Pública |
| `/register` | Registro dinâmico de cliente | Metadados validados pela Ponte |
| `/authorize` | Pedido de autorização | Cliente, redirect, recurso, scope e PKCE válidos |
| `/oauth/consent` e recursos da página | Exibir o código de verificação | Página pública; não recebe token administrativo |
| `/oauth/consent/status` e `/oauth/complete` | Acompanhar a decisão e retornar ao cliente | Identificador aleatório do pedido; conclusão exige decisão local |
| `/token` | Troca de código ou renovação | Método do cliente registrado; PKCE na troca inicial |
| `/revoke` | Revogar o grant vinculado ao token | Cliente correspondente |
| `/mcp` | Chamadas MCP por POST | Access token OAuth ou token API |
| `/v1/*` | REST, jobs, watchers e adaptador stdio | Somente token API |
| `/hooks/watchers/:watcherId/signal` | Recibo do executor | Token exclusivo do watcher |
| `/openapi.json` | Schema de Actions | Público |
| `/health` | Diagnóstico mínimo da API | Público |

Mesmo as rotas públicas passam pela validação de Host. `publicUrl` permite o Host da origem HTTPS; Host local válido também é aceito caso o túnel o reescreva. A Ponte mantém `trust proxy` desativado e não deduz o emissor a partir de headers encaminhados. Os contratos estão em [src/http.ts](../src/http.ts) e [src/auth/http.ts](../src/auth/http.ts).

### Registro e consentimento

A Ponte implementa authorization code com PKCE **S256**, DCR e scope **`ponte:tools`**. Aceita `none` para cliente público e `client_secret_post` para cliente com segredo. CIMD, `private_key_jwt` e `client_secret_basic` não são anunciados como métodos implementados. No ChatGPT, use o caminho OAuth com DCR descrito em [CHATGPT.md](CHATGPT.md), sem inventar credenciais de cliente. O [guia oficial de autenticação](https://developers.openai.com/plugins/build/auth) explica a escolha de registro pelo cliente.

O consentimento mostra um código de oito caracteres. O proprietário compara o código no painel local e aprova ou rejeita. A política `automatic` de ferramentas não aprova novas conexões OAuth.

O servidor anuncia `authorization_response_iss_parameter_supported: true` e inclui o `iss` exato nos redirects de sucesso e erro. Redirects HTTPS precisam corresponder exatamente ao cadastro. Para clientes nativos, callbacks HTTP de loopback aceitam variação somente da porta, mantendo host, caminho e query literais. A troca de código exige o URI completo usado na autorização. Use o redirect efetivamente registrado pelo cliente; não configure curingas. A implementação está em [src/auth/provider.ts](../src/auth/provider.ts).

### Validade, identidade e atualização

Pedidos aguardam aprovação por até **10 minutos**, códigos OAuth valem **2 minutos** e access tokens até **1 hora**. Grants renováveis têm prazo absoluto de **30 dias**; rotacionar o refresh token não estende esse prazo. Clientes sem `refresh_token` recebem autorização de até 1 hora. Reutilizar um refresh token já consumido revoga seu grant. `/revoke` e a ação de revogação do painel encerram o grant inteiro, sem apagar o cadastro DCR.

Cada grant OAuth possui sua identidade de jobs, watchers e assinaturas. Renovar tokens preserva esse vínculo; realizar novo consentimento cria outro. Clientes que usam o mesmo token API compartilham a identidade. Um cliente REST/stdio não acessa pela credencial API o job ou watcher de um grant OAuth diferente. Os projetos e as políticas de ferramentas continuam compartilhados; essa separação de registros não implementa usuários ou projetos isolados.

Mantenha uma origem HTTPS estável. Alterar `publicUrl` invalida as autorizações vinculadas ao emissor anterior e exige novo consentimento. Durante uma atualização, preserve o estado completo, incluindo `secrets.json`, `oauth.json` e `watchers.json`, conforme [OPERACAO.md](OPERACAO.md). Não recrie tokens para atualizar o catálogo.

Depois de atualizar a Ponte, atualize os metadados da conexão no cliente e confirme as três ferramentas `bridge_mcp_*` e as cinco `bridge_watch_*`. Os novos MCPs cadastrados durante uma conversa também podem ser descobertos por `bridge_list_tools` e usados por `bridge_call`, sem depender de uma nova listagem inicial do cliente. A [documentação de conexão do ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) orienta usar **Refresh** para MCPs personalizados e testar em uma nova conversa. Uma atualização de ferramentas não exige, por si só, apagar uma conexão OAuth válida. Em caso de `invalid_client`, confira preservação do estado, origem e cadastro antes de recomeçar o fluxo.

### Transporte legado e protocolo moderno

`/mcp` usa Streamable HTTP com respostas JSON e sem sessão persistente. Mensagens usam POST; GET autenticado retorna 405 e não mantém SSE. Sem credencial válida, a autenticação responde antes da verificação de método.

Versões legadas seguem o SDK **1.32.1**. Para `2026-07-28`, o adaptador HTTP da Ponte implementa `server/discover`, `tools/list`, `tools/call` e os três métodos `events/*`, exigindo os metadados e cabeçalhos correspondentes em cada requisição. O catálogo moderno anuncia somente `tools` e `events`. Isso é uma implementação delimitada do contrato HTTP moderno, não uma migração completa para o SDK v2. Os detalhes estão em [MCP-EVENTS.md](MCP-EVENTS.md) e [src/mcp/modern.ts](../src/mcp/modern.ts).

## Aprovação e espera

A política configurada no painel aplica-se às ferramentas locais, upstreams, `bridge_watch_create` e às três ferramentas `bridge_mcp_*`. A listagem de conexões é `read`; cadastro e reconexão são `execute`. `mutations` revisa escritas e comandos, `all` revisa todas as ferramentas submetidas ao `JobManager`, e `automatic` libera solicitações válidas. Permissões de projeto, listas permitidas, schemas e hashes continuam sendo verificados.

Consultas de catálogo/estado, controles de jobs e `bridge_watch_get/list/wait/cancel` têm caminhos diretos de controle. Eles não ficam aguardando uma nova aprovação de ferramenta. A espera de watcher não ocupa uma das quatro vagas de execução. Consulte [SEGURANCA.md](SEGURANCA.md#política-de-aprovação-e-operações-incertas) para mudanças de política, pausa e cancelamentos.

| Operação | O que espera | Prazo da chamada |
|---|---|---|
| Ferramenta MCP direta ou `bridge_call` | Job em `queued` ou `running`; `pending_approval` inicial retorna imediatamente | Até 25 segundos |
| `bridge_job` | Mesmo job, incluindo aprovação | `waitMs` entre 0 e 25000; padrão 0 |
| `bridge_watch_wait` / REST `waitWatcher` | Gatilho de um watcher existente | `waitMs` entre 0 e 300000; padrão 25000 |
| REST `getJob` / `getWatcher` | Consulta do estado atual | Sem parâmetro de espera |

Ao vencer uma espera, consulte o mesmo identificador. Não reenvie uma operação porque o resultado não chegou. `pending_approval`, `queued`, `running` e `waiting` não significam sucesso. Uma tarefa externa pode ter continuado mesmo após timeout, cancelamento ou perda de conexão.

## MCP Events, quando o cliente oferecer

Events é uma integração separada para **avisos de saída da Ponte ao cliente**. Watchers `signal` recebem **recibos de entrada do executor para a Ponte**. Eles têm endpoints, credenciais, persistência e finalidade diferentes. O fluxo de tarefas delegadas com watchers permanece nativo e não depende de criar uma assinatura de Events.

A [documentação oficial de MCP Events](https://developers.openai.com/plugins/build/mcp-events), consultada na data acima, lista suporte em Work no navegador, Work no desktop com Cloud selecionado e dots, sujeito aos controles do workspace. Não se deve inferir suporte a Events só porque uma conversa consegue chamar ferramentas MCP.

A Ponte expõe `ponte.job.completed` pelo protocolo HTTP `2026-07-28`. O cliente cria a assinatura por `events/subscribe`, fornecendo callback HTTPS e segredo de assinatura, e identifica um `jobId` pertencente à conexão. Esse é um método do protocolo, não uma ferramenta enviada a `tools/call`. A Ponte verifica o callback e, ao concluir o job, entrega um evento assinado; o cliente busca o resultado com `bridge_job`. A decisão de continuar a conversa pertence ao cliente e às instruções do usuário.

Um aviso entregue não comprova retomada da conversa. A Ponte não fornece callback ou segredo em nome do cliente, não cria assinaturas globais e não usa eventos para iniciar ciclos de chamadas. Em particular, inscrever o job de `bridge_watch_create` avisa somente que o acompanhamento foi criado; não existe evento de conclusão de watcher nesta versão.

Assinaturas, tentativas e cópias dos jobs acompanhados persistem com validade e capacidade limitadas. O painel mostra avisos e entregas; encerrá-los não cancela os jobs. O adaptador stdio não anuncia Events. Veja [MCP-EVENTS.md](MCP-EVENTS.md) para configuração, limites e diagnóstico.

## MCP local por stdio

O comando `stdio` lê as credenciais do diretório de estado e usa a Ponte já iniciada. Todos os clientes que leem esse mesmo token API compartilham a identidade, o painel e a política. Na configuração `mcpServers`, informe caminhos absolutos para o executável Node, `dist/cli.js` e `--state-dir`; os exemplos por cliente estão em [CLAUDE.md](CLAUDE.md).

O diretório padrão é `.ponte` dentro da instalação, não a pasta atual do terminal. Ao mudar de instalação, reutilize explicitamente o estado antigo. Não inclua tokens no JSON do cliente quando usar o adaptador local.

O adaptador estende o prazo da sua requisição interna somente para `bridge_watch_wait`, incluindo a chamada via `bridge_call`: espera solicitada mais 10 segundos. O cliente MCP ainda pode impor um timeout menor. Uma interrupção de espera preserva o watcher e orienta recuperar o mesmo ID. Código: [src/cli.ts](../src/cli.ts).

## Secure MCP Tunnel

O [guia oficial de Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) permite encaminhar MCP de um comando stdio ou endpoint HTTP acessível pelo `tunnel-client`. O cliente do túnel precisa permanecer ativo, associado à conta/workspace corretos e autenticado com as permissões necessárias. A Ponte fornece o servidor e o adaptador stdio; não provisiona o túnel na conta do usuário.

O caminho de OAuth público documentado neste projeto usa uma origem HTTPS que também atende descoberta e consentimento. Um `tunnel_id` não é essa origem. Tampouco se deve presumir que um túnel MCP publique `/hooks/watchers/*` como callback HTTP para executores externos; configure a conectividade do executor separadamente.

O guia do túnel informa um prazo absoluto de **120 segundos por requisição**, incluindo tempo na fila. Portanto, o máximo de 300 segundos aceito por `bridge_watch_wait` não garante que uma espera desse tamanho atravesse o túnel. Use a espera padrão de 25 segundos ou outra duração compatível, recuperando o mesmo watcher após interrupções. Os limites do túnel e do provedor permanecem válidos.

## Actions via HTTPS

Use `/openapi.json` da origem HTTPS da API e configure autenticação API Key/Bearer com o **token API**. O schema é público e não contém o segredo; as operações `/v1/*` exigem autenticação. Access tokens OAuth emitidos para `/mcp` não autenticam a REST.

O OpenAPI 0.7.0 define **nove operações**:

| Operação | Endpoint | Finalidade |
|---|---|---|
| `getBridgeStatus` | `GET /v1/status` | Estado da Ponte, projetos e capacidades |
| `listTools` | `GET /v1/tools` | Catálogo de ferramentas com schemas e risco |
| `createJob` | `POST /v1/jobs` | Solicitar uma ferramenta, inclusive `bridge_watch_create` e `bridge_mcp_*` |
| `getJob` | `GET /v1/jobs/{jobId}` | Consultar estado e resultado da execução |
| `cancelJob` | `POST /v1/jobs/{jobId}/cancel` | Solicitar cancelamento da execução |
| `listWatchers` | `GET /v1/watchers` | Listar acompanhamentos da identidade API |
| `getWatcher` | `GET /v1/watchers/{watcherId}` | Recuperar estado e resultado do acompanhamento |
| `waitWatcher` | `POST /v1/watchers/{watcherId}/wait` | Esperar o gatilho com prazo limitado |
| `cancelWatcher` | `POST /v1/watchers/{watcherId}/cancel` | Encerrar somente o acompanhamento |

`createJob` usa `tool`, `argumentsJson` e `idempotencyKey`. `argumentsJson` é uma **string contendo um objeto JSON**, conforme o schema descoberto por `listTools`; isso mantém o OpenAPI estável quando o catálogo muda. Clientes próprios também podem enviar `arguments` como objeto à REST, mas precisam escolher exatamente uma das duas formas.

Para criar um watcher, solicite `tool: "bridge_watch_create"` e inclua o `name`, o `trigger` e a chave persistente nos argumentos serializados. A chave externa de `createJob` deduplica o job em memória; a `idempotencyKey` dentro dos argumentos recupera o watcher persistido. Consulte `getJob` até obter o resultado da criação e configure o executor antes de delegar. Depois use os endpoints específicos de controle; não submeta `bridge_watch_wait` a `/v1/jobs`.

Não há operação REST remota para aprovar manualmente trabalhos ou mudar a política. Uma Action pode precisar de confirmação própria do cliente, além das regras locais da Ponte. `getJob` não aceita `waitMs`; `waitWatcher` aceita. Nenhum desses mecanismos de espera garante continuidade após encerrar a conversa.

Se a origem mudar, atualize `publicUrl` e reimporte o schema no cliente. A referência completa está em [API.md](API.md); a definição efetivamente servida é gerada por [src/openapi.ts](../src/openapi.ts).

## Servidores upstream

### Cadastrar pelo chat ou pelo painel

A versão 0.7.0 expõe `bridge_mcp_list`, `bridge_mcp_add` e `bridge_mcp_reconnect`. Um chat autorizado pode identificar uma capacidade que falta à tarefa, consultar as conexões existentes e solicitar um cadastro com justificativa e configuração confirmada na fonte oficial. Esse fluxo usa a política de aprovação atual, incluindo `automatic`, e mostra uma prévia em **Execuções**. As conexões aparecem no painel **Conexões MCP**.

O chat não substitui IDs existentes com configurações diferentes, não edita `readOnlyTools`, não remove conexões nem altera a política. Env/headers no contrato do chat aceitam somente referências de ambiente; edição e opções administrativas permanecem no painel. O resultado separa cadastro salvo de conexão estabelecida. Para reconectar, use a revisão retornada na listagem; para usar ferramentas novas na mesma conversa, consulte `bridge_list_tools` com `source: "mcp:ID"` e chame o nome retornado por `bridge_call`.

Veja [MCPs pelo chat](MCPS-PELO-CHAT.md) para os campos, exemplos por sistema operacional, falhas e reconexão. As três ferramentas também funcionam em Actions pelo `createJob` já existente; não é preciso acrescentar uma Action administrativa.

### stdio

Cadastre `command`, `args` e, se necessário, `cwd` e `env`. O executável precisa existir. A Ponte inicia o processo configurado, mas não instala um pacote MCP por conta própria; usar `npx` pode baixar e executar o pacote escolhido. No Windows, scripts `.cmd`/`.bat` exigem configuração de executável compatível, como `cmd.exe`, conforme as instruções do fornecedor.

O processo recebe o ambiente mínimo do SDK mais as variáveis explicitamente configuradas. Não herda indiscriminadamente o ambiente da Ponte. Variáveis sensíveis podem ser referenciadas por `${VARIAVEL}`, cujo valor é resolvido no ambiente do processo da Ponte; o campo precisa estar disponível quando ela for iniciada.

### Streamable HTTP e SSE

Use `transport: "http"` para Streamable HTTP ou `"sse"` para o transporte legado. URLs remotas precisam de HTTPS; HTTP é permitido para endereços locais aceitos pela configuração. Não coloque usuário/senha na URL. Para credenciais, configure headers e referências de ambiente.

Não há login OAuth interativo para upstreams nesta versão. São aceitos servidores sem autenticação ou com headers já configurados. Redirecionamentos são recusados, inclusive para não encaminhar headers a outro destino. O timeout padrão é 30 segundos e pode ser configurado entre 100 ms e 120 segundos. Falhas de transporte não fazem a Ponte repetir chamadas de ferramentas automaticamente.

### Catálogos e políticas

O hub pagina `tools/list`, limita o catálogo a **500 ferramentas por servidor** e recusa paginação circular. Nomes exportados usam namespace e hash determinísticos; descubra o nome exato no catálogo, em vez de construí-lo manualmente. A Ponte atualiza definições ao receber notificação de alteração do upstream. `bridge_list_tools` e `bridge_call` usam o catálogo atual; o cliente pode precisar atualizar seus metadados para mostrar os nomes novos diretamente na interface. A fachada HTTP stateless não anuncia um canal persistente de notificações de catálogo ao chat.

`readOnlyTools` e `allowedTools` usam os **nomes originais do upstream**. `readOnlyTools` identifica as chamadas tratadas como leituras no modo `mutations`; a anotação `readOnlyHint` recebida do servidor não concede essa classificação sozinha. `all` revisa também essas ferramentas e `automatic` libera as ferramentas expostas, mantendo validações e permissões.

| Configuração de `allowedTools` | Resultado |
|---|---|
| Campo omitido | Expõe todas as ferramentas descobertas |
| Lista de nomes | Expõe somente os nomes originais listados |
| `[]` | Não expõe ferramentas desse servidor |
| `null` em atualização administrativa | Remove uma restrição anterior |
| Campo omitido em atualização administrativa | Preserva a configuração existente |

No painel, a opção **Limitar ferramentas expostas** controla essa lista. Prefira limitar o catálogo à tarefa necessária e revisar o programa que será iniciado. Exemplos específicos estão em [ROBLOX.md](ROBLOX.md) e [PLAYWRIGHT.md](PLAYWRIGHT.md). As fontes do contrato são [src/core/config.ts](../src/core/config.ts), [src/mcp/hub.ts](../src/mcp/hub.ts) e a dependência fixada no [package.json](../package.json).
