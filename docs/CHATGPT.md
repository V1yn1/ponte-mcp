# Conectar a Ponte MCP 0.2.0 ao ChatGPT

A Ponte oferece OAuth para a conexão MCP nativa do ChatGPT. O usuário autoriza o acesso no painel do próprio computador e pode revogá-lo depois. O ChatGPT não recebe a credencial de administração.

Este roteiro descreve o fluxo implementado e como validá-lo. A conexão completa com uma conta real do ChatGPT não foi executada no ambiente de entrega. As permissões da conta e do workspace para adicionar MCPs continuam sendo requisitos externos à Ponte.

## 1. Preparar a API HTTPS

Inicie a ponte e entre no painel local em `http://127.0.0.1:4317`. Se você usa portas personalizadas, substitua os valores deste roteiro.

Configure um encaminhamento HTTPS para **toda a API em `http://127.0.0.1:4318`**. O encaminhamento deve conservar os caminhos: publicar somente `/mcp` impede a descoberta OAuth e a autorização. Use uma origem estável, como `https://sua-ponte.exemplo.com`.

Em **Conectar ChatGPT → URL pública da API**, salve essa origem, sem caminho, credenciais, query string ou fragmento. O valor é `https://sua-ponte.exemplo.com`; a URL a cadastrar no ChatGPT será `https://sua-ponte.exemplo.com/mcp`.

O painel da porta **4317 permanece local**. A Ponte não cria o túnel ao salvar a URL. Mantenha o processo da ponte e o encaminhamento em execução durante o uso.

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

As instruções seguem a documentação oficial consultada em **22 de outubro de 2026**. Os rótulos podem aparecer traduzidos.

1. Abra **Plugins**, selecione **+** e depois **Add custom MCP server**.
2. Informe um nome, por exemplo **Ponte MCP**, e uma descrição opcional.
3. Em **Connection**, use a opção de URL e informe `https://sua-ponte.exemplo.com/mcp`.
4. Escolha autenticação **OAuth**. Deixe Client ID e Client Secret vazios para o cadastro dinâmico. Se a interface perguntar pelo método de registro, selecione **DCR**.
5. Revise as informações da conexão e prossiga. O ChatGPT descobre os endpoints e registra seu cliente OAuth automaticamente.

O Bearer fixo mostrado por `token api` continua destinado a Actions e clientes que aceitam essa credencial. Ele não deve ser preenchido como Client ID ou Client Secret no fluxo OAuth.

## 4. Aprovar no computador

O início da autorização pode ocorrer ao criar a conexão ou quando o ChatGPT solicitar acesso a uma ferramenta protegida.

1. A página de autorização da Ponte mostra um **código de verificação de oito caracteres**. Mantenha essa página aberta.
2. No painel local, entre em **Conectar ChatGPT** e abra a solicitação com **Revisar conexão**.
3. Encontre o pedido com o mesmo código. Confira o cliente, o destino do retorno e a permissão solicitada.
4. Autorize somente o pedido que você acabou de iniciar. Se não reconhecer a solicitação ou se o código não coincidir, rejeite-a.
5. Volte à página de autorização. Ela acompanha a decisão e retorna automaticamente ao ChatGPT após aprovar.

A página pública de consentimento não pede o token de administração. O código de verificação serve para identificar o mesmo pedido nas duas telas; não substitui o login no painel local.

O pedido expira em 10 minutos. Caso expire, inicie a conexão novamente no ChatGPT e compare o novo código. A autorização OAuth permite chamar as ferramentas expostas pela Ponte; permissões de escrita e execução e aprovações de trabalhos continuam valendo.

## 5. Instalar e testar uma chamada

Conclua **Create as a plugin** no ChatGPT, confira as ferramentas descobertas e instale o plugin. Abra uma conversa, use `@` para selecionar a Ponte e envie:

```text
Use a Ponte MCP para consultar bridge_status e depois local_projects.
Mostre apenas os projetos retornados pelas ferramentas.
```

O teste está concluído quando o ChatGPT executa a ferramenta e devolve os dados da sua ponte. Uma página de consentimento aprovada, sozinha, não demonstra que a chamada MCP funcionou.

Depois, se desejar verificar a revisão de escrita, solicite a criação de um arquivo de teste em um projeto autorizado. A chamada pode retornar `pending_approval`. Revise o trabalho em **Execuções** no painel e aprove; então peça ao chat para consultar `bridge_job`. Só considere a operação concluída quando o resultado confirmar o sucesso.

## Renovação, revogação e atualização

| Item | Comportamento da Ponte |
|---|---|
| Cliente registrado por DCR | Persiste entre reinícios; seu segredo não expira automaticamente |
| Pedido aguardando aprovação local | Expira em 10 minutos |
| Código de autorização OAuth | Uso único; expira em 2 minutos |
| Access token | Validade de até 1 hora, limitada também ao vencimento da autorização |
| Refresh token | Rotacionado a cada renovação; limitado ao prazo absoluto de 30 dias da autorização |
| Reutilização de refresh token já consumido | Revoga a família de tokens daquela autorização |
| Revogação pelo painel | Interrompe o acesso daquela autorização; uma nova conexão exige consentimento |

Ao vencer o prazo de renovação, conecte novamente pelo ChatGPT e autorize no painel. As credenciais OAuth ficam sob gestão do cliente e da ponte; você não precisa copiar access ou refresh tokens.

Pedidos aguardando decisão e códigos OAuth ainda não trocados ficam em memória. Se o serviço reiniciar durante a autorização, recomece esse fluxo no ChatGPT. Conexões já concluídas usam o estado persistido em `oauth.json`.

Após atualizar ferramentas, schemas ou autenticação, atualize a conexão em **Plugins → sua conexão → Refresh** e teste em uma conversa nova. Ao mudar a origem HTTPS, atualize `publicUrl` e configure novamente a conexão para a nova URL: emissor, recurso e destino dos tokens dependem desse endereço.

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
| A aprovação ocorreu, mas não houve retorno | Mantenha a página de autorização aberta; confira se a ponte e o túnel estão ativos e reinicie o fluxo se o código OAuth expirou |
| `invalid_client` após reiniciar | Confira se o processo usa o mesmo `.ponte/oauth.json`; não recrie o estado entre reinícios |
| Token recusado após mudar a URL | O token está vinculado ao recurso e emissor anteriores; conecte de novo usando a nova origem |
| Uma escrita está pendente | Abra **Execuções** no painel; o consentimento OAuth não substitui a aprovação do trabalho |
| Ferramentas antigas ou ausentes | Atualize a conexão, confira o catálogo no painel e inicie uma conversa nova |

Para clientes e modos alternativos, incluindo stdio, Actions e Secure MCP Tunnel, consulte [INTEGRACOES.md](INTEGRACOES.md). Os testes executados na entrega ficam em [VALIDACAO.md](VALIDACAO.md).

## Documentação oficial

- [Adicionar um MCP ao ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Autenticação OAuth de MCPs](https://developers.openai.com/plugins/build/auth)
- [Conectar e testar um MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Metadados e erros de ferramentas](https://developers.openai.com/plugins/reference)
