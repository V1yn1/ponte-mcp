# Conexão com chats e outros servidores

Ponte MCP **0.4.0**. Documentação do ChatGPT consultada em **22 de outubro de 2026**. As telas e permissões dos fornecedores podem mudar. O roteiro da conexão nativa está em [CHATGPT.md](CHATGPT.md); os resultados efetivamente observados na entrega estão em [VALIDACAO.md](VALIDACAO.md).

## Escolha a entrada compatível com seu cliente

| Cliente | Entrada da ponte | Requisito adicional |
|---|---|---|
| ChatGPT com MCP nativo | `https://SUA_ORIGEM/mcp`, OAuth com DCR | Origem HTTPS encaminhando toda a API, `publicUrl` configurada e aprovação local |
| ChatGPT com MCP Events | Mesma entrada `/mcp`, protocolo `2026-07-28` | Work no navegador ou Work + Cloud no desktop, evento descoberto e assinatura de um `jobId` pelo cliente |
| Cliente desktop com MCP stdio | `node dist/cli.js stdio --state-dir CAMINHO` | Ponte iniciada no mesmo computador |
| Cliente MCP HTTP com Bearer configurável | `http://127.0.0.1:4318/mcp` | Token API; remoto exige encaminhamento HTTPS |
| ChatGPT com Secure MCP Tunnel disponível | Túnel oficial para uma entrada MCP compatível | Permissões, associação ao workspace e configuração própria do cliente de túnel |
| GPT personalizado com Actions | REST em origem HTTPS | OpenAPI e autenticação API Key/Bearer |
| Chat sem ferramentas | Não consegue executar diretamente | Mudar para uma superfície com integração explícita |

## ChatGPT nativo com OAuth

A fachada `/mcp` implementa authorization code com PKCE `S256`, cadastro dinâmico de clientes (DCR), descoberta de autorização, renovação e revogação. O scope usado é `ponte:tools`. As ferramentas anunciam essa política em `securitySchemes` e no espelho `_meta.securitySchemes`.

Configure a origem HTTPS da API em **Conectar ChatGPT → URL pública da API**. No ChatGPT, abra **Plugins → + → Add custom MCP server**, informe a URL completa terminada em `/mcp`, escolha **OAuth** e deixe as credenciais de cliente vazias. Se houver escolha entre métodos de registro, use **DCR**. O ChatGPT registra seu próprio cliente e inicia a autorização.

A página de consentimento mostra um código de oito caracteres. No painel local, abra **Conectar ChatGPT**, compare o código, revise o pedido e autorize. A página retorna automaticamente ao ChatGPT; conclua a criação, instale o plugin e selecione-o com `@` em uma conversa. As etapas detalhadas e o primeiro teste estão em [CHATGPT.md](CHATGPT.md).

### Contrato HTTP

Os caminhos abaixo pertencem à API da porta 4318. O túnel precisa encaminhar todos eles, sem acrescentar um prefixo de caminho.

| Caminho | Finalidade | Autenticação |
|---|---|---|
| `/.well-known/oauth-protected-resource` | Descoberta do recurso protegido | Pública |
| `/.well-known/oauth-protected-resource/mcp` | Descoberta específica do recurso `/mcp` | Pública |
| `/.well-known/oauth-authorization-server` | Metadados do servidor de autorização | Pública |
| `/register` | Cadastro dinâmico do cliente OAuth | Validação dos metadados do cliente |
| `/authorize` | Início do pedido de autorização | Cliente registrado, redirect, recurso e PKCE válidos; consentimento local pendente |
| `/oauth/consent` e seus recursos | Página que mostra o código de verificação | Não recebe credenciais administrativas |
| `/oauth/consent/status` e `/oauth/complete` | Acompanhar a decisão e concluir o retorno OAuth | Identificador aleatório do pedido; conclusão exige decisão local |
| `/token` | Troca de código ou renovação | Cliente público com PKCE, ou segredo do cliente conforme o registro |
| `/revoke` | Revogação de credenciais OAuth | Autenticação do cliente correspondente |
| `/mcp` | Transporte MCP | Access token OAuth ou token API legado |
| `/v1/*` | REST, trabalhos e adaptador stdio | Somente token API legado |
| `/openapi.json` | Definição de Actions | Pública |

O `issuer` é exatamente a origem HTTPS configurada, sem barra final. O identificador do recurso é essa origem acrescida de `/mcp`. O mesmo recurso acompanha a autorização e a troca de tokens; credenciais de outro recurso são rejeitadas.

