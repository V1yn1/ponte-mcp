# Conectar a Ponte MCP 0.10.0 ao Grok

[Índice da documentação](README.md) · [Instalação e operação](OPERACAO.md) · [API e ferramentas](API.md) · [Watchers](WATCHERS.md)

A Ponte oferece conexão ao Grok no chat, ao Grok Build e à API xAI. Os três caminhos acessam o catálogo da mesma Ponte e seguem as permissões dos projetos e a política de aprovação local.

| Caminho | Configuração | Onde a conexão acontece |
|---|---|---|
| Grok no navegador e aplicativos | Conector MCP personalizado com URL pública `/mcp` e OAuth | Os servidores do Grok acessam a Ponte |
| Grok Build local | Comando stdio e diretório de estado da Ponte | O adaptador acessa o serviço no mesmo computador |
| Grok Build remoto | URL HTTPS `/mcp` e OAuth | A CLI acessa a API publicada |
| API xAI Responses | Ferramenta `mcp`, URL HTTPS e token API da Ponte | A xAI acessa a Ponte durante a requisição |

As interfaces e os contratos oficiais foram consultados em **22 de outubro de 2026**. A [documentação de conectores do Grok](https://docs.x.ai/grok/connectors) descreve MCP personalizado no chat; o [anúncio oficial](https://x.ai/news/grok-connectors) inclui web, iOS e Android. As políticas da conta ou organização continuam aplicáveis. A evidência de testes da Ponte está em [Validação](VALIDACAO.md); configuração gerada e teste controlado do protocolo não comprovam uma conexão executada em uma conta real do Grok.

## 1. Conector no chat do Grok

### Preparar o endpoint

Inicie a Ponte e mantenha o painel local aberto. Publique a **API**, normalmente na porta **4318**, por uma origem HTTPS alcançável na internet. O túnel precisa encaminhar todos os caminhos da API, incluindo `/mcp`, `/.well-known/*`, `/register`, `/authorize`, `/token` e `/oauth/*`. O painel administrativo da porta **4317** permanece local.

Em **Conectar IA → URL pública da API**, salve a origem sem `/mcp`, por exemplo:

```text
https://sua-ponte.exemplo.com
```

Na aba **Grok**, copie a URL MCP resultante:

```text
https://sua-ponte.exemplo.com/mcp
```

Salvar a origem no painel não inicia um túnel. O serviço e o túnel precisam continuar ativos. O [guia oficial de túnel MCP do Grok](https://docs.x.ai/grok/connectors/custom-mcp-tunneling) explica que endereços como `localhost`, `127.0.0.1` e IPs de redes privadas não são alcançáveis pelos servidores do chat. Se a origem pública mudar, atualize-a na Ponte e autorize novamente as conexões vinculadas ao endereço anterior.

### Adicionar e autorizar

1. Abra [grok.com/connectors](https://grok.com/connectors).
2. Selecione **New Connector → Custom**.
3. Informe a URL HTTPS terminada em `/mcp` e inicie a autenticação solicitada.
4. No fluxo OAuth, use registro automático do cliente quando essa escolha estiver disponível. A Ponte implementa descoberta OAuth e registro dinâmico, conhecido como DCR.
5. Na página de autorização da Ponte, confira o código de oito caracteres.
6. No painel local, abra **Conectar IA → Solicitações de conexão**, revise o pedido e compare o código, o nome do cliente e o endereço de retorno.
7. Aprove o pedido que você iniciou e volte à página de autorização. Ela acompanha a decisão e redireciona ao Grok.

O nome apresentado pelo cliente não comprova sua identidade sozinho. O endereço de retorno é o registrado pelo fluxo real; este guia não inventa um callback fixo do Grok. Os tokens `admin` e `api` da Ponte não são Client ID ou Client Secret. A página pública de consentimento não solicita a credencial administrativa.

O consentimento OAuth continua sendo necessário mesmo quando a política de ferramentas da Ponte está em `automatic`. Se o pedido expirar, inicie novamente a autenticação para obter um novo código; não reutilize uma autorização antiga em outra origem.

### Grok Business e Enterprise

Nessas organizações, o administrador provisiona o conector antes de cada membro conectar sua conta. O caminho oficial é **console.x.ai → selecionar a equipe → Grok Business → Connectors → Add Connector → Other**. Depois de informar o endpoint e concluir a configuração administrativa, o membro conecta sua conta em `grok.com/connectors`. A disponibilidade e as permissões são controladas pela organização, conforme [Gerenciamento de conectores](https://docs.x.ai/grok/connector-management).

## 2. Grok Build no mesmo computador, por stdio

O adaptador stdio inicia um processo da Ponte que conversa com o serviço já em execução. Ele lê o token API do diretório de estado local; o arquivo de configuração do Grok não precisa conter esse segredo. Esse modo dispensa túnel e OAuth.

No painel, use a configuração local da aba **Grok**. A CLI também gera o perfil com os caminhos da instalação:

```sh
node dist/cli.js export-client grok-build-stdio --output grok-ponte-local.toml
```

Se o serviço usa um estado personalizado, acrescente `--state-dir` com a mesma pasta. Sem `--output`, o conteúdo é exibido no terminal. O comando exporta um trecho de configuração; ele não altera nem mescla automaticamente arquivos do Grok. Se o arquivo de saída já existir, a exportação falha sem sobrescrevê-lo; escolha outro nome ou faça a mesclagem manualmente.

Acrescente a seção gerada ao arquivo de configuração do Grok Build, preservando as demais seções. O [guia de configurações do Grok](https://docs.x.ai/build/settings) indica `~/.grok/config.toml` em macOS/Linux e `%USERPROFILE%\.grok\config.toml` no Windows. Uma entrada `ponte` já existente deve ser revisada antes de receber outra definição.

Exemplo ilustrativo para Windows; substitua os caminhos ou prefira o trecho gerado pela sua instalação:

```toml
[mcp_servers.ponte]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\Projetos\\ponte-mcp\\dist\\cli.js", "stdio", "--state-dir", "C:\\Projetos\\ponte-mcp\\.ponte"]
startup_timeout_sec = 30
tool_timeout_sec = 60
```

As barras invertidas acima estão escapadas para strings TOML. Os prazos são em **segundos**: 30 para iniciar a conexão e 60 para cada chamada. Isso não altera o máximo de 45 segundos de uma espera na Ponte. O Grok expande referências como `${VAR}` em campos de configuração; os exportadores recusam caminhos que poderiam ser reinterpretados, em vez de gerar uma configuração apontando para outro arquivo.

Uma alternativa é registrar o servidor pela própria CLI do Grok. Exemplo para Bash/Zsh, com caminhos substituídos pelos reais:

```sh
grok mcp add ponte -- node '/CAMINHO/ponte-mcp/dist/cli.js' stdio --state-dir '/CAMINHO/ponte-mcp/.ponte'
```

O separador `--` entrega os argumentos seguintes ao processo da Ponte. O comando copiado do painel usa o shell da instalação: PowerShell no Windows, Bash/Zsh em macOS/Linux. Não cole um comando PowerShell no cmd.exe. O cadastro por comando não define `tool_timeout_sec`: mescle os prazos do TOML gerado para usar 60 segundos por chamada. Sem esse ajuste, vale o padrão documentado do Grok Build, atualmente 6000 segundos. A [referência MCP do Grok Build](https://docs.x.ai/build/features/mcp-servers) também descreve compatibilidade com arquivos MCP de outros clientes; o perfil exportado aqui usa a configuração nativa do Grok.

Depois de salvar, abra `/mcps` no Grok Build para atualizar a conexão, ou reinicie o cliente. Para conferir descoberta e conectividade:

```sh
grok mcp list
grok mcp doctor ponte --json
```

## 3. Grok Build remoto, com OAuth

Prepare a origem HTTPS descrita na primeira seção. Registre o endpoint:

```sh
grok mcp add --transport http ponte 'https://sua-ponte.exemplo.com/mcp'
```

O Grok Build inicia o fluxo OAuth para servidores que exigem autenticação. Também é possível autenticar a entrada em `/mcps`. Compare e aprove o código no painel da Ponte e conclua o retorno ao cliente. Para falhas de descoberta ou login, execute `grok mcp doctor ponte --json` e preserve a mensagem observada.

A configuração nativa também pode ser exportada:

```sh
node dist/cli.js export-client grok-build-http --url https://sua-ponte.exemplo.com --output grok-ponte-remoto.toml
```

O argumento `--url` recebe a **origem HTTPS**, sem `/mcp`; o exportador acrescenta o endpoint. Se for omitido, a Ponte usa a origem pública configurada. O resultado contém `url`, `startup_timeout_sec` e `tool_timeout_sec`, sem copiar token API ou credencial administrativa. Escolha stdio ou HTTP para a entrada `ponte`, preservando outras configurações existentes.

## 4. API xAI Responses

O [contrato oficial Remote MCP](https://docs.x.ai/developers/tools/remote-mcp) permite ferramentas MCP por Streamable HTTP e SSE. A Ponte fornece Streamable HTTP em `/mcp`; o servidor da xAI não pode iniciar diretamente um processo stdio no seu computador.

Na Responses API, a ferramenta usa `type: "mcp"`, `server_url`, `server_label`, `allowed_tools` e `headers`. O SDK nativo xAI usa nomes diferentes para dois campos: `allowed_tool_names` e `extra_headers`. **Não acrescente `require_approval` ou `connector_id` ao exemplo da Responses API: a documentação xAI informa que esses parâmetros não são suportados.** A aprovação de ações continua sendo aplicada no servidor Ponte.

### Exportar o modelo de requisição

```sh
node dist/cli.js export-client grok-api --url https://sua-ponte.exemplo.com --output grok-ponte-api.json
```

Esse arquivo contém um envelope **`{ "url": ..., "body": ... }`**, com a URL da API xAI e um corpo de requisição. As referências de ambiente presentes no corpo são marcadores: JSON não as substitui sozinho. O arquivo não é um comando `curl` pronto, não envia requisição e não inclui suas credenciais reais. O exemplo executável abaixo usa o mesmo construtor e preenche os valores em tempo de execução.

### Executar o exemplo

Compile a Ponte antes de executar [examples/grok-api.mjs](../examples/grok-api.mjs). O exemplo usa `fetch` do Node, sem adicionar um SDK, e recebe estas variáveis:

| Variável | Valor esperado |
|---|---|
| `XAI_API_KEY` | Chave da API xAI da conta que realizará a requisição |
| `XAI_MODEL` | Identificador de um modelo da sua conta compatível com Remote MCP |
| `PONTE_MCP_URL` | URL pública completa, terminada em `/mcp` |
| `PONTE_API_TOKEN` | Token **API** da Ponte, obtido localmente e mantido em ambiente privado |
| `PONTE_PROMPT` | Opcional: pedido autorizado para essa execução |

A chave xAI autentica a chamada à API do modelo; o token da Ponte autentica a chamada ao MCP. São credenciais diferentes. O exemplo usa `headers.Authorization: Bearer ...` dentro da ferramenta MCP e nunca usa o token administrativo.

No PowerShell, na pasta da Ponte, prepare o ambiente sem colocar uma chave literal no histórico. Use o mesmo diretório de estado do serviço:

```powershell
$env:XAI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Chave da API xAI' -AsSecureString)).Password
$env:XAI_MODEL = Read-Host 'Identificador do modelo disponível na sua conta'
$env:PONTE_MCP_URL = 'https://ponte.example.com/mcp'
$env:PONTE_API_TOKEN = (node dist/cli.js token api --state-dir .ponte).Trim()
```

Com as variáveis definidas no ambiente e `npm run build` concluído:

```sh
node examples/grok-api.mjs
```

O padrão expõe somente `bridge_status` e solicita a versão observada. A chamada ao provedor usa a conta e as cotas/créditos da API xAI. A assinatura do chat e a configuração do MCP não concedem uso ilimitado da API; consulte as condições da sua conta.

Para disponibilizar as 12 ferramentas centrais e executar um pedido definido em `PONTE_PROMPT`, use a opção explícita:

```sh
node examples/grok-api.mjs --tools
```

Essas ferramentas incluem descoberta, schema, gateways, acompanhamento de jobs e controles de watchers. **Permitir `bridge_invoke` na allowlist permite alcançar os alvos autorizados do catálogo da Ponte.** A allowlist da xAI filtra os nomes da fachada; ela não restringe, por si só, os alvos internos de um gateway. As pastas autorizadas, os limites de execução e a aprovação da Ponte continuam determinando o que pode ser feito.

O exemplo aceita apenas `--tools` ou `--help`, tem limite HTTP de **120 segundos**, recusa redirecionamentos, não faz retries e imprime a resposta JSON ocultando os valores conhecidos das credenciais se forem reproduzidos pelo provedor. Em falhas HTTP, informa o status sem reproduzir o corpo de erro ou os cabeçalhos de autenticação. Uma interrupção pode deixar o resultado incerto: consulte jobs/watchers existentes e o destino antes de repetir uma ação. Esse prazo HTTP é da requisição ao modelo, não de cada espera nem do acompanhamento total de uma tarefa. O exemplo faz uma requisição; ele não instala um agendador, não mantém um agente permanente e não garante que o modelo continue até um watcher terminar.

## 5. Identidade, catálogo e aprovações

Conexões OAuth têm grants separados: uma conexão só consulta seus próprios jobs e watchers. O modo stdio e clientes que recebem o mesmo token API compartilham a identidade local da API; não há isolamento automático por nome de cliente. Revogar uma conexão OAuth não revoga esse token. Preserve os segredos fora de conversas, repositórios e arquivos exportados; o token `admin` fica no painel local.

O perfil **Compacto** em **Conectar IA → Catálogo MCP** vale para todos os clientes da mesma Ponte. Ele anuncia 12 controles e mantém os demais alvos disponíveis pelo catálogo real. O perfil **Completo** mantém a exposição direta. Depois de trocar o perfil ou atualizar a versão, atualize a descoberta no Grok e confira os nomes realmente disponíveis.

Use `bridge_list_tools` para localizar o alvo e `bridge_tool_schema` para obter seu `inputSchema`. `bridge_read` aceita ferramentas classificadas como leitura; `bridge_invoke` atende aos outros alvos autorizados. Ambos recebem `tool`, `argumentsJson` como string contendo objeto JSON e `idempotencyKey` opcional. O formato anterior `bridge_call` continua disponível. O cliente pode apresentar nomes prefixados, como `ponte__bridge_status`; preserve os nomes que ele efetivamente anunciou.

As ferramentas de cadastro `bridge_mcp_list`, `bridge_mcp_add` e `bridge_mcp_reconnect` permanecem disponíveis, inclusive em compacto por meio dos gateways. Um MCP recém-cadastrado pode ser descoberto pelo catálogo da Ponte sem cadastro separado no Grok. Confira conexão e resultado antes de declarar sucesso; consulte [MCPs pelo chat](MCPS-PELO-CHAT.md).

Jobs seguem a política local: `mutations` revisa alterações e execução, `all` revisa também leituras e `automatic` permite os trabalhos válidos dentro das permissões configuradas. O consentimento OAuth é separado dessa política. Para `pending_approval`, revise o pedido em **Execuções** e continue consultando o mesmo `jobId`, sem repetir a operação:

```json
{ "jobId": "ID_RETORNADO", "waitMs": 25000 }
```

## 6. Watchers nativos e recuperação

Para uma tarefa externa assíncrona, crie `bridge_watch_create` antes de enviar a demanda e configure o executor com o callback exclusivo retornado. O sinal deve representar a conclusão real dos critérios da tarefa. Concluir um comando de envio ou uma resposta do modelo não comprova conclusão do trabalho externo.

Use `bridge_watch_wait` no mesmo `watcherId`, com **25000 ms** por chamada e no máximo **45000 ms**. Enquanto o estado for `waiting`, mantenha o turno ativo e continue esperando pelo mesmo ID até um resultado terminal ou um limite concreto do cliente. O prazo total vem de `timeoutMs`/`expiresAt` e não é renovado pelas esperas.

Após timeout ou desconexão, recupere primeiro com `bridge_watch_get`. Se continuar `waiting`, volte a esperar pelo mesmo ID; se estiver terminal, apresente o resultado. Não crie outro watcher, não reenvie a demanda e não repita uma ação para descobrir se terminou. Informe sucesso, falha ou a intervenção indicada por `needs_input`. `expired` significa que o acompanhamento expirou e não comprova falha do executor.

Use os [watchers da Ponte](WATCHERS.md), sem substituir esse fluxo por agendamentos do chat. `monitorDurable` permanece **true** e `canWakeClosedConversation` permanece **false**. Não foi demonstrado que uma conversa encerrada do Grok seja retomada por Events. Um receptor HTTP controlado e uma resposta HTTP 2xx não comprovam essa capacidade.

## 7. Conferir a instalação e diagnosticar

| Verificação | Evidência esperada |
|---|---|
| Versão | `bridge_status` responde `0.10.0` na conexão usada pelo Grok |
| Descoberta | O cliente encontra `bridge_list_tools`, `bridge_tool_schema`, `bridge_read` e `bridge_invoke` |
| Leitura | Uma ferramenta de leitura retorna dados reais de um projeto autorizado |
| Escrita | Uma alteração reversível autorizada passa pela política e aparece no destino |
| Upstream | Uma ferramenta do MCP conectado retorna resultado, não apenas estado de cadastro |
| Aprovação/espera | O mesmo job continua até um estado final sem repetir a operação |
| Recuperação | O mesmo watcher conserva o resultado depois de uma espera interrompida |

Se o chat recusar a URL, confira alcance público, endpoint `/mcp` e origem salva na Ponte. Se OAuth falhar, confira descoberta, registro e retorno do pedido real, sem substituir credenciais por tokens administrativos. No Grok Build, `grok mcp doctor ponte --json` ajuda a separar configuração, autenticação e transporte. Se a API xAI rejeitar a requisição, confirme o modelo, os campos da Responses API, a validade dos dois tokens e a URL pública; preserve o status sem publicar segredos.

Os testes controlados descritos em [Validação](VALIDACAO.md) verificam contratos e comportamento da Ponte. Eles não devem ser apresentados como login real no Grok, execução paga na API xAI ou garantia de continuidade escolhida pelo modelo. O serviço fornece as ferramentas; cotas, políticas e disponibilidade de cada cliente continuam valendo.
