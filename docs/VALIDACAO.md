# Validação das entregas — Ponte MCP 0.8.0

[Índice da documentação](README.md) · [Histórico de versões](../CHANGELOG.md) · [Operação](OPERACAO.md)

Este documento registra a evidência de cada etapa. Os números de testes são os observados na entrega indicada, não uma nova execução feita ao editar a documentação. Registros históricos de erro não descrevem automaticamente o estado atual do produto; a verificação manual posterior de Events está registrada junto do diagnóstico original.

## Recuperação de esperas e eventos de watchers — 0.8.0

Registro de **22 de outubro de 2026**. O caso externo abaixo foi anonimizado: não publica nomes de clientes, demanda, identificadores reais, credenciais, infraestrutura ou conteúdo do produto. O relato da execução, a leitura atual do estado e os testes controlados têm alcances diferentes.

| Origem da evidência | O que foi observado | O que essa evidência permite afirmar |
|---|---|---|
| Relato do usuário sobre execução externa | O executor concluiu implementação e publicação, enviou callback `succeeded` e houve conferência posterior no sistema de acompanhamento | O usuário relatou uma tarefa concluída e seu recibo. Esta revisão não executou o trabalho externo nem verificou diretamente sua publicação |
| Relato do usuário sobre as esperas | Chamadas de 25–45 segundos funcionaram; uma espera com `waitMs: 300000` terminou em timeout do cliente MCP; recuperar o mesmo watcher funcionou | O timeout da chamada não demonstrou falha do executor nem perda do acompanhamento. O relato motivou limitar a 45 segundos cada chamada da 0.8.0 |
| Consulta real de leitura nesta revisão | `bridge_watch_get` recuperou `succeeded` e o resultado preservado do watcher original | O registro terminal estava acessível pelo mesmo ID. A consulta não recriou o watcher, não reenviou a demanda e não reexecutou o executor |
| Descoberta real do cliente nesta revisão | A conexão consultada anunciou **0.6.0**; a descoberta da fonte e de seu schema retornou **somente `ponte.job.completed`** | A instalação conectada não ofereceu o novo evento `ponte.watcher.completed` da 0.8.0. A versão do código local não prova atualização da instalação do usuário |
| Tentativa de validação do novo evento no cliente | A verificação ficou limitada à descoberta da instalação anterior; nenhuma inscrição ou tarefa agendada foi criada | Não houve teste real de recebimento do novo evento nem de resposta após o encerramento do turno |
| Testes locais automatizados da 0.8.0 | Tipos, **293 testes**, build e smoke concluídos; detalhes abaixo | Confirmam os contratos exercitados em ambiente controlado, sem comprovar retomada no cliente instalado |

### Verificações locais executadas

Os comandos foram executados separadamente. A suíte usou estado, portas, clientes e receptores controlados; não reexecutou a demanda externa relatada pelo usuário.

Após a revisão independente, `npm run verify` repetiu a checagem de tipos, os **293 testes** e a compilação no código preparado para integração; todas as etapas passaram.

| Verificação | Resultado observado |
|---|---|
| `npm run check` | Concluído sem erros de TypeScript |
| `npm test` | **293 testes aprovados**, zero falhas e zero ignorados |
| `npm run build` | Compilação concluída |
| `npm run smoke` | Concluiu OAuth/DCR/PKCE e emissor, MCP legado/moderno, aprovação manual/automática, cadastro de MCP e uso do catálogo em cache, Events de job e watcher com assinatura HMAC e cancelamento da inscrição, sinal nativo persistido, renovação/revogação e `canWakeClosedConversation: false` |
| Espera e recuperação | Contrato de 45000 ms conferido em status, catálogo e OpenAPI; excesso de prazo rejeitado com consulta do mesmo ID; esperas interrompidas recuperaram `succeeded`, `failed` e `needs_input` sem reenviar a tarefa |
| Events de watcher | Inscrição, filtro/proprietário, estado terminal durante a verificação, reinício, retries e metadados sem resultado/token exercitados com receptor controlado; HTTP 2xx não alterou a capacidade de retomada |
| Revisão independente | Nenhum achado material restante; um probe isolado confirmou que falha temporária ao gravar Events não reverte o watcher e que a reconciliação produz uma única entrega, sem deadlock |
| Documentação | **25 arquivos Markdown**, **319 referências locais e âncoras**, **33 blocos JSON** e **13 blocos sh/bash** conferidos; `bash -n` validou sintaxe sem executar os exemplos |
| OpenAPI | O exemplo publicado corresponde exatamente à exportação da CLI compilada, com nove operações |
| Sintaxe e diff | `node --check public/app.js`, `node --check scripts/smoke.mjs` e `git diff --check` passaram |

Esses resultados validam a implementação local. O receptor de webhook controlado não é uma conversa real do ChatGPT após encerramento do turno. A leitura de arquivos antigos de Events é compatível com a 0.8.0; retornar a um código anterior requer backup de estado anterior compatível, porque o campo novo `watcherArchives` pode ser recusado por schemas antigos.