A Ponte anuncia `authorization_response_iss_parameter_supported: true` e inclui `iss` nos redirects OAuth de sucesso e erro. Isso permite ao ChatGPT usar o callback estável `https://chatgpt.com/connector_platform_oauth_redirect`. Os redirects precisam coincidir com os valores registrados pelo cliente; não configure curingas.

O registro aceita `none` para cliente público e `client_secret_post` para cliente com segredo. `client_secret_basic`, CIMD e `private_key_jwt` não são anunciados como métodos implementados pela Ponte. O cliente DCR e seu segredo persistem, sem expiração automática do segredo, enquanto tokens têm validade e revogação próprias.

O transporte MCP é **Streamable HTTP sem sessão persistente, com respostas JSON**. Mensagens usam POST em `/mcp`; GET autenticado retorna 405 e não mantém um canal SSE aberto. Sem credencial válida, a autenticação responde 401 antes dessa verificação de método. Isso não impede que a ponte se conecte a upstreams que usem SSE.

Para o protocolo `2026-07-28`, um adaptador HTTP implementa `server/discover`, catálogo e chamadas de ferramentas, além de `events/list`, `events/subscribe` e `events/unsubscribe`. Ele exige os metadados de versão/capacidades e os cabeçalhos correspondentes por requisição. As versões legadas continuam no SDK 1.32.1. O modo stdio e as conexões upstream mantêm seus transportes existentes; esta atualização não migra o projeto inteiro para o SDK v2. O contrato detalhado está em [MCP-EVENTS.md](MCP-EVENTS.md#contrato-do-endpoint-mcp).

### Renovação e mudança de origem

Pedidos de autorização aguardam revisão por até 10 minutos, códigos OAuth valem por 2 minutos e access tokens por até 1 hora. Refresh tokens rotacionam, sem prolongar o prazo absoluto de 30 dias da autorização. Reutilizar um refresh token já consumido revoga sua família de tokens. O painel permite revogar a autorização de uma conexão. Pedidos pendentes e códigos ainda não trocados ficam em memória; reiniciar o serviço exige começar novamente esses fluxos.

Use uma origem estável. Alterar `publicUrl` muda os identificadores de emissor e recurso; configure novamente a conexão no ChatGPT para o novo endereço. Copiar apenas os arquivos do programa para outra pasta não transfere o estado OAuth: preserve o diretório `.ponte` ou passe seu caminho absoluto em `--state-dir`.

Ao atualizar para 0.4.0, preserve `.ponte` e mantenha uma conexão OAuth já concluída. No plugin da Ponte, atualize as ferramentas e a descoberta de eventos; confirme `ponte.job.completed` na página do plugin. Atualizar o catálogo não exige recriar uma conexão que funciona. O procedimento completo de atualização está em [CHATGPT.md](CHATGPT.md).

Fontes oficiais:

- [Adicionar um MCP customizado](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [OAuth, registro de clientes e identificação do emissor](https://developers.openai.com/plugins/build/auth)
- [Metadados e erros de ferramentas](https://developers.openai.com/plugins/reference)
- [Conectar e testar uma integração MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Aprovação e espera por resultados MCP

A política é comum a todos os clientes autorizados. Em **Visão geral → Você no controle → Política de aprovação**, `mutations` mantém a revisão de alterações e comandos, `all` revisa todas as ferramentas e **Aprovar automaticamente todas** seleciona `automatic`. Esse modo libera pendentes válidos e chamadas futuras de ferramentas locais e MCP. A seleção persiste após reiniciar.

Permissões de projeto, listas de ferramentas permitidas, validações e hashes continuam valendo. A pausa bloqueia novas solicitações e a partida da fila. Ao sair do modo automático, trabalhos automáticos ainda enfileirados voltam à revisão conforme a política; os que já começaram continuam. Novas conexões OAuth sempre exigem aprovação local.

`bridge_status` retorna `approvalMode`. Trabalhos podem incluir `approval: "manual"` ou `approval: "automatic"`, também registrado na auditoria. Chamadas de ferramentas, diretas ou por `bridge_call`, aguardam até 25 segundos enquanto o trabalho está `queued` ou `running`; um `pending_approval` inicial retorna imediatamente.

Para aguardar o mesmo trabalho durante o turno ativo, chame `bridge_job`:

```json
{ "jobId": "ID_RETORNADO", "waitMs": 25000 }
```

`waitMs` aceita inteiros de 0 a 25000, com padrão 0 para retornar imediatamente. A espera acompanha `pending_approval`, `queued` e `running` até um resultado final ou o prazo. Depois disso, o mesmo `jobId` continua consultável. Faça consultas limitadas e não reenvie a operação apenas porque ela ainda não terminou. Essa espera não retoma uma conversa encerrada; para isso, um cliente compatível precisa criar uma assinatura de Events.

### MCP Events

A Ponte 0.4.0 implementa o perfil de webhooks e verificação de [MCP Events da OpenAI](https://developers.openai.com/plugins/build/mcp-events), usando o protocolo `2026-07-28`. A disponibilidade documentada é **Work no navegador** ou **Work com Cloud selecionado no desktop**, sujeita à conta e ao workspace. Não se aplica automaticamente a toda conversa que tenha ferramentas MCP.

O evento `ponte.job.completed` exige o `jobId` de um trabalho da mesma conexão. O cliente cria a assinatura e fornece callback e segredo; a Ponte verifica o destino e envia um evento assinado quando aquele trabalho atinge estado final. Ao recebê-lo, o chat consulta `bridge_job` e continua conforme as instruções dadas pelo usuário. Uma assinatura criada logo após a conclusão também recebe o estado final atual; não há reprodução de histórico por cursor.

Atualize as ferramentas e eventos do plugin e confira a inscrição em **Conectar ChatGPT → Avisos de conclusão**. A opção **Encerrar aviso** cancela a inscrição, sem cancelar o trabalho. Callbacks e segredos não aparecem no painel. O modo automático de aprovação e Events podem ser usados juntos, mas um não ativa o outro.

As assinaturas, tentativas de entrega e resultados dos trabalhos acompanhados persistem em estado privado, com prazo e capacidade limitados. Nenhuma operação é repetida ao reiniciar a Ponte. O status de entrega confirma o recebimento do aviso; a retomada exige suporte do cliente. Há exemplos, referência do protocolo e diagnóstico em [MCP-EVENTS.md](MCP-EVENTS.md).

## MCP local e privado

O modo stdio é um adaptador do serviço local: todos os clientes compartilham o mesmo painel, política e conjunto de conexões. Não é necessário colocar um token em uma URL ou em uma conversa. O processo iniciado pelo cliente lê a configuração local.

Na configuração `mcpServers` do cliente, informe caminhos absolutos para `dist/cli.js` e `--state-dir`. Se `node` não for encontrado, use o caminho absoluto do executável. O painel gera esse exemplo com os caminhos atuais. O diretório de estado padrão fica na pasta da instalação, não na pasta atual do terminal; ao atualizar para outra pasta, reutilize explicitamente o estado antigo.

### Secure MCP Tunnel

A documentação do ChatGPT também oferece **Plugins → Add custom MCP server → Tunnel**. O túnel oficial aceita um comando stdio ou um endereço HTTP e usa uma conexão de saída. Seu processo `tunnel-client` precisa continuar ativo. Siga o guia oficial para instalação, associação à conta/workspace e autenticação. Esta entrega inclui o servidor a conectar e o adaptador stdio; não provisiona nem valida uma conexão de túnel oficial na conta do usuário.

O roteiro HTTP com OAuth acima usa uma origem HTTPS acessível para descoberta, autorização no navegador e chamadas MCP. Não substitua essas URLs por um `tunnel_id` ou suponha que uma entrada de túnel publique automaticamente as páginas OAuth. Configure cada modo de acordo com o transporte e a autenticação previstos pelo cliente do túnel.

O túnel não altera cotas do chat. Possui requisitos e limites operacionais próprios. A ponte não precisa de uma chave OpenAI para ler arquivos ou usar MCPs; a solução de conexão escolhida pode precisar de credenciais adicionais.

Fontes oficiais:

- [Adicionar um MCP customizado](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Conectar e testar uma integração MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## Actions via HTTPS

A porta 4318 é a única que deve ser encaminhada. A porta 4317 dá acesso à administração e deve permanecer em loopback. O serviço valida o cabeçalho Host; configure `publicUrl` com a origem HTTPS usada pelo túnel. Se o túnel reescrever Host para `127.0.0.1:4318`, o host local também é aceito.

Use uma URL HTTPS estável enquanto a Action estiver em uso. Depois de mudar a URL, atualize `publicUrl` e o schema no editor do GPT. O schema público está em `/openapi.json`, sem token, pois contém somente a definição dos endpoints. Todos os endpoints REST de ferramentas e trabalhos exigem o token API; access tokens OAuth de `/mcp` não autenticam `/v1/*`.

A Action tem cinco operações:

1. `getBridgeStatus`: projetos e conexões disponíveis.
2. `listTools`: catálogo filtrável, schemas e riscos.
3. `createJob`: chamada com `tool`, `argumentsJson` e `idempotencyKey`.
4. `getJob`: estado e resultado.
5. `cancelJob`: solicitação de cancelamento.

O campo `argumentsJson` é uma string contendo um objeto JSON. Isso mantém o schema de Actions estável mesmo quando os MCPs conectados apresentam schemas dinâmicos. A API também aceita um objeto `arguments` para clientes próprios; envie apenas uma dessas formas.

Consultas e cancelamentos exigem a identidade que criou o trabalho. Clientes Actions/stdio com o mesmo token API compartilham essa identidade, enquanto cada autorização OAuth tem seu próprio vínculo. O token API não permite consultar nem cancelar pela REST um trabalho criado por uma autorização OAuth. O painel administrativo conserva acesso a todas as execuções.

Não há endpoint remoto para aprovar manualmente trabalhos ou mudar a política. Se a política local exigir revisão, o usuário aprova no computador; em `automatic`, a ponte aprova os trabalhos válidos. A Action consulta o resultado por `getJob`; o parâmetro `waitMs` é exclusivo de `bridge_job` no MCP. Nenhum desses fluxos reabre uma conversa encerrada.

Fontes oficiais:

- [Introdução a GPT Actions](https://developers.openai.com/api/docs/actions/introduction)
- [Configurar uma Action](https://developers.openai.com/api/docs/actions/getting-started)
- [Autenticação de Actions](https://developers.openai.com/api/docs/actions/authentication)

## Servidores upstream

### stdio

Use `command`, `args` e, se necessário, `cwd` e `env`. O executável deve existir. A ponte não instala pacotes MCP automaticamente; instalar via `npx` executa código desse pacote e pode depender de downloads. No Windows, scripts `.cmd`/`.bat` podem exigir `cmd.exe` com argumentos apropriados; use a configuração publicada pelo próprio fornecedor.

### Streamable HTTP e SSE

Use `transport: "http"` para Streamable HTTP e `"sse"` para o transporte legado. URLs remotas precisam usar HTTPS; HTTP é aceito para loopback. Não use credenciais na URL. Use headers e referências `${VARIAVEL}`.

Não há login OAuth interativo para upstreams nesta versão. É possível conectar servidores que aceitem headers já configurados ou que não exijam autenticação. Redirecionamentos são recusados para impedir que headers sejam enviados a outro endereço.

### Catálogos e políticas

O agregador pagina `tools/list`, limita catálogos a 500 ferramentas por servidor e rejeita paginação circular. Nomes exportados têm namespace e hash determinísticos. Um servidor pode alterar suas ferramentas; a ponte atualiza o catálogo em resposta à notificação apropriada. Alguns clientes precisam atualizar ou reconectar a integração para enxergar alterações.

`readOnlyTools` e `allowedTools` usam os **nomes originais** do upstream. `readOnlyTools` classifica as leituras que dispensam revisão no modo `mutations`; `all` exige revisão também dessas chamadas e `automatic` dispensa revisão de todas as ferramentas expostas. A anotação `readOnlyHint` enviada por um servidor externo não concede essa autorização sozinha.

No painel, **Limitar ferramentas expostas** ativa a lista de nomes permitidos. Desmarcada, todas as ferramentas descobertas ficam disponíveis e seguem a política de aprovação selecionada. Marcada com a lista vazia, nenhuma ferramenta é exposta. Em `config.json`, omitir `allowedTools` permite todas; `allowedTools: []` permite zero. Na API administrativa, `allowedTools: null` remove uma restrição anterior; omitir o campo preserva a configuração existente.

Fonte oficial do SDK utilizado: [MCP TypeScript SDK v1 — servidor](https://ts.sdk.modelcontextprotocol.io/server) e [cliente](https://ts.sdk.modelcontextprotocol.io/client). A versão do SDK é fixada no `package.json` e as dependências exatas estão no `package-lock.json`.
