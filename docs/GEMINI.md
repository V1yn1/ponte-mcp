# Conectar a Ponte MCP 0.10.0 ao Gemini

[Índice da documentação](README.md) · [Instalação e operação](OPERACAO.md) · [API e ferramentas](API.md) · [Grok](GROK.md)

A Ponte oferece configuração para Gemini Apps, Gemini CLI e a Interactions API. Todas as chamadas chegam ao mesmo serviço Ponte e usam suas ferramentas, pastas autorizadas e política de aprovação. O serviço precisa estar atualizado, compilado e em execução; exportar uma configuração não inicia a Ponte nem conecta a conta Google.

| Caminho | Como conectar | Onde a operação acontece |
|---|---|---|
| Gemini Apps, nas contas elegíveis | URL HTTPS `/mcp`, descoberta OAuth e consentimento local | No computador da Ponte e nos MCPs conectados |
| Gemini CLI no mesmo computador | Configuração stdio com os caminhos da instalação | No computador da Ponte; sem túnel |
| Gemini CLI remoto | `httpUrl` HTTPS `/mcp` e OAuth | No computador da Ponte |
| Aplicação própria com Gemini API | Interactions API, Remote MCP e token API da Ponte | A Google chama a Ponte por HTTPS |
| Code Assist ou Enterprise | Configuração própria do produto, conforme as seções abaixo | Depende da conexão escolhida; exige validação no cliente |

As fontes oficiais foram consultadas em **22 de outubro de 2026**. Os testes controlados do projeto estão em [Validação](VALIDACAO.md). Eles não representam login ou execução em uma conta real Gemini, chamada paga ao modelo, teste de disponibilidade regional nem validação de uma implantação Enterprise.

## 1. Preparar a conexão remota

Publique a **API da Ponte**, normalmente na porta 4318, em uma origem HTTPS acessível. Preserve os caminhos `/mcp`, `/.well-known/*`, `/register`, `/authorize`, `/token` e `/oauth/*`. O painel administrativo da porta 4317 permanece local. Em **Conectar IA → URL pública da API**, salve a origem sem `/mcp`, por exemplo:

```text
https://ponte.example.com
```

Na aba **Gemini**, copie a URL MCP resultante: `https://ponte.example.com/mcp`. Salvar a origem não cria um túnel. Conserve o serviço e o encaminhamento ativos durante o uso. Se a origem mudar, atualize a configuração e refaça as autorizações vinculadas à origem anterior.

OAuth usa o consentimento no computador da Ponte. Compare o código de verificação da página pública com o pedido em **Conectar IA → Solicitações de conexão**, confira o cliente e o retorno e aprove a solicitação iniciada por você. Depois, volte à página de autorização para concluir o retorno. A aprovação automática de ferramentas não substitui esse consentimento de conexão.

## 2. Gemini Apps: navegador e aplicativo móvel

