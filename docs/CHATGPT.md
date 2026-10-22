# Conectar a Ponte MCP 0.7.0 ao ChatGPT

[Índice da documentação](README.md) · [Instalação e operação](OPERACAO.md) · [API e ferramentas](API.md) · [Claude](CLAUDE.md)

A Ponte oferece OAuth para a conexão MCP do ChatGPT, watchers para acompanhar tarefas externas e MCP Events para entregar avisos de jobs ao cliente. O usuário autoriza a conexão no painel do próprio computador e pode revogá-la depois. O ChatGPT não recebe a credencial de administração.

| Necessidade | Recurso da Ponte | Limite principal |
|---|---|---|
| Chamar ferramentas e conferir uma execução | MCP e `bridge_job` | A espera ocorre durante uma chamada ativa |
| Saber quando o executor terminou uma tarefa externa | Watcher `signal` e `bridge_watch_wait` | O executor precisa enviar o recibo; o watcher não desperta um chat encerrado |
| Continuar uma conversa quando um job da Ponte terminar | Assinatura de `ponte.job.completed` por MCP Events | O cliente precisa oferecer Events, criar a assinatura e processar o aviso |

Este roteiro corresponde à **0.7.0**. As instruções externas foram conferidas em **22 de outubro de 2026**. O [histórico de validação](VALIDACAO.md) separa testes automatizados, a tentativa inicial de Events que falhou antes da inscrição e uma evidência manual posterior de entrega em nova conversa Work. Esta revisão documental não executou uma nova conexão de conta, nem comprova retomada em todos os clientes. As permissões da conta e do workspace continuam sendo requisitos externos à Ponte.

## 1. Preparar a API HTTPS

Inicie a ponte e entre no painel local em `http://127.0.0.1:4317`. Se você usa portas personalizadas, substitua os valores deste roteiro.

Configure um encaminhamento HTTPS para **toda a API em `http://127.0.0.1:4318`**. O encaminhamento deve conservar os caminhos: publicar somente `/mcp` impede a descoberta OAuth e a autorização. Use uma origem estável, como `https://sua-ponte.exemplo.com`.

Em **Conectar IA → URL pública da API**, salve essa origem, sem caminho, credenciais, query string ou fragmento. O valor é `https://sua-ponte.exemplo.com`; a URL a cadastrar no ChatGPT será `https://sua-ponte.exemplo.com/mcp`.

O painel da porta **4317 permanece local**. A Ponte não cria o túnel ao salvar a URL. Mantenha o processo da ponte e o encaminhamento em execução durante o uso.

### Se usa ngrok

Encaminhe a porta da API:

```sh
ngrok http 4318
```

Use a origem HTTPS exibida pelo ngrok como **URL pública da API** no painel e acrescente `/mcp` somente no endereço cadastrado no ChatGPT. Se o ngrok apresentar seu aviso de visita ao abrir a página, prossiga para o site e mantenha a página de autorização aberta.

