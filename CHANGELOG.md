# Histórico de versões

[Projeto](README.md) · [Documentação](docs/README.md) · [Evidência de validação](docs/VALIDACAO.md)

Este histórico reúne as entregas já implementadas. As notas de cada versão descrevem suas mudanças; os guias em `docs/` descrevem o comportamento atual. A revisão exclusivamente documental registrada abaixo manteve o programa na versão de sua etapa.

## 0.9.0 — Ferramentas diretamente no dot — 22/10/2026

- `bridge_read` e `bridge_invoke` aceitam `tool`, `argumentsJson` e `idempotencyKey`, mantendo o schema original, a identidade, a fila, a aprovação e as permissões da operação. O JSON é dado: não é avaliado como script.
- O gateway de leitura verifica o risco dentro da fila, antes da prévia/execução, e recusa ferramentas de escrita/execução, inclusive em corridas de configuração e reaproveitamento de chave de uma mutação.
- `bridge_tool_schema` retorna o contrato exato de uma ferramenta descoberta e indica qual gateway usar, sem inventar os argumentos da chamada.
- `bridge_list_tools` aceita `includeSchemas: false` para descoberta resumida. Descrições longas nesse resumo são limitadas a 500 caracteres e sinalizadas; schemas completos continuam disponíveis sem truncamento na consulta individual.
- `mcpToolExposure: full|compact` em **Conectar IA → Catálogo MCP**. O perfil compacto anuncia 12 ferramentas estáveis e mantém o catálogo dinâmico completo; o padrão `full` preserva instalações anteriores. O endpoint e a autorização OAuth permanecem os mesmos.
- Separação entre ferramentas anunciadas e resolução de chamadas no MCP moderno: um nome direto válido conhecido antes da troca de perfil continua utilizável. Uma ferramenta removida continua indisponível.
- Instruções passam a priorizar descoberta e execução pela própria Ponte, sem depender de sessões Work/Codex. `bridge_status.directExecution` descreve essa capacidade do servidor e informa que ele não observa a disponibilidade de ferramentas no dot nem controla a delegação interna do cliente.
- Jobs pendentes incluem `nextCall` para consulta do mesmo ID. Os gateways preservam conteúdo multimídia, dados estruturados e erros do upstream.
- O adaptador stdio reconhece watchers pelos novos gateways JSON e mantém o prazo de até 45 segundos mais margem de transporte, com recuperação do mesmo watcher após interrupção.
- Guia próprio para dots, instrução copiável no painel e documentação atualizada com instalação, descoberta, limites e roteiro de validação real. Os testes controlados não são apresentados como execução em um dot real.