O [guia oficial de apps personalizados](https://support.google.com/gemini/answer/17209137?hl=en-12) permite cadastrar um servidor MCP no Gemini web. Na data consultada, exige usuário com **18 anos ou mais, nos EUA, conta Google pessoal, interface em inglês e Keep Activity ativado**. O recurso não está disponível para contas de trabalho/escola. A documentação não confirma acesso no Brasil.

Nas contas elegíveis:

1. Abra [Gemini](https://gemini.google.com/) no computador.
2. Entre em **Settings → Connected Apps**; algumas interfaces apresentam **Personal Intelligence → Connected Apps**.
3. Em **Custom apps**, escolha adicionar um app e informe a URL HTTPS `/mcp` da Ponte.
4. Continue em **Next** e conclua o consentimento descrito na seção anterior. A Ponte oferece DCR, portanto não é necessário criar credenciais de cliente manualmente para esse fluxo.
5. Selecione a Ponte com `@` em uma solicitação e peça `bridge_status`.

O cadastro é feito no site; após conectar, o app fica disponível também no aplicativo móvel compatível. O Gemini exige confirmação manual para ações de escrita. Essa confirmação do cliente é independente da política da Ponte. Os tokens `admin` e `api` não são Client ID ou Client Secret OAuth.

## 3. Gemini CLI no computador da Ponte

O adaptador stdio lê as credenciais do diretório de estado local e chama o serviço já iniciado. A configuração exportada não contém o token. No painel, copie a configuração **Gemini CLI local**. Também é possível exportá-la na pasta da Ponte:

```sh
node dist/cli.js export-client gemini-cli-stdio --state-dir .ponte --output gemini-ponte-local.json
```

O arquivo contém uma entrada como esta, com os caminhos reais da sua instalação:

```json
{
  "mcpServers": {
    "ponte": {
      "command": "/caminho/absoluto/para/node",
      "args": [
        "/caminho/absoluto/ponte-mcp/dist/cli.js",
        "stdio",
        "--state-dir",
        "/caminho/absoluto/ponte-mcp/.ponte"
      ],
      "timeout": 60000,
      "trust": false
    }
  }
}
```

Mescle a entrada `ponte` no objeto `mcpServers` de `~/.gemini/settings.json`; no Windows, o arquivo fica em `%USERPROFILE%\.gemini\settings.json`. Preserve os outros servidores e preferências. O exportador grava um documento separado: **não mescla nem altera as configurações do Gemini automaticamente**. Sem `--output`, mostra o documento no terminal. Se o arquivo de saída já existir, a exportação falha sem sobrescrevê-lo; escolha outro nome ou faça a mesclagem manualmente.

Reinicie o Gemini CLI e consulte `/mcp`. `trust:false` preserva as confirmações do cliente; a Ponte continua aplicando sua própria política. O timeout de 60000 ms deixa margem para uma espera nativa de até 45000 ms. Use o mesmo `--state-dir` do processo iniciado.

No Windows, use os caminhos gerados pelo painel ou pela CLI; o JSON já escapa as barras. Evite caminhos literais com marcadores de variável, como `$NOME` ou `${NOME}`: o cliente pode expandi-los ao carregar a configuração. Se a exportação recusar um caminho assim, use uma instalação/caminho compatível, sem editar o JSON para apontar a um destino diferente por acidente.

O [guia oficial do Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) descreve configuração, confiança, transportes e autenticação. Confiar na pasta do cliente é diferente de liberar novas pastas na Ponte.

## 4. Gemini CLI por HTTP com OAuth

Prepare a origem pública da seção 1. No terminal:

```sh
gemini mcp add --scope user --transport http --timeout 60000 ponte 'https://ponte.example.com/mcp'
```

Ou exporte o JSON e mescle no arquivo de configurações:

```sh
node dist/cli.js export-client gemini-cli-http --url https://ponte.example.com --output gemini-ponte-http.json
```

```json
{
  "mcpServers": {
    "ponte": {
      "httpUrl": "https://ponte.example.com/mcp",
      "timeout": 60000,
      "trust": false
    }
  }
}
```

`httpUrl` é a propriedade documentada para Streamable HTTP. Não troque por uma URL SSE: a Ponte não oferece o transporte legado `/sse`. A opção `--url` do exportador recebe a **origem HTTPS**, enquanto o JSON final contém `/mcp`. O perfil usa a origem já salva quando `--url` não é informado.

Na sessão interativa do Gemini CLI, use `/mcp auth ponte` para autenticar e `/mcp` para conferir a descoberta. O cliente faz descoberta OAuth/DCR e recebe o retorno em uma porta local. Não cadastre uma porta de callback fixa nem desative a validação de `iss`; a Ponte fornece o emissor correspondente à origem configurada.

O [fluxo OAuth documentado](https://geminicli.com/docs/tools/mcp-server/#oauth-support-for-remote-mcp-servers) requer navegador e retorno local disponíveis. Em ambiente sem navegador, o stdio local pode ser apropriado se a Ponte estiver no mesmo computador; uma falha de login não é motivo para publicar a API sem autenticação.

## 5. Gemini Code Assist e Enterprise

O [guia oficial do Code Assist](https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer) documenta MCP no **agent mode**. No VS Code, mescle a configuração stdio ou HTTP em `~/.gemini/settings.json` e execute **Developer: Reload Window**. No IntelliJ, o arquivo é `mcp.json` no diretório de configuração da IDE; para uso local, a entrada stdio da Ponte evita diferenças entre transportes remotos. Confira a descoberta no agent mode. A disponibilidade e as políticas do Code Assist continuam aplicáveis.

**Gemini Enterprise tem um fluxo administrativo distinto.** O [guia de custom MCP server data stores](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server) exige HTTPS/Streamable HTTP e configuração OAuth com URLs de autorização/token, cliente previamente registrado, escopos e ativação das ferramentas. Na Ponte, o escopo é `ponte:tools` e PKCE S256 é obrigatório; habilite PKCE no cliente. A opção de `offline_access` de outros provedores não é um escopo da Ponte. Não use o token API como Client Secret.

Os perfis desta entrega não criam data stores, credenciais Enterprise nem concessões organizacionais. A configuração e o fluxo OAuth precisam de teste no ambiente Enterprise correspondente antes de afirmar compatibilidade operacional dessa implantação.

## 6. Gemini API: exemplo executável com Remote MCP

A [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview) oferece [Remote MCP](https://ai.google.dev/gemini-api/docs/function-calling#remote-mcp-model-context-protocol). A Google acessa a URL pública `/mcp` por Streamable HTTP. A chave do Gemini autentica a aplicação na Google; o token API da Ponte autentica as chamadas encaminhadas à Ponte. São credenciais diferentes.

O exemplo [gemini-api.mjs](../examples/gemini-api.mjs) usa `fetch` do Node e o gerador de requisições compilado do projeto, sem dependências adicionais. Compile a Ponte antes de usá-lo:

```sh
npm run build
```

Defina estas variáveis apenas no ambiente local:

| Variável | Conteúdo |
|---|---|
| `GEMINI_API_KEY` | Chave da Gemini API autorizada na sua conta |
| `GEMINI_MODEL` | Identificador de um modelo disponível na sua conta que suporte essa integração |
| `PONTE_MCP_URL` | URL pública completa, por exemplo `https://ponte.example.com/mcp` |
| `PONTE_API_TOKEN` | Token **API** da Ponte; nunca o token administrativo |
| `PONTE_PROMPT` | Opcional: tarefa a enviar ao modelo |

Exemplo de preparo no PowerShell, na pasta da Ponte, sem colocar uma chave literal no histórico:

```powershell
$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Chave da Gemini API' -AsSecureString)).Password
$env:GEMINI_MODEL = Read-Host 'Identificador do modelo disponível na sua conta'
$env:PONTE_MCP_URL = 'https://ponte.example.com/mcp'
$env:PONTE_API_TOKEN = (node dist/cli.js token api --state-dir .ponte).Trim()
node examples/gemini-api.mjs
```

**Por padrão, o exemplo disponibiliza somente `bridge_status`.** Ele faz uma chamada à API e imprime a resposta JSON recebida, ocultando os valores das duas credenciais se forem reproduzidos na resposta. A ausência de erro HTTP não prova que o modelo chamou a ferramenta: confira os passos retornados, o resultado e a versão da Ponte.

Para uma tarefa autorizada que precise das ferramentas, defina `PONTE_PROMPT` com o escopo e execute:

```sh
node examples/gemini-api.mjs --tools
```

Essa opção permite as 12 ferramentas centrais, incluindo os gateways `bridge_read`, `bridge_invoke` e `bridge_call`. **Permitir um gateway dá acesso aos alvos que ele aceita no catálogo real**; a lista de nomes da API não limita, por si só, quais ferramentas locais/upstream podem ser chamadas através dele. As permissões e aprovações da Ponte continuam aplicáveis. Use o modo padrão para conferir a conexão antes de habilitar operações.

A requisição usa `type: "mcp_server"`, `name: "ponte"`, `url`, `headers` e `allowed_tools`. A chave Google vai no header `x-goog-api-key` da chamada à Interactions API. O token da Ponte vai em `headers.Authorization` do servidor MCP. O exemplo usa `store:false`, não fixa um modelo e não recebe credenciais como argumentos de linha de comando.

O painel também fornece um template, exportável pela CLI:

```sh
node dist/cli.js export-client gemini-api --url https://ponte.example.com --output gemini-request-template.json
```

Esse arquivo contém um envelope **`{ "url": ..., "body": ... }`** com marcadores de modelo/credencial. Ele é um template: JSON não substitui variáveis de ambiente sozinho. O exemplo executável faz a substituição e a validação necessárias. A exportação não envia a requisição, não lê sua chave Google e não consome a API.

O script encerra a espera HTTP após **120 segundos** e não faz retry automático. Um timeout ou uma resposta incompleta não provam que o provedor interrompeu a execução. Consulte os jobs/watchers existentes e o destino antes de decidir repetir qualquer operação. O exemplo é uma única chamada de demonstração; ele não mantém um processo de acompanhamento depois de terminar. A cobrança e as cotas da Gemini API são as da conta Google utilizada.

## 7. Ferramentas, identidades e acompanhamento

Em **Conectar IA → Catálogo MCP**, o perfil compacto anuncia 12 ferramentas centrais. Essa preferência é global para a instalação, inclusive ChatGPT, Claude e Grok; o padrão completo continua disponível. Os perfis Gemini não trocam essa preferência automaticamente.

Use `bridge_list_tools` para descobrir o catálogo atual e `bridge_tool_schema` para obter os argumentos exatos. Chame `bridge_read` para ferramentas classificadas como leitura ou `bridge_invoke` para os demais alvos, com `argumentsJson` contendo um objeto JSON serializado. MCPs cadastrados durante a conversa continuam acessíveis por essa descoberta. A [referência da API](API.md) e o [guia de cadastro de MCPs](MCPS-PELO-CHAT.md) detalham os contratos.

Conexões OAuth têm grants e identidades próprios. Adaptadores stdio e aplicações que usam o mesmo token API compartilham a identidade desse token na Ponte; trocar apenas o nome do cliente ou o modelo não cria isolamento. Esse token também autoriza as rotas `/v1`; não é uma credencial restrita somente ao Gemini. O token administrativo serve ao painel e nunca deve ser enviado ao provedor, à configuração MCP ou ao chat.

Para um job pendente, conserve `jobId` e acompanhe `bridge_job` com `waitMs:25000`. Se a tarefa for externa e assíncrona, crie o watcher nativo antes de enviá-la, configure o callback no executor e aguarde o mesmo `watcherId`. Cada `bridge_watch_wait` usa **25000 ms por padrão e no máximo 45000 ms**; o prazo total do watcher é separado dessas chamadas. Após interrupção de comunicação, consulte `bridge_watch_get` pelo ID original e retome a espera se ainda estiver `waiting`.

Continue durante o turno ativo até resultado terminal ou limite concreto do cliente. Informe `succeeded`, `failed` ou `needs_input` com a evidência correspondente. Não reenvie a tarefa, não crie outro watcher para recuperar a espera e não confunda o término de um comando de envio com a conclusão do executor. Veja [Watchers](WATCHERS.md).

`monitorDurable:true` e **`canWakeClosedConversation:false`** permanecem. Não há integração validada que acorde uma conversa Gemini encerrada. Hooks de CLI, um processo terminado ou a entrega de HTTP 2xx não comprovam a conclusão da tarefa externa. O acompanhamento usa o serviço da Ponte, sem substituí-lo por agendas do Gemini ou de outro chat. O servidor não remove cotas do provedor nem controla decisões internas de delegação do cliente.

## 8. Diagnóstico e aceitação no cliente

| Sintoma | Conferência |
|---|---|
| Custom apps não aparece no Gemini Apps | Requisitos de região, idade, conta pessoal, idioma e Keep Activity da seção 2 |
| O CLI não descobre a Ponte | Processo ativo, diretório de estado correto, caminhos exportados e `/mcp` no cliente |
| OAuth falha | Origem pública atual, metadados acessíveis e consentimento correspondente; mantenha a mensagem original sem publicar código ou token |
| HTTP tenta SSE | Use a configuração `httpUrl` ou `--transport http` |
| Ferramenta de um MCP novo não aparece | Descubra por `bridge_list_tools`, consulte o schema e use o gateway correspondente |
| HTTP da API responde 401/403 | Distinga a chave Google da credencial Ponte; não use o token admin |
| Uma chamada expirou | Consulte o ID original e o estado real antes de repetir a operação |
| O modelo respondeu sem ferramenta | Inspecione os passos da API ou a indicação de ferramentas do cliente; texto gerado não é recibo de execução |

Para validar sua instalação, confirme `bridge_status.version: "0.10.0"`, faça uma leitura autorizada, acompanhe uma edição reversível aprovada e consulte uma ferramenta de MCP conectado. Teste também uma interrupção de espera com recuperação pelo mesmo watcher. Registre separadamente conexão, chamada efetiva, aprovação, resultado e recuperação. A validação local descrita em [VALIDACAO.md](VALIDACAO.md) não substitui esse teste real no produto Google escolhido.