A correção introduzida na versão **0.2.1**, mantida na 0.7.0, preserva os cookies da própria origem ao consultar a decisão e envia o cabeçalho `ngrok-skip-browser-warning` nessa consulta, conforme a [documentação oficial do ngrok](https://ngrok.com/docs/pricing-limits/free-plan-limits#removing-the-interstitial-page). Isso evita que a página intermediária do túnel seja interpretada como o status OAuth. A página também informa quando recebe HTML, erro HTTP, dados inválidos ou falha de rede.

Antes da correção da 0.2.1, a consulta descartava os cookies e escondia essas falhas atrás de “Aguardando a Ponte responder”. Esse comportamento pode impedir a página de perceber uma aprovação que já ocorreu no painel.

## 2. Conferir a descoberta

Abra as URLs abaixo no navegador. Elas devem retornar JSON e não exigir token:

```text
https://sua-ponte.exemplo.com/.well-known/oauth-protected-resource/mcp
https://sua-ponte.exemplo.com/.well-known/oauth-authorization-server
```

A primeira informa o recurso `https://sua-ponte.exemplo.com/mcp`, o emissor da autorização e o scope `ponte:tools`. A segunda informa os endpoints `/authorize`, `/token`, `/register` e `/revoke`, PKCE `S256` e os métodos de autenticação aceitos. A Ponte também disponibiliza o documento do recurso em `/.well-known/oauth-protected-resource`.

O `issuer` é a origem configurada, sem barra final. Por exemplo, `https://sua-ponte.exemplo.com`. Os endpoints anunciados precisam usar essa mesma origem pública. Não devem apontar para `127.0.0.1` quando a conexão usa HTTPS público.

Visitar `/mcp` pela barra do navegador faz uma requisição GET sem credencial. A resposta `401` é esperada e deve incluir `WWW-Authenticate` indicando onde descobrir OAuth. Mesmo com autenticação, GET retorna **405 Method Not Allowed** neste transporte: as mensagens MCP usam POST com JSON. Para verificar chamadas MCP completas, use o MCP Inspector ou um cliente compatível.

## 3. Adicionar no ChatGPT

As etapas seguem o [guia oficial de conexão do ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt). Os rótulos podem aparecer traduzidos.

1. Abra **Plugins**, selecione **+** e depois **Add custom MCP server**.
2. Informe um nome, por exemplo **Ponte MCP**, e uma descrição opcional.
3. Em **Connection**, use a opção de URL e informe `https://sua-ponte.exemplo.com/mcp`.
4. Escolha autenticação **OAuth**. Deixe Client ID e Client Secret vazios para o cadastro dinâmico. Se a interface perguntar pelo método de registro, selecione **DCR**.
5. Revise as informações da conexão e prossiga. O ChatGPT descobre os endpoints e registra seu cliente OAuth automaticamente.

O Bearer fixo mostrado por `token api` continua destinado a Actions e clientes que aceitam essa credencial. Ele não deve ser preenchido como Client ID ou Client Secret no fluxo OAuth.

A Ponte anuncia DCR e aceita os métodos de cliente `client_secret_post` e `none`, com PKCE `S256`; ela não anuncia CIMD. Confira os metadados descritos na seção anterior se o cliente escolher um método incompatível. O [guia de autenticação da OpenAI](https://developers.openai.com/plugins/build/auth) descreve a descoberta e as opções do cliente.

## 4. Aprovar no computador

O início da autorização pode ocorrer ao criar a conexão ou quando o ChatGPT solicitar acesso a uma ferramenta protegida.

1. A página de autorização da Ponte mostra um **código de verificação de oito caracteres**. Mantenha essa página aberta.
2. No painel local, entre em **Conectar IA** e abra a solicitação com **Revisar conexão**.
3. Encontre o pedido com o mesmo código. Confira o cliente, o destino do retorno e a permissão solicitada.
4. Autorize somente o pedido que você acabou de iniciar. Se não reconhecer a solicitação ou se o código não coincidir, rejeite-a.
5. Volte à página de autorização. Ela acompanha a decisão e retorna automaticamente ao ChatGPT após aprovar.

A página pública de consentimento não pede o token de administração. O código de verificação serve para identificar o mesmo pedido nas duas telas; não substitui o login no painel local.

O pedido expira em 10 minutos. Caso expire, inicie a conexão novamente no ChatGPT e compare o novo código. Novas conexões OAuth exigem essa aprovação local mesmo no modo automático. Depois de autorizar, as chamadas seguem as permissões das ferramentas e a política escolhida no painel.

## 5. Instalar e testar uma chamada

Conclua **Create as a plugin** no ChatGPT, confira as ferramentas descobertas e instale o plugin. Abra uma conversa, use `@` para selecionar a Ponte e envie:

```text
Use a Ponte MCP para consultar bridge_status e depois local_projects.
Mostre apenas os projetos retornados pelas ferramentas.
```

O teste está concluído quando o ChatGPT executa a ferramenta e devolve os dados da sua ponte. Uma página de consentimento aprovada, sozinha, não demonstra que a chamada MCP funcionou. Consultar ou cancelar um trabalho exige a mesma autorização OAuth que o criou; o painel administrativo consegue acompanhar todas as execuções. Uma conexão nova não herda os trabalhos da autorização anterior.

Na política padrão, solicite a criação de um arquivo de teste em um projeto autorizado. A chamada retorna `pending_approval`; revise o trabalho em **Execuções** no painel e aprove. O chat pode aguardar o mesmo trabalho com `bridge_job` e `waitMs: 25000`, conforme a seção abaixo. No modo automático, a chamada já segue para execução. Considere a operação concluída somente quando o resultado confirmar o sucesso.

### Aprovar automaticamente e aguardar o resultado

No painel, abra **Visão geral → Você no controle → Política de aprovação → Aprovar automaticamente todas**. Essa seleção ativa `automatic` e permanece após reiniciar. Para solicitações executadas como jobs, o padrão `mutations` revisa alterações e comandos; `all`, mostrado como **Aprovar todas as solicitações**, inclui leituras na revisão manual. Controles diretos, como `bridge_status`, `bridge_job` e as consultas de watchers, não criam jobs para aprovação.

O modo automático libera solicitações pendentes válidas e novas chamadas de ferramentas locais e MCP, para todos os clientes autorizados. A pausa, as permissões dos projetos, as listas de ferramentas permitidas e os hashes continuam valendo. Ao desativar o modo, os trabalhos automáticos ainda na fila voltam à revisão quando a política exigir; trabalhos já em execução continuam. `bridge_status` mostra `approvalMode`, e os detalhes dos trabalhos identificam a aprovação `manual` ou `automatic` quando aplicável.

A chamada MCP inicial aguarda até 25 segundos enquanto o trabalho está `queued` ou `running`. Se precisar de aprovação, retorna `pending_approval` imediatamente. Depois, o chat pode consultar:

```json
{ "jobId": "ID_RETORNADO", "waitMs": 25000 }
```

Em `bridge_job`, `waitMs` é um inteiro de 0 a 25000; o padrão 0 faz uma consulta imediata. Uma espera positiva acompanha `pending_approval`, `queued` e `running` até concluir ou atingir o prazo. Se ainda estiver pendente, o mesmo `jobId` permanece consultável. O cliente deve limitar as consultas e evitar reenviar a operação.

Essa espera funciona durante o turno ativo e **não reabre uma conversa encerrada**. Para receber um aviso depois, use a assinatura de MCP Events descrita a seguir. Ativar `automatic` não cria essa assinatura.

## Adicionar MCPs à Ponte durante a conversa

A versão 0.7.0 oferece `bridge_mcp_list`, `bridge_mcp_add` e `bridge_mcp_reconnect`. Você pode pedir “adicione o Playwright à Ponte para testar este projeto”. O chat também pode identificar uma capacidade necessária ao pedido, conferir as conexões existentes e propor um cadastro com configuração oficial e motivo concreto. A aprovação segue a política já escolhida no painel: revisão em `mutations`/`all`, execução em `automatic`.

A solicitação aparece em **Execuções**; depois de aprovada, o servidor é salvo em **Conexões MCP** e a Ponte tenta conectá-lo. `registered: true` confirma o cadastro; somente `server.status: "connected"` confirma a conexão. Uma falha mantém o cadastro para correção. O chat não substitui IDs existentes com outra configuração, não altera a política nem obtém credenciais administrativas.

Se o ChatGPT ainda mantiver a listagem inicial em cache, peça `bridge_list_tools` com `search: "bridge_mcp"` para descobrir o gerenciamento e chame-o por `bridge_call`. O schema atual também aceita `source: "bridge:mcps"` para selecionar essa origem. Após adicionar, use `source: "mcp:ID"` para encontrar as ferramentas do novo servidor e invocá-las pelo mesmo wrapper. Atualizar metadados permite que o cliente também exponha os nomes diretamente, mas não é necessário para esse caminho dinâmico. O guia [MCPs pelo chat](MCPS-PELO-CHAT.md) contém o contrato e exemplos.

## 6. Acompanhar tarefas externas na própria Ponte

A versão **0.7.0** expõe `bridge_watch_create`, `bridge_watch_get`, `bridge_watch_list`, `bridge_watch_wait` e `bridge_watch_cancel`. Depois de atualizar a instalação, abra a conexão em **Plugins**, selecione **Refresh/Atualizar**, confira esses nomes e comece uma nova conversa. A criação passa pela fila e pela política de aprovação; get, list, wait e cancel são controles diretos e não ocupam essa fila.

Para uma demanda delegada ao Claude em tmux, crie um watcher `signal` antes do envio, configure o produtor com `callback.url`, `callback.token` e o mesmo `runId`, envie a demanda uma única vez e chame `bridge_watch_wait`. O retorno do comando que enviou teclas não comprova conclusão do trabalho. O executor deve sinalizar `succeeded`, `failed` ou `needs_input` quando houver resultado real.

Esse fluxo não exige nem cria agendamento no ChatGPT ou Claude. A espera padrão é de **25000 ms**, podendo chegar a **300000 ms** se o cliente mantiver a chamada aberta. Ao retornar `waiting`, aguarde novamente o mesmo ID dentro do turno ativo e com consultas limitadas. O watcher persiste se a chamada cair e retorna `monitorDurable: true` e `canWakeClosedConversation: false`. O painel **Acompanhamentos** mostra os resultados. Consulte [Watchers](WATCHERS.md) para o roteiro completo e o produtor externo.

Nesse caso, o callback recebe dados **do executor para a Ponte**. Em MCP Events, a Ponte envia dados para um callback fornecido pelo cliente. A 0.7.0 não anuncia um evento de conclusão de watcher: assinar o `jobId` de `bridge_watch_create` acompanha somente a criação do watcher, e assinar o job de envio ao tmux acompanha somente esse envio. Nenhum desses avisos comprova que a tarefa externa terminou.

## 7. Receber um aviso e continuar a tarefa

Na 0.7.0, a Ponte anuncia o evento **`ponte.job.completed`**, que acompanha um único trabalho pelo argumento obrigatório `jobId`. Ele é emitido ao concluir, falhar, ser recusado, ser cancelado ou expirar. O aviso contém metadados; o ChatGPT consulta `bridge_job` para obter o resultado completo.

Segundo a [documentação de MCP Events da OpenAI](https://developers.openai.com/plugins/build/mcp-events), o recurso está disponível em **Work no navegador**, **Work com Cloud selecionado no desktop** e **dots**, sujeito aos controles da conta e do workspace. Este roteiro usa uma conversa Work. Uma conexão MCP que consegue chamar ferramentas pode não oferecer Events no modo selecionado.

1. Atualize a instalação, reinicie a Ponte e confirme **0.7.0** no painel.
2. Na conexão da Ponte em **Plugins**, selecione **Refresh/Atualizar**. Confira as ferramentas e o evento `ponte.job.completed` descobertos.
3. Abra uma **nova conversa Work** compatível e selecione a Ponte com `@`, para usar o catálogo atualizado.
4. Solicite uma operação de teste em um projeto autorizado. Se ela ficar pendente de aprovação ou de execução, guarde o `jobId` retornado.
5. Peça que o ChatGPT acompanhe **esse ID** e continue a tarefa quando o aviso chegar. O cliente envia o método de protocolo `events/subscribe` com seu callback e segredo. Esse método não é uma ferramenta do catálogo nem uma chamada a `bridge_call`.
6. Em **Conectar IA → Avisos de conclusão**, confirme que a execução aparece como **Aguardando conclusão**. Se a operação exige revisão, aprove-a em **Execuções**.
7. Ao terminar, acompanhe o estado **Aviso recebido**. Na conversa, confira a chamada a `bridge_job` para o mesmo ID e a resposta baseada no resultado.

Exemplo de pedido após receber o ID:

```text
Acompanhe o trabalho JOB_ID com o evento ponte.job.completed da Ponte.
Quando ele terminar, consulte bridge_job com esse mesmo ID, confira o
resultado e continue a tarefa que eu pedi. Não execute novamente a
operação que criou o trabalho. Se falhar ou for recusada, informe o motivo.
```

Cada assinatura cobre somente o trabalho indicado. Se outra etapa criar um novo trabalho que precise de acompanhamento, será necessária uma assinatura para o novo ID. Uma consulta de status não precisa gerar outra assinatura. Não copie callbacks nem segredos para o chat ou para o painel: esses campos pertencem à integração entre os dois serviços.

**Encerrar aviso** cancela a inscrição, sem cancelar o trabalho. **Aviso recebido** registra uma resposta HTTP de sucesso do cliente; não confirma que o ChatGPT já executou a próxima etapa. Sem uma assinatura ativa, continue usando `bridge_job` durante o turno ou peça a consulta do mesmo ID posteriormente.

Assinaturas e entregas pendentes persistem entre reinícios. Resultados dos trabalhos acompanhados também são retidos por prazo limitado para consulta pela mesma conexão; operações interrompidas não são reenviadas. O contrato, os limites e o tratamento de falhas estão em [MCP-EVENTS.md](MCP-EVENTS.md).

## Renovação, revogação e atualização

| Item | Comportamento da Ponte |
|---|---|
| Cliente registrado por DCR | Persiste entre reinícios; seu segredo não expira automaticamente |
| Pedido aguardando aprovação local | Expira em 10 minutos |
| Código de autorização OAuth | Uso único; expira em 2 minutos |
| Access token | Validade de até 1 hora, limitada também ao vencimento da autorização |
| Refresh token | Rotacionado a cada renovação; limitado ao prazo absoluto de 30 dias da autorização |
| Reutilização de refresh token já consumido | Revoga a família de tokens daquela autorização |
| Revogação pelo painel | Interrompe o acesso e as entregas de Events daquela autorização; uma nova conexão exige consentimento |

Ao vencer o prazo de renovação, conecte novamente pelo ChatGPT e autorize no painel. As credenciais OAuth ficam sob gestão do cliente e da ponte; você não precisa copiar access ou refresh tokens.

Pedidos aguardando decisão e códigos OAuth ainda não trocados ficam em memória. Se o serviço reiniciar durante a autorização, recomece esse fluxo no ChatGPT. Conexões já concluídas usam o estado persistido em `oauth.json`.

Para atualizar uma instalação clonada do GitHub, siga [Instalação e operação](OPERACAO.md). Preserve o mesmo diretório de estado e confira **0.7.0** no painel. Projetos, política de aprovação e conexões OAuth já concluídas persistem; não recrie uma conexão que continua funcionando. Se havia um pedido de autorização ainda em andamento quando a Ponte reiniciou, inicie somente esse fluxo novamente e compare o novo código nas duas telas.

Abra a conexão da Ponte em **Plugins → Refresh/Atualizar**, confira `bridge_mcp_list/add/reconnect`, os schemas de watchers e o evento `ponte.job.completed`, e teste uma chamada em nova conversa. Atualizar metadados não exige nova autorização OAuth enquanto a conexão permanecer válida. Ao mudar a origem HTTPS, atualize `publicUrl` e configure a conexão para a nova URL: emissor, recurso e destino dos tokens dependem desse endereço. As assinaturas vinculadas à autorização da origem anterior deixam de entregar e precisam ser recriadas pela nova conexão.

## Resolver problemas

| Sintoma | O que conferir |
|---|---|
| A opção de adicionar MCP não aparece | Permissões da conta e do workspace no ChatGPT |
| Os documentos de descoberta dão 404 | O túnel precisa encaminhar toda a API 4318, incluindo `/.well-known/*` |
| Erro de Host ou origem | `publicUrl` deve corresponder à origem HTTPS usada; o proxy deve preservar o Host público ou reescrevê-lo para o host local da API |
| O ChatGPT não abre a autorização | Autenticação OAuth selecionada, registro DCR, descoberta acessível e endpoints anunciados com HTTPS público |
| A autorização pede uma senha/token da Ponte | Use o login apenas no painel local; confirme que abriu a origem configurada e o fluxo descrito neste guia |
| O pedido não aparece no painel | Verifique se navegador, túnel e painel apontam para a mesma instância e o mesmo diretório de estado |
| Código de verificação expirou ou não coincide | Rejeite o pedido incorreto e inicie uma nova autorização |
| A aprovação ocorreu, mas a página continua em “Carregando…” ou “Aguardando a Ponte responder” | Atualize para 0.7.0, que inclui a correção da 0.2.1, e recomece o pedido OAuth que ficou incompleto; confira o código nas duas telas antes de aprovar |
| A página informa que o túnel devolveu uma página inesperada | A consulta recebeu uma página intermediária, em vez do JSON da Ponte; confira o ngrok, o encaminhamento para a API 4318 e a URL pública configurada |
| A página informa um erro HTTP | Confira o número exibido e se a API e o túnel continuam ativos; a tela tenta consultar novamente enquanto o pedido estiver válido |
| A página informa falha de rede ou demora na resposta | Confira a conexão, o processo da Ponte e o túnel; se o serviço reiniciou, recomece a autorização no ChatGPT |
| A aprovação ocorreu, o código apareceu, mas não houve retorno | Mantenha a página de autorização aberta, observe a mensagem de status e reinicie o fluxo se o pedido expirou |
| `invalid_client` após reiniciar | Confira se o processo usa o mesmo `.ponte/oauth.json`; não recrie o estado entre reinícios |
| Token recusado após mudar a URL | O token está vinculado ao recurso e emissor anteriores; conecte de novo usando a nova origem |
| Uma escrita está pendente | Confira `approvalMode` em `bridge_status`; em `mutations` ou `all`, aprove o trabalho em **Execuções** e consulte o mesmo `jobId` |
| O chat terminou a resposta antes da aprovação | Para avisos futuros, use Work compatível e confirme uma assinatura em **Avisos de conclusão**; sem assinatura, peça a consulta do mesmo `jobId` |
| MCP cadastrado, mas as ferramentas novas não aparecem no cliente | Use `bridge_list_tools` com `source: "mcp:ID"` e `bridge_call`; confira o status da conexão e, para nomes diretos na interface, atualize os metadados |
| Ferramentas antigas, `waitMs` ausente ou evento não listado | Use Refresh/Atualizar na conexão e abra nova conversa; confirme a versão 0.7.0 e a origem da Ponte |
| Não aparece nenhuma execução em **Avisos de conclusão** | Ainda não há assinatura ativa; confira o modo Work/Cloud e peça acompanhamento de um `jobId` criado pela mesma conexão |
| O aviso foi recebido, mas o ChatGPT não continuou | Confirme as instruções da conversa e o suporte do cliente; o status de entrega não comprova a execução de um novo turno |
| O aviso aparece como **Falha na entrega** | Veja o erro e as tentativas no painel; confira a conexão de saída da Ponte e consulte o resultado pelo mesmo `jobId` |
| Watcher continua em `waiting` após enviar texto ao Claude | Confira o produtor e o recibo para aquele `runId`; envio do prompt ou fim de turno não concluem a tarefa externa |
| Watcher terminou, mas não surgiu uma nova mensagem no chat | Consulte `bridge_watch_get`; a persistência do watcher não cria uma assinatura Events nem desperta um turno encerrado |

Para clientes e modos alternativos, incluindo stdio, Actions e Secure MCP Tunnel, consulte [INTEGRACOES.md](INTEGRACOES.md). Para localizar uma falha entre descoberta, inscrição e entrega, use o [diagnóstico de MCP Events](MCP-EVENTS.md#diagnóstico). O [histórico de validação](VALIDACAO.md) registra as evidências disponíveis e seus limites.

## Documentação oficial

- [Adicionar um MCP ao ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Autenticação OAuth de MCPs](https://developers.openai.com/plugins/build/auth)
- [Conectar e testar um MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Metadados e erros de ferramentas](https://developers.openai.com/plugins/reference)
- [MCP Events: disponibilidade, descoberta e entrega](https://developers.openai.com/plugins/build/mcp-events)