A evidência está em [Validação](docs/VALIDACAO.md#execução-direta-e-catálogo-compacto--090). Atualizar o GitHub não instala a versão no computador nem atualiza automaticamente os metadados do ChatGPT.

## 0.8.0 — Recuperação de esperas e eventos de watchers — 22/10/2026

- `bridge_watch_wait` usa 25000 ms por padrão e aceita no máximo 45000 ms no serviço, MCP direto, `bridge_call`, stdio e REST/Actions. Valores maiores são rejeitados com o mesmo ID e orientação `nextCall` para `bridge_watch_get`, sem ajuste silencioso.
- Separação explícita entre `waitMs`, prazo de uma chamada, e `timeoutMs`/`expiresAt`, prazo total do watcher: uma hora por padrão, máximo de sete dias, sem renovação pelas esperas.
- Recuperação estruturada para falhas de comunicação, inclusive antes dos cabeçalhos, durante a leitura do corpo e HTTP 503 no adaptador stdio. A orientação conserva o `watcherId` sem inventar estado nem reenviar a tarefa.
- Instruções para manter o turno ativo com esperas de 25 segundos pelo mesmo ID enquanto `waiting`, até terminal ou limite concreto do cliente. `needs_input` exige informar a pendência e pedir intervenção; uma nova etapa explicitamente autorizada usa outro watcher.
- Novo evento `ponte.watcher.completed`, com filtro obrigatório `{watcherId}`, proprietário verificado e payload restrito a ID, status e horários. O cliente recupera o resultado por `bridge_watch_get` após o aviso. `ponte.job.completed` permanece disponível.
- Assinaturas, metadados de watcher e tentativas de entrega persistidos, com desafio de callback, assinatura de webhook, repetição com ID estável e recuperação de transições terminais após reinício. Resultados e tokens de watchers ficam fora do evento; o resultado permanece em `watchers.json`.
- `monitorDurable: true` e `canWakeClosedConversation: false` preservados. HTTP 2xx confirma recebimento do evento; não comprova uma resposta posterior da conversa. O fluxo nativo não cria agendamentos no ChatGPT/Claude.
- Registro anonimizado de um uso externo real, separado da consulta de leitura feita nesta revisão e dos testes locais. A instância conectada ainda anunciou 0.6.0 e somente o evento de job; a notificação de watcher após encerrar o turno continua sem comprovação nesse cliente.
- Pesquisa documentada de Claude Code Channels como possibilidade futura, sem implementação nem promessa de retomada nesta entrega.

A evidência e os limites desta versão estão em [Validação](docs/VALIDACAO.md#recuperação-de-esperas-e-eventos-de-watchers--080). A versão do repositório não comprova que uma instalação existente foi atualizada.

## 0.7.0 — MCPs adicionados pelo chat — 22/10/2026

- Ferramentas `bridge_mcp_list`, `bridge_mcp_add` e `bridge_mcp_reconnect` para clientes MCP, stdio e REST/Actions, com a política existente de aprovação.
- Cadastro com motivo e fonte opcional; prévia legível no painel e execução automática quando esse modo já estiver selecionado.
- Contrato de chat restrito a novas conexões, referências de ambiente em credenciais e ferramentas externas sem classificação automática como leitura.
- Proteção contra substituição silenciosa de IDs; cadastro idêntico retorna o estado existente sem reiniciar o servidor.
- Reconexão vinculada a uma revisão opaca da configuração, com rechecagem de autorização e cancelamento antes de persistir.
- Fila compartilhada entre alterações de upstreams pelo chat e pelo painel, incluindo cadastro, edição, remoção, reconexão e preset Roblox.
- Resultados que distinguem configuração persistida de conexão estabelecida e preservam o cadastro quando a conexão falha.
- Filtro `source` em `bridge_list_tools` e orientação para usar o catálogo atual via `bridge_call` na mesma conversa, inclusive com descoberta inicial em cache.
- Instruções de proatividade vinculadas à tarefa do usuário e guia próprio de MCPs pelo chat; referência REST permanece com nove operações.

## Histórico: revisão da documentação — 22/10/2026

- Reorganização do README e criação de um índice dos guias.
- Referências próprias de operação/configuração e API/ferramentas, alinhadas à v0.6.0.
- Revisão dos fluxos de ChatGPT, Claude, Roblox, Playwright, OAuth, aprovação e recuperação de estado.
- Distinção explícita entre job, watcher nativo e inscrição de MCP Events; prazos e identidade de conexão documentados.
- Atualização das instruções para o chat e conferência do exemplo OpenAPI com o gerador atual de nove operações.
- Separação entre registros históricos de falha, teste manual posterior de Events e validação controlada dos watchers.
- Identificação dos planos e desenhos antigos como registros históricos; remoção de instruções de rotação de credenciais incompatíveis com o estado de watchers.

## 0.6.0 — Watchers nativos — 22/10/2026

- Serviço próprio de acompanhamentos com gatilhos `signal` e `job` e persistência em `watchers.json`.
- Ferramentas `bridge_watch_create`, `bridge_watch_get`, `bridge_watch_list`, `bridge_watch_wait` e `bridge_watch_cancel`.
- Criação submetida à política de aprovação; consultas e esperas diretas, autenticadas e sem ocupar a fila de execução.
- Callback por watcher com credencial exclusiva, correlação por `runId`, repetição idempotente e resultado persistido antes da confirmação.
- Espera padrão de 25 segundos, configurável até 300 segundos quando o cliente permitir; reconexão pelo mesmo ID.
- Seção **Acompanhamentos** no painel e quatro operações REST adicionais no OpenAPI.
- Produtor `scripts/ponte-watch-notify.mjs` para o executor enviar conclusão, falha ou pedido de informação.
- Instruções MCP para criar o acompanhamento antes de delegar e usar o serviço da Ponte, sem agendador do ChatGPT/Claude.
- Ajuste de prazo do adaptador stdio para as novas esperas; proteção de credenciais em observação administrativa e arquivos de Events.

O watcher preserva monitor e resultado, mas não reabre uma conversa encerrada nem comprova sucesso pelo término de um comando de delegação. Um watcher `job` não retoma a execução original após reiniciar. A validação registrada contém **237 testes** e smoke; veja [Validação](docs/VALIDACAO.md).

## 0.5.0 — Claude, diagnóstico e identidade visual — 22/10/2026

- Guia e aba de conexão para Claude, Claude Desktop e Claude Code.
- Compatibilidade do OAuth com callbacks hospedados e callbacks locais com porta temporária, preservando os demais vínculos de autorização.
- Geração de comandos com citação de argumentos e conferência de caracteres especiais.
- Diagnóstico de Events que distingue descoberta, tentativa de inscrição, verificação de callback e entrega.
- Logotipo próprio e paleta azul cobalto/grafite; correção de cards inclinados e espaçamento do painel.

A validação registrada contém **202 testes** e smoke. O erro de criação de assinatura observado em uma tentativa do ChatGPT foi investigado separadamente; um teste manual posterior confirmou inscrição e recebimento de evento. Os dois registros estão em [Validação](docs/VALIDACAO.md), sem garantia de disponibilidade em todos os clientes.

## 0.4.0 — MCP Events — 22/10/2026

- Adaptador HTTP para os métodos implementados do protocolo `2026-07-28`, mantendo clientes legados e upstreams no SDK existente.
- Evento `ponte.job.completed` vinculado a um job e à identidade da conexão.
- Inscrição pelo cliente, verificação HTTPS do callback e assinatura Standard Webhooks.
- Persistência de inscrições, fila de entrega e cópias limitadas dos resultados dos trabalhos acompanhados.
- Consulta do resultado retido após reinício e tratamento explícito de execução interrompida.

A validação registrada contém **188 testes** e smoke com receptor controlado. O contrato e os limites atuais estão em [MCP Events](docs/MCP-EVENTS.md).

## 0.3.0 — Aprovação automática e espera — 22/10/2026

- Política persistente `automatic`, além de `mutations` e `all`.
- Liberação de solicitações pendentes válidas, mantendo permissões, pausa e validação de argumentos.
- Espera de até 25 segundos por resultado MCP e `bridge_job.waitMs` para acompanhar aprovação/execução durante o turno ativo.
- Ajuste dos prazos do adaptador stdio e orientação para não reenviar operações de resultado incerto.

A validação registrada contém **125 testes** e smoke. MCP Events ainda não fazia parte desta versão.

## 0.2.1 — Consentimento OAuth com túneis — 22/10/2026

- Consulta da decisão de consentimento com cookies da mesma origem e cabeçalho de dispensa da página intermediária do ngrok.
- Diagnóstico de resposta HTML, erro HTTP, JSON inválido, queda de rede e timeout, com recuperação enquanto o pedido estiver válido.
- Regressões executando o JavaScript real e reprodução do problema em Chromium com proxy controlado.

A validação registrada contém **82 testes** e smoke. O teste com proxy não equivalia, naquele momento, a uma autorização na conta real do ChatGPT.

## 0.2.0 — OAuth para MCP remoto — 22/10/2026

- Descoberta do recurso protegido e do servidor OAuth, registro dinâmico de clientes e authorization code com PKCE S256.
- Autorização no painel local com código de verificação; renovação, rotação de refresh token e revogação.
- Identificador canônico da origem pública, vínculo de recurso/scope/redirect e separação entre tokens OAuth, API e administração.
- Página de consentimento e metadados de segurança nas ferramentas.

A validação registrada contém **72 testes**, smoke e verificações locais de navegador.

## 0.1.0 — Base do projeto — 21/10/2026

- Serviço local com painel em português, projetos autorizados e ferramentas de arquivos/comandos.
- Aprovação de trabalhos, diff, hash esperado, backups, auditoria de metadados e cancelamento.
- Agregação de ferramentas MCP por stdio, Streamable HTTP e SSE legado, com preset Roblox.
- Fachadas MCP e REST, exportação OpenAPI e scripts de instalação/inicialização.

O desenho e o plano dessa etapa permanecem no [arquivo histórico](docs/superpowers/README.md). Para instalar ou operar, use os guias da versão atual.