### Consequências para o contrato

O padrão de `waitMs` permanece 25000 ms e seu máximo passa a 45000 ms em todas as interfaces. O valor histórico de 300000 ms acima descreve o incidente na instalação anterior; não é recomendação atual. Um valor acima de 45000 é rejeitado com recuperação pelo mesmo ID, sem reduzir silenciosamente a espera. Falhas de comunicação orientam `bridge_watch_get` sem inventar estado.

Enquanto `waiting`, o chat deve continuar o turno ativo com esperas de 25000 ms pelo mesmo ID até terminal ou limite concreto do cliente. O prazo total (`timeoutMs`/`expiresAt`) não é renovado por essas chamadas. `needs_input` é terminal: informe a pendência, peça intervenção e aguarde autorização explícita para outra etapa com novo watcher. `expired` não prova falha da tarefa externa.

`monitorDurable: true` e `canWakeClosedConversation: false` permanecem na 0.8.0. A [documentação oficial de MCP Events](https://developers.openai.com/plugins/build/mcp-events), consultada nesta data, separa aceite HTTP do processamento assíncrono. O novo evento, sua assinatura e os retries no servidor não provam que a conversa respondeu. Para comprovar isso na instalação do usuário, será necessário descobrir `ponte.watcher.completed` em uma instância 0.8.0, observar a inscrição aceita, a entrega e a consulta do mesmo watcher seguida de resposta após o turno anterior encerrar.

A pesquisa de [Claude Code Channels](https://code.claude.com/docs/en/channels) e da [referência de canais próprios](https://code.claude.com/docs/en/channels-reference) identificou um possível caminho futuro, que depende de opt-in e de sessão/processo em execução. Nenhum canal Claude foi implementado ou validado nesta entrega. O fluxo atual usa watchers nativos; não cria cron, polling ou agendamentos no ChatGPT/Claude.

## Histórico: cadastro de MCPs pelo chat — 0.7.0

Verificação em **22 de outubro de 2026**, em Linux com Node.js **24.19.0**. Os testes usaram diretórios, credenciais, processos MCP e portas locais temporários. Nenhum MCP foi instalado no computador do usuário e nenhuma conta real de ChatGPT ou Claude foi modificada nesta entrega.

| Verificação | Resultado observado |
|---|---|
| `npm run verify` | TypeScript, **257 testes**, zero falhas, zero ignorados e build concluído |
| Núcleo de gerenciamento | **18 testes**: prévia sem efeitos, aprovação, rejeição, pausa, modo automático, listagem segura, referências de ambiente, IDs conflitantes/idempotentes, concorrência com o painel, revisão obsoleta, falha de conexão e de armazenamento, cancelamento, revogação e encerramento |
| Integração HTTP/MCP | **2 testes** com o serviço real: cliente autenticado cadastra após aprovação e chama a ferramenta recém-descoberta pelo broker; REST Actions cadastra em modo automático, reaproveita a chave de idempotência e continua sem acesso administrativo |
| `npm run smoke` | Build compilado completou OAuth/DCR/PKCE, aprovação do cadastro MCP, persistência, descoberta e chamada da ferramenta nova sem recarregar `tools/list`, além dos fluxos existentes de arquivos, modo automático, Events e watcher nativo |
| Revogação OAuth no smoke | Um cadastro pendente foi aprovado depois de revogar seu grant; o job falhou, nenhum servidor foi registrado e o token revogado recebeu 401 |
| Painel | Sintaxe JavaScript e execução das funções reais do renderer em VM passaram; HTML gerado conferido para escape, links HTTPS, referências sem valores literais, reconexão sem configuração privada, política, pendências, estado salvo/conectado e preservação de detalhes/rolagem |
| Documentação | **25 arquivos Markdown**, **314 referências locais**, **33 blocos JSON**, **13 blocos sh/bash** e três exemplos JSON conferidos; OpenAPI igual à exportação da CLI, com **nove operações** |
| Revisão independente | Nenhum achado material restante; reexecução dos 18 testes do núcleo, dos dois testes HTTP e de `git diff --check` passou |
| Formatação | `git diff --check`, `node --check public/app.js` e `node --check scripts/smoke.mjs` passaram |

O fluxo de integração manteve o catálogo inicial do cliente intacto. Depois de cadastrar e conectar um MCP de teste, `bridge_list_tools` filtrou sua origem, devolveu o nome e schema novos e `bridge_call` executou a ferramenta após a aprovação correspondente. A anotação de leitura declarada pelo upstream não dispensou a política: as ferramentas cadastradas pelo chat continuaram classificadas como `execute`.

O teste de conexão indisponível confirmou o resultado `registered: true` com estado de erro e a configuração mantida no disco. Outra chamada corrigiu o ambiente e reconectou usando a revisão atual. Os testes de cancelamento distinguem a espera pela fila, que não pode gravar depois de cancelada, da gravação já aceita, cuja reconciliação com o hub deve terminar.

**Limites desta verificação:** não houve execução desta versão no Windows/macOS, instalação real do Playwright ou Roblox, login em conta real do ChatGPT/Claude nem teste pelo túnel ngrok. O navegador Chromium não estava instalado; o painel teve validação de renderer e CSS, sem inspeção visual renderizada. A fila de gerenciamento aguarda a descoberta: o tempo em espera conta no prazo do job, e fechar o serviço pode aguardar uma conexão já aceita. Pausa e mudança de política preservam trabalhos que já estão em `running`; cancelar após persistir não desfaz o cadastro. Esses limites não são uma promessa de instalação universal, login OAuth de upstreams ou retomada de uma conversa encerrada.

## Histórico: revisão integral da documentação — 22/10/2026

Esta revisão manteve o programa na **0.6.0** e alterou guias, exemplos e instruções. O conteúdo foi confrontado com os schemas, rotas, CLI e serviços da versão atual; as orientações dos clientes e upstreams foram conferidas nas fontes oficiais vinculadas em cada guia.

| Verificação documental | Resultado |
|---|---|
| Cobertura | 24 arquivos Markdown revisados, incluindo índice, operação, API, changelog e arquivo histórico; instruções de chat e projeto de demonstração atualizadas |
| Links relativos e âncoras | 287 referências locais conferidas; uma âncora antiga do README foi corrigida |
| Exemplos estruturados | 27 blocos JSON dos documentos e os três arquivos JSON de exemplos válidos |
| Exemplos de shell | 13 blocos `sh`/`bash` passaram em `bash -n`; essa análise não executa os comandos nem valida PowerShell |
| CLI e OpenAPI | Ajuda da CLI compilada conferida; exemplo OpenAPI regenerado de 0.5.0 para 0.6.0 e comparado com o gerador atual, com nove operações |
| Revisão independente | Corrigidos o vínculo de identidade dos jobs criados pelo painel e a descrição do orçamento de memória; guias de clientes, watchers e upstreams revisados sem achado importante restante |
| Formatação e escopo | `git diff --check` passou; nenhum arquivo de implementação, teste ou dependência foi alterado |

Não houve nova execução dos 237 testes do produto nesta revisão documental, nova autenticação em conta de cliente, teste no computador do usuário, instalação de upstream, renderização de navegador ou envio de sinal a tarefa real. A evidência da implementação da 0.6.0 está registrada abaixo; o teste manual histórico de Events permanece identificado separadamente.

## Histórico: watchers nativos da Ponte — 0.6.0

Verificação em **22 de outubro de 2026**, em Linux com Node.js 24.19.0. Os testes usam arquivos, credenciais, portas e executores controlados. Nenhuma demanda real do Slack foi encaminhada e nenhuma sessão real do Claude foi alterada nesta validação.

| Verificação | Resultado observado |
|---|---|
| `npm run verify` | TypeScript, **237 testes**, zero falhas, zero ignorados e build concluído |
| `npm run smoke` | Aplicação compilada completou OAuth, MCP legado/moderno, aprovação, Events existente e watcher nativo com sinal autenticado e resultado persistido |
| Serviço de watchers | **18 testes**: persistência, reinício, proprietário, correlação, replay, conflito, expiração, revogação, pausa, limites, corrupção, falha de disco, concorrência, encerramento e retenção do resultado de job removido |
| Integração HTTP | **7 testes**: criação com aprovação, quatro esperas sem ocupar a fila, produtor real, desconexão/reinício, isolamento OAuth, MCP legado/moderno, REST, ocultação de token no painel, I/O com retry e tráfego inválido sem esgotar a cota legítima |
| Produtor | **7 testes HTTP**: sinal autenticado, código de saída, validação antes do envio, limites UTF-8, retries com UUID e bytes estáveis, recusa de redirect e erros sem credenciais |
| Stdio real | Processo CLI conectado ao serviço real descobriu as cinco ferramentas, criou um watcher e recebeu a conclusão pela chamada em espera |
| Prazo do stdio | Duas regressões novas exercitam 300 segundos com relógio controlado, inclusive via `bridge_call`, preservando prazos menores para as demais ferramentas e prazo finito para a espera |
| Painel e documentação | Sintaxe JavaScript, IDs/ARIA, contratos de consulta/cancelamento, projeção de campos públicos, escape de resultado e schemas OpenAPI conferidos; `git diff --check` passou |
| Revisão independente | Correções conferidas para token no painel, erro de disco classificado como 400, cota global consumida sem autenticação, registro tardio de waiter durante close e perda de evento terminal após remoção do job |

O teste de ponta a ponta manteve quatro chamadas em espera enquanto outra ferramenta gravou um arquivo normalmente. Esse job de delegação concluído não encerrou o watcher `signal`. O script produtor enviou o resultado, que foi salvo antes da confirmação e liberou as quatro esperas. Outro teste interrompeu a conexão HTTP, reiniciou o serviço e concluiu o mesmo watcher com sua credencial original.

O acompanhamento usa `bridge_watch_create/get/list/wait/cancel` e o endpoint de entrada `/hooks/watchers/:watcherId/signal`. Não usa agendamento do ChatGPT ou do Claude. A cota do sinal é autenticada e escopada por watcher. O segredo aparece apenas no resultado de criação recuperável pelo proprietário; o arquivo de watchers mantém seu hash e os caminhos de painel/arquivamento removem a credencial.

**Limites desta verificação:** não houve nova execução no Windows 11, inspeção visual renderizada do painel, teste do watcher por uma conversa real do ChatGPT, sessão real do Claude ou túnel ngrok. As esperas foram exercitadas por clientes MCP de teste e pelo produtor real em loopback. O watcher persiste durante reconexões/reinícios do processo, mas isso não prova tolerância a falha física de disco/energia. A Ponte não promete reabrir um turno encerrado: a espera requer uma chamada mantida pelo cliente. Atualize a instalação, reinicie o serviço e recarregue o catálogo antes de usar a versão 0.6.0.

## Histórico: Claude, diagnóstico de Events e identidade visual — 0.5.0

Verificação em **22 de outubro de 2026**, com Node.js 24.19.0 e npm 11.9.0 em Linux, mais uma conferência restrita de argumentos no PowerShell da instalação Windows conectada. Os testes do servidor usam estado, portas e credenciais temporários.

| Verificação | Resultado observado |
|---|---|
| `npm run verify` | TypeScript, **202 testes**, zero falhas, zero testes ignorados e build concluído |
| `npm run smoke` | Aplicação compilada concluiu OAuth, catálogo e chamadas MCP, aprovação manual/automática, descoberta moderna, inscrição, desafio, entrega assinada e encerramento com receptor controlado |
| OAuth | **22 testes de provider e 8 HTTP**; incluem callback hospedado do Claude, DCR público, PKCE, callback local com porta temporária, troca de código vinculada ao endereço aprovado, renovação e regressão do ChatGPT |
| Diagnóstico de Events | **5 testes novos** cobrem descoberta sem inscrição, contadores antes da validação de parâmetros, reinício, cache de verificação, falha, ausência de segredos, cópias isoladas e ordenação de requisições concorrentes |
| Comando Claude Code | **4 testes novos**, incluindo execução do comando gerado com um `claude` de teste em shell POSIX, preservação de apóstrofos e metacaracteres e recusa de controles |
| PowerShell real | Três URLs com caracteres especiais chegaram como o mesmo argumento literal à função de teste; processo terminou com código 0 e sem saída inesperada. Nenhum Claude foi instalado ou acionado por esse teste |
| Arquivos públicos compilados | Logo respondeu HTTP 200 e `image/png` no painel e no consentimento, com bytes iguais ao asset; helper do comando respondeu 200 |
| JavaScript e diff | Sintaxe de `app.js`, `client-commands.js` e `consent.js`, mais `git diff --check`, passaram |
| Revisão independente | Dois achados corrigidos e rechecados: URL sem cotação no comando copiado e indicação incorreta durante a verificação do callback |

O callback nativo de Claude Code anteriormente recebia 400 quando usava uma porta local diferente da registrada. A correspondência agora permite apenas essa variação, preservando host, caminho e query literais. O preflight também impede que o SDK envie redirects de erro para endereços locais com fragmento, credenciais embutidas ou caminho normalizado diferente. A troca do código continua vinculada ao URI completo aprovado, incluindo a porta.

### Resultado da conexão real com ChatGPT

A Ponte conectada respondeu **0.4.0**, com aprovação automática, dois projetos e o upstream Roblox conectado. Chamadas de ferramentas funcionaram. A descoberta nativa apresentou o evento `ponte.job.completed` e seu schema com `jobId`.

A criação nativa de uma tarefa de teste retornou **`Webhook connectors could not be validated before creation.`**, sem identificador de automação. Uma consulta confirmou ausência de tarefa criada. Uma nova tentativa com outro trabalho válido, depois de atualizar a descoberta, retornou o mesmo erro.

A captura do ngrok examinada antes e depois daquela tentativa continha `server/discover`, `events/list` e `tools/list` com HTTP 200, e **nenhum `events/subscribe`** nessa janela. Isso localizou a interrupção antes de a Ponte receber a assinatura observada; não identificou a causa interna da validação do cliente. Naquela tentativa não houve evidência de que o callback, o desafio ou a verificação HMAC tivessem sido alcançados. O diagnóstico da 0.5.0 tornou essas etapas visíveis; sua implementação, por si só, não demonstrou a correção do bloqueio externo.

### Verificação manual posterior de Events no ChatGPT

Ainda em **22 de outubro de 2026**, uma nova conversa do ChatGPT concluiu a inscrição de teste. O registro de tela da sessão confirmou o recebimento e a validação de `ponte.job.completed`, seguidos de uma consulta única ao job com `waitMs: 0`, estado `succeeded` e ferramenta `local_projects`. A inscrição de teste foi pausada após a confirmação. Identificadores de conversa, automação e trabalho, assim como a captura privada, não são publicados neste repositório.

Essa evidência manual mostra que o fluxo de Events funcionou naquela sessão posterior. Ela não estabelece a causa interna da tentativa anterior, não garante suporte em toda conta/cliente e não substitui um teste dos watchers da v0.6.0. O mecanismo de inscrição do cliente usado nesse teste pertence ao fluxo separado de Events; os watchers nativos não dependem dele nem criam agendamentos no chat.

### Painel e logotipo

Foram removidas as rotações que inclinavam os cards “Chat” e “Ferramentas” e corrigido o recuo dos parágrafos do card de eventos. A nova paleta usa azul cobalto, grafite e fundos claros. O logotipo PNG tem 1254 × 1254 pixels e canal alfa transparente, e está integrado ao painel e ao consentimento. O histórico da criação está em [IDENTIDADE-VISUAL.md](IDENTIDADE-VISUAL.md).

A auditoria estática conferiu IDs únicos, referências ARIA, scripts externos, assets existentes, regras responsivas e ausência das rotações. A revisão executou o renderer de diagnóstico com estados sem tentativa, em andamento, sucesso e falha. **Não houve inspeção renderizada em navegador nesta entrega:** o navegador local não estava disponível nesta sessão; o navegador remoto não alcançou a instância local e a abertura de arquivo foi bloqueada por sua política. Nenhum caminho alternativo foi usado para contornar o bloqueio. Essa limitação impede afirmar validação visual por screenshot.

### Limites restantes

A suíte e o smoke daquela entrega não comprovaram uma conexão em conta real do Claude nem a retomada de conversa pelo ChatGPT. Naquele momento, a instalação Windows conectada ainda precisava receber a 0.5.0 e reiniciar. O teste PowerShell verificou somente a preservação dos argumentos no comando copiado; não comprovou instalação ou autenticação do Claude Code. A verificação manual posterior de Events está descrita acima. Para uma instalação atual, siga [CLAUDE.md](CLAUDE.md) e confira `bridge_status`/`local_projects`.

## Histórico: MCP Events e continuidade por trabalho — 0.4.0

Verificação em 22 de outubro de 2026, com Node.js 24.19.0 e npm 11.9.0 em Linux. As integrações usam diretórios, credenciais, portas e um receptor de webhook controlados, separados da instalação do usuário. A versão 0.4.0 inclui também a aprovação automática e a espera de resultados da 0.3.0.

| Verificação | Resultado observado |
|---|---|
| `npm run verify` | TypeScript, **188 testes**, zero falhas, zero testes ignorados e build concluído |
| `npm run smoke` | Programa compilado completou OAuth, ferramentas MCP legadas, aprovação manual e automática, descoberta MCP 2.0, assinatura, desafio, HMAC, aviso de conclusão e encerramento da assinatura |
| HTTP e OAuth | **6 testes** verificam descoberta autenticada, JSON malformado, escrita real após aprovação, evento sem conteúdo do arquivo, consulta do resultado após reinício, cancelamento administrativo, isolamento entre conexões e bloqueio após revogação/mudança de origem |
| Serviço de Events | **22 testes** cobrem propriedade do trabalho, identidade determinística, renovação, conclusão antes/durante a inscrição, fila persistente, resultado retido, interrupção no reinício, cancelamento durante verificação/envio, rotação de chaves, validade, retentativas, capacidade, estado inválido e recusa imediata de verificações concorrentes excedentes |
| Transporte de callback | **16 testes** cobrem vetor HMAC calculado independentemente, desafio, validação de chave/URL/IP/DNS, conexão ao IP verificado, alternativa IPv6/IPv4, ausência de redirects, limites de dados/tempo, cancelamento e diagnósticos sem segredos |
| Adaptador MCP moderno | **15 testes** cobrem o protocolo `2026-07-28`, metadados, cabeçalhos espelhados, IDs válidos, descoberta, ferramentas, Events, erros e encaminhamento de clientes legados ao SDK anterior |
| Trabalhos e autorização | **3 testes** de origem privada, idempotência por conexão e observação terminal, além da regressão OAuth para identidade estável após rotação de tokens |
| JavaScript e diff | `node --check public/app.js`, `node --check scripts/smoke.mjs` e `git diff --check` passaram |

As regressões foram reproduzidas antes das respectivas correções. Na revisão foram corrigidos a consulta/cancelamento de um trabalho por outra conexão que conhecesse seu ID, o aceite de IDs JSON-RPC fracionários e o acúmulo de verificações lentas na fila compartilhada. A consulta e o cancelamento agora seguem a identidade que criou o trabalho, tanto em memória quanto nos resultados retidos; o painel administrativo mantém acesso às execuções. A criação/renovação de assinaturas aceita somente uma chamada em andamento e recusa as excedentes com 429; uma única verificação ainda pode atrasar o estado de Events por até dez segundos. A revisão posterior confirmou as três correções, sem achados concretos pendentes.

O fluxo HTTP executa a escrita real, aceita a inscrição após o desafio, confere a assinatura dos bytes entregues, reinicia a aplicação e recupera o resultado completo com a mesma autorização OAuth. O smoke repete a descoberta e a entrega usando o código em `dist`. Os testes de transporte inspecionam a resolução e as opções da conexão HTTPS sem enviar avisos a uma conversa real.

**Limites daquela verificação:** os testes comprovaram o contrato implementado e o fluxo com receptor controlado. Não comprovaram retomada de uma conversa real no ChatGPT, disponibilidade de Events na conta do usuário, entrega pelo túnel ngrok ou funcionamento no Windows. A conexão real consultada naquela etapa ainda informou a versão **0.2.1**, portanto precisava ser atualizada antes do teste completo. Também não houve nova inspeção visual do painel naquela entrega. A evidência manual posterior está na seção da 0.5.0; instruções atuais estão em [MCP-EVENTS.md](MCP-EVENTS.md).

## Histórico: aprovação automática e espera de resultados — 0.3.0

Verificação em 22 de outubro de 2026, com Node.js 24.19.0 e npm 11.9.0 em Linux. Os testes usam diretórios, credenciais e portas temporários, separados da instalação do usuário.

| Verificação | Resultado observado |
|---|---|
| `npm run verify` | TypeScript, **125 testes**, zero falhas, zero testes ignorados e build concluído |
| `npm run build && npm run smoke` | Programa compilado executou descoberta OAuth, DCR, consentimento, PKCE, chamadas MCP, revisão manual, backup, aprovação automática, retorno à revisão, renovação e revogação |
| Aprovação automática | Todos os riscos (`read`, `write`, `execute`), origens locais e MCP, liberação de pendências e persistência da política cobertos |
| Transições e controles | Pausa, cancelamento, idempotência, argumentos imutáveis, definições alteradas, permissões de projeto e separação administrativa preservados nos testes |
| Espera MCP | Resultado de operação além dos antigos 750 ms, limite de 25 s, `bridge_job.waitMs`, aprovação durante a espera e retorno do mesmo trabalho ao vencer o prazo cobertos |
| Proxy stdio | CLI e transporte MCP reais, com HTTP e relógio simulados no processo filho: preservação do resultado após a espera, limite finito e mensagem de resultado incerto em timeout |
| JavaScript e diff | `node --check public/app.js` e `git diff --check` passaram |

Os testes do modo automático, da espera MCP e do prazo do adaptador stdio falharam antes das respectivas implementações e passaram depois. A integração HTTP comprovou arquivos reais no disco após ativar o modo, persistência entre reinícios e revisão de novas alterações depois de desativá-lo. O smoke compilado repetiu esse fluxo usando a conexão OAuth e o cliente MCP.

A revisão independente identificou o prazo anterior de 15 s no adaptador stdio, menor que a nova espera de 25 s, e um texto do painel que prometia enfileirar solicitações novas enquanto pausado. O prazo das chamadas de ferramentas foi ajustado para 35 s; o painel orienta retomar antes de enviar novas solicitações. A pausa continua bloqueando novas chamadas e a partida da fila. A revisão posterior confirmou as duas correções, sem achados concretos pendentes.

**Limites daquela verificação:** a versão 0.3.0 ainda precisava ser instalada no computador do usuário e ter seu catálogo atualizado no ChatGPT. O acesso ao navegador local não estava disponível naquela etapa; não foi concluída uma nova inspeção visual do painel. MCP Events ainda não existia na 0.3.0, e aqueles testes de espera não demonstravam retomada de uma conversa já encerrada. A implementação de Events e sua validação na 0.4.0 estão descritas acima.

## Histórico da validação 0.2.1

Os resultados abaixo registram a etapa anterior, antes do teste posterior da conexão real com o ChatGPT e da listagem de uma sessão do Studio. Não representam uma nova execução de testes de navegador nas versões seguintes.

### Correção da espera no OAuth com túneis

A versão 0.2.1 corrige a consulta de decisão na página de consentimento: preserva cookies apenas da mesma origem, envia o cabeçalho oficial de dispensa do aviso de navegador do ngrok e distingue resposta HTML, erro HTTP, JSON inválido, falha de rede e timeout. A página continua tentando enquanto o pedido está válido e retira o indicador de carregamento após uma falha inicial.

| Verificação desta atualização | Resultado observado |
|---|---|
| `npm run verify` | TypeScript, **82 testes**, zero falhas, zero testes ignorados e build concluído |
| `npm run smoke` | OAuth, MCP, leitura, escrita aprovada, backup, renovação e revogação concluídos com o programa compilado |
| JavaScript | `node --check` passou no painel e no consentimento |
| Regressões de consentimento | **10 testes** executam o JavaScript real, com DOM e transporte simulados: sessão do túnel, cabeçalho sem cookie, HTML, HTTP 503, rede, leitura interrompida, JSON malformado, recuperação, 404, expiração e rejeição |
| Chromium real com proxy local | Falha anterior reproduzida em dois cenários; versão corrigida exibe código, acompanha aprovação, chega ao callback e troca o código com PKCE nos dois |
| Revisão independente | Sem achados pendentes; classificação de falha de transporte durante a leitura JSON corrigida e coberta por teste |

### Reprodução do problema e verificação da correção

O teste em Chromium usa as rotas, HTML e JavaScript reais da aplicação. Um proxy HTTP de teste em `127.0.0.1` devolve uma página HTML quando a consulta não traz o cookie esperado ou o cabeçalho de dispensa do aviso. Foram executados quatro fluxos:

| JavaScript | Condição do proxy de teste | Resultado |
|---|---|---|
| 0.2.0 | Cookie HttpOnly já estabelecido na navegação | O fetch omite o cookie; a aprovação local ocorre, mas a página permanece em “Carregando…” e “Aguardando a Ponte responder” |
| 0.2.0 | Cabeçalho necessário, sem cookies no contexto | O fetch não envia o cabeçalho; a mesma espera persiste depois da aprovação |
| 0.2.1 | Cookie HttpOnly já estabelecido na navegação | O cookie chega ao proxy; código exibido, aprovação detectada, callback alcançado e troca PKCE com HTTP 200 |
| 0.2.1 | Cabeçalho necessário, sem cookies no contexto | O cabeçalho chega ao proxy; código exibido, aprovação detectada, callback alcançado e troca PKCE com HTTP 200 |

Os fluxos corrigidos verificaram `state`, `iss` e a obtenção de um token Bearer sem imprimir credenciais. Não houve exceções JavaScript nem violações de CSP capturadas. O ambiente temporário foi encerrado e removido.

A suíte permanente primeiro reproduziu a falha de sessão e a ausência de diagnósticos na versão anterior. Também reproduziu a classificação incorreta de uma queda de rede durante a leitura do JSON antes de corrigir esse caso. Os testes depois confirmaram a recuperação por nova tentativa e o retorno após aprovação.

**Limite da evidência:** o proxy é uma simulação local dos comportamentos de cookie e página intermediária. Não foi feita uma conexão pelo túnel ngrok do usuário nem pela sua conta real do ChatGPT. O teste comprova o defeito e a correção nesses cenários; a instalação local precisa ser atualizada e uma nova tentativa OAuth precisa ser iniciada, conforme [CHATGPT.md](CHATGPT.md).

## Histórico da validação 0.2.0

Os resultados abaixo registram a entrega anterior e permanecem como referência para os recursos que este hotfix não modificou.

Verificação concluída em 22 de outubro de 2026. Ambiente: Linux, Node.js 24.19.0 e npm 11.9.0. Os resultados descrevem testes executados nesta entrega; não presumem acesso ao Windows, ao Roblox Studio ou à conta ChatGPT do usuário.

### Resultado observado

| Verificação | Resultado |
|---|---|
| `npm run verify` | Passou: TypeScript, **72 testes**, zero falhas, zero testes ignorados e build compilado |
| `npm run smoke` | Passou com código em `dist`: OAuth, MCP, leitura, escrita aprovada, backup, renovação e revogação |
| JavaScript do painel e consentimento | `node --check` passou nos dois scripts |
| Navegador Chromium | Autorização, rejeição, revogação e chamada MCP concluídas no ambiente local; sem erros JavaScript ou CSP capturados |
| Layouts | Inspeção visual em 1440 × 1000 e 412 × 915; ausência de overflow horizontal |
| Dependências de produção | `npm audit --omit=dev --json`: zero vulnerabilidades conhecidas na consulta realizada |
| Revisão independente | Problema de esgotamento permanente do registro DCR identificado, corrigido e revisado novamente |

As verificações de rede usaram listeners reais em `127.0.0.1`. Os testes OAuth mantêm identificadores canônicos HTTPS e encaminham as requisições para esses listeners locais. Isso verifica o contrato OAuth e a implementação MCP, mas não comprova TLS, alcance de um túnel externo nem conexão com uma conta real do ChatGPT.

### Os 24 testes de OAuth

São **19 testes do provider** e **5 testes HTTP**, cobrindo:

- Descoberta pública do recurso e do authorization server, emissor exato, PKCE S256, DCR e métodos de autenticação anunciados.
- Cliente oficial do SDK MCP realizando descoberta, registro dinâmico, consentimento, troca de código e chamada de ferramentas.
- Autorização local obrigatória, rejeição, prazo de consentimento e conclusão de uso único.
- Vínculo entre cliente, redirect registrado exato, recurso, scope e desafio PKCE.
- Rejeição de PKCE incorreto, audiência diferente, redirect diferente, scopes indevidos e reutilização de código.
- `iss` e `state` nos redirects de sucesso e erro; nenhuma emissão de código após rejeitar.
- `securitySchemes` e seu espelho em `_meta` no JSON efetivamente transmitido em `tools/list`. O parser do cliente SDK remove extensões desconhecidas no nível superior; por isso a verificação também inspeciona a resposta HTTP original.
- Separação entre tokens OAuth, API legada e administração; nenhum token reutilizável exposto no resumo administrativo.
- Expiração de consentimento, código, access token e refresh/grant, com limites exatos de tempo.
- Rotação de refresh tokens, persistência após reinício, detecção de replay e revogação da família, inclusive sob concorrência.
- Revogação administrativa e pelo endpoint OAuth, preservando o vínculo com o cliente.
- Invalidação permanente ao mudar ou remover a URL pública, inclusive quando ela muda e volta ao valor anterior.
- Estado OAuth persistente privado, rejeição de links/estado malformado e armazenamento de hashes de access/refresh tokens.
- Limite de registros sem bloqueio permanente por clientes anônimos: descarte do mais antigo nunca autorizado, com preservação de clientes já autorizados e fluxos ativos.

### Os 48 testes de regressão

Os testes anteriores continuam passando. Eles cobrem configuração e credenciais separadas; políticas de aprovação; argumentos imutáveis; pausa, cancelamento e idempotência; schemas modernos; alterações reais depois de aprovar; proteção dos caminhos e do estado; leitura UTF-8 com SHA-256; diffs, backups e escrita concorrente; busca limitada; execução de processos com limites; e agregação de MCPs stdio, HTTP e SSE reais.

Os testes da fachada legada com token API continuam passando, incluindo chamada MCP e escrita que só ocorre após aprovação administrativa. Tokens OAuth não passam a dar acesso à API de administração nem às rotas REST legadas.

### Smoke do programa compilado

`scripts/smoke.mjs` importa o código em `dist`, inicia uma instalação temporária em portas livres e usa o cliente oficial do SDK. O roteiro:

1. Descobre OAuth e registra um cliente.
2. Aprova o pedido pelo endpoint administrativo local, recebe o callback e troca o código com PKCE.
3. Negocia MCP usando o token OAuth e lista as ferramentas.
4. Lê um arquivo e verifica seu SHA-256.
5. Solicita uma alteração e comprova que o arquivo permanece intacto enquanto aguarda aprovação.
6. Confere o diff e rejeita a tentativa de aprovação com a credencial da API.
7. Aprova pela administração e verifica o conteúdo final e o backup.
8. Renova com rotação de refresh token, revoga a conexão e comprova a recusa do token revogado.

Para repetir após instalar as dependências:

```sh
npm run verify
npm run smoke
```

No PowerShell, use `npm.cmd` se a política local bloquear o lançador `npm.ps1`. O smoke não usa seu estado existente, limpa os temporários e encerra as conexões ao terminar.

### Verificação do painel e da página de consentimento

O navegador executou login no painel, salvou a URL pública, abriu a página de consentimento e comparou o código mostrado nas duas telas. O botão de autorização ficou desabilitado até marcar a confirmação; a atualização automática preservou a confirmação da solicitação revisada e o texto ainda não salvo no campo de URL.

Depois da autorização, o teste capturou localmente o redirect HTTP que seria enviado ao callback do ChatGPT, verificou `state`, `iss` e código, concluiu a troca de tokens e chamou `bridge_status`. Nenhuma conta real do ChatGPT foi conectada. O teste também revogou o acesso pelo painel e confirmou HTTP 401; um segundo pedido foi recusado e retornou `access_denied` sem código.

A página de consentimento e a tela de conexão foram inspecionadas em desktop e celular. Não houve overflow horizontal nem erros JavaScript/CSP capturados. Uma junção de palavras no título móvel foi corrigida durante a inspeção visual.

### O que precisa ser validado no ambiente do usuário

- Instalação e operação no Windows ou macOS; esta entrega foi testada em Linux.
- Encaminhamento HTTPS público de toda a API, incluindo descoberta e endpoints OAuth, ou configuração de um Secure MCP Tunnel compatível.
- Criação/atualização, instalação e autorização do plugin na conta real do ChatGPT, sujeitas às permissões da conta e do workspace.
- Conexão a uma instalação real do Roblox Studio e ao place escolhido, seguindo `ROBLOX.md`.
- Credenciais e efeitos dos MCPs de terceiros que o usuário adicionar.

Não há garantia de acesso independente das políticas do ChatGPT ou da disponibilidade da rede. O resultado de `npm audit` é uma consulta de vulnerabilidades conhecidas das dependências; não substitui uma auditoria de segurança do produto. Terminal e programas MCP aprovados continuam usando os privilégios da conta local, conforme `SEGURANCA.md`.
