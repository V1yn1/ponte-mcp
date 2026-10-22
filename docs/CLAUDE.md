# Conectar a Ponte MCP ao Claude

A Ponte oferece três caminhos para o Claude: conector remoto com OAuth, adaptador local para Claude Desktop e conexão pelo Claude Code. Todos usam os projetos, ferramentas e política de aprovação do mesmo serviço Ponte.

| Caminho | Configuração | Precisa publicar a API? |
|---|---|---|
| Claude no navegador ou conector remoto no Desktop | URL HTTPS `/mcp` e OAuth com registro automático | Sim |
| Claude Desktop local | Entrada `mcpServers` com o comando stdio da Ponte | Não |
| Claude Code | HTTP com OAuth ou comando stdio local | Somente para o caminho HTTPS deste guia |

As instruções de interface foram conferidas na documentação oficial em **22 de outubro de 2026**. A disponibilidade depende das políticas da conta ou organização. A validação automatizada da Ponte cobre protocolo e autenticação; não representa uma conexão executada em uma conta real do Claude.

## 1. Conector remoto: Claude no navegador e Desktop

### Preparar a Ponte

Inicie a Ponte e entre no painel local, normalmente `http://127.0.0.1:4317`. Encaminhe a **API da porta 4318** para uma origem HTTPS acessível. O encaminhamento precisa conservar todos os caminhos, inclusive `/.well-known/*`, `/authorize`, `/register`, `/token` e `/oauth/*`. Publicar somente `/mcp` impede o fluxo OAuth. A porta administrativa 4317 permanece local.

Em **Conectar IA → URL pública da API**, salve a origem, por exemplo `https://sua-ponte.exemplo.com`, sem `/mcp`. Na aba **Claude**, copie o endereço MCP resultante:

```text
https://sua-ponte.exemplo.com/mcp
```

Salvar a URL não inicia um túnel. Mantenha o serviço e o encaminhamento ativos. Se o endereço público mudar, salve a nova origem e autorize uma nova conexão: a mudança invalida as autorizações vinculadas à origem anterior.

### Adicionar no Claude

Conforme o [guia oficial de conectores](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities):

1. Abra **Customize → Connectors → Add → Custom → Web**.
2. Informe **Ponte MCP** como nome e cole a URL HTTPS terminada em `/mcp`.
3. Confira as opções de autenticação. Escolha **Sign in now** e, em **OAuth client**, **Register automatically**.
4. Continue e inicie a autorização.

**Register automatically** seleciona DCR, o mecanismo implementado pela Ponte. A opção de identidade publicada usa CIMD, que a Ponte não anuncia. Deixe Client ID e Client Secret vazios quando a interface permitir o cadastro automático. Os tokens `admin` e `api` da Ponte não são credenciais de cliente OAuth.

Em uma organização, o proprietário pode precisar habilitar o conector antes de seus membros o usarem. Os nomes dos controles podem aparecer traduzidos.

### Aprovar a conexão no computador

A página de autorização da Ponte apresenta um código de verificação de oito caracteres. No painel local, abra **Conectar IA → Solicitações de conexão**, escolha **Revisar conexão** e compare esse código, o nome do cliente e o endereço de retorno. Para o conector hospedado do Claude, o retorno documentado é:

```text
https://claude.ai/api/mcp/auth_callback
```

O nome do cliente é informado no registro e não prova sua identidade sozinho. Aprove o pedido que você iniciou e cujo código corresponde à página de autorização. Volte a essa página; ela acompanha a decisão e retorna ao Claude. A página pública não pede o token de administração.

Se o pedido expirar, inicie a conexão outra vez para gerar um novo código. Cada conexão OAuth precisa de aprovação local, inclusive quando a política de ferramentas está em `automatic`.

## 2. Claude Desktop local, sem túnel

O modo stdio inicia um adaptador que conversa com a Ponte já em execução. Ele lê as credenciais do diretório de estado local, sem copiá-las para a configuração do Claude.

1. Compile e inicie a Ponte conforme o [README](../README.md).
2. No painel, abra **Conectar IA → Claude** e copie o JSON do **Claude Desktop**. Ele contém os caminhos absolutos do Node, de `dist/cli.js` e do diretório de estado desta instalação.
3. No menu do aplicativo Claude Desktop, abra **Settings → Developer → Edit Config**.
4. Acrescente a entrada `ponte` ao objeto `mcpServers`, preservando as demais entradas.
5. Salve e encerre completamente o Claude Desktop antes de abri-lo novamente.

O [guia oficial de servidores locais MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers) descreve esse arquivo e o reinício. Exemplo ilustrativo; substitua os caminhos ou use o JSON gerado pelo painel:

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
      ]
    }
  }
}
```

No Windows, use caminhos como `C:\\Program Files\\nodejs\\node.exe` e escape as barras invertidas no JSON. O exemplo do painel já faz isso. Mantenha `--state-dir` apontando para o mesmo estado usado pelo serviço iniciado; a pasta de trabalho do Claude não determina os projetos autorizados pela Ponte.

Esse modo não usa OAuth nem precisa de URL pública. Ele compartilha a identidade do token API local com outros adaptadores stdio. Para encerrar o acesso do Desktop, remova sua entrada MCP e reinicie o aplicativo; a lista de autorizações OAuth é exclusiva das conexões OAuth.

## 3. Claude Code

### HTTP com OAuth

Prepare a mesma origem HTTPS da primeira seção. No terminal, execute:

```sh
claude mcp add --transport http ponte 'https://sua-ponte.exemplo.com/mcp'
claude mcp login ponte
```

Também é possível abrir `/mcp` em uma sessão interativa do Claude Code e autenticar a entrada **ponte**. Aprove o código no painel local e retorne ao fluxo de login. Esses comandos e o gerenciamento de conexões são descritos no [guia oficial do Claude Code](https://code.claude.com/docs/en/mcp).

O comando copiado do painel identifica o shell: PowerShell na instalação Windows, Bash/Zsh no macOS ou Linux. A URL é protegida como um único argumento literal. Use o shell indicado, em vez de colar um comando PowerShell no cmd.exe.

O Claude Code usa um callback no próprio computador, como `http://localhost:49152/callback`. A porta pode mudar a cada login. A Ponte aceita essa variação em callbacks HTTP de loopback registrados; host, caminho e query continuam iguais ao registro. `localhost` e `127.0.0.1` só são aceitos quando o respectivo host está registrado. Callbacks HTTPS continuam exigindo correspondência exata.

O código OAuth é vinculado ao callback efetivamente aprovado, inclusive à porta escolhida. A troca do código exige esse mesmo endereço e PKCE `S256`. O comportamento segue os [requisitos oficiais de autenticação do Claude](https://claude.com/docs/connectors/building/authentication).

### stdio no mesmo computador

Se o Claude Code está no computador da Ponte, pode usar o mesmo adaptador do Desktop. Substitua os caminhos absolutos abaixo:

```sh
claude mcp add --transport stdio ponte -- node "/CAMINHO/ponte-mcp/dist/cli.js" stdio --state-dir "/CAMINHO/ponte-mcp/.ponte"
```

O separador `--` entrega os argumentos seguintes ao processo da Ponte. Use o caminho absoluto do executável Node quando necessário, conforme `command` no JSON do painel. Mantenha a Ponte iniciada. Escolha um transporte por entrada; se **ponte** já existir, revise a configuração com `claude mcp get ponte` antes de adicionar outra entrada.

## 4. Validar uma chamada e acompanhar aprovações

Habilite a Ponte na conversa e peça:

```text
Use a Ponte MCP para chamar bridge_status e local_projects.
Mostre os projetos retornados pelas ferramentas.
```

Confira os dados reais e a chamada registrada no painel. A conclusão do consentimento sozinha não comprova que uma ferramenta foi executada.

As ferramentas seguem a política da Ponte: `mutations` revisa alterações, `all` revisa todas as chamadas e `automatic` libera as chamadas permitidas. As permissões dos projetos continuam valendo. Se uma ação retornar `pending_approval`, aprove o trabalho em **Execuções** e peça ao Claude para consultar **o mesmo `jobId`**, usando `bridge_job`:

```json
{ "jobId": "ID_RETORNADO", "waitMs": 25000 }
```

Consulte até obter o estado final, sem repetir a operação original. Uma autorização OAuth consulta seus próprios trabalhos; outra conexão OAuth não herda esse acesso. O painel administrativo pode acompanhar todos eles.

Esta integração com Claude usa chamadas MCP e consultas a `bridge_job`. O catálogo de MCP Events da Ponte não demonstra que o Claude cadastrou uma assinatura nem que retomará uma conversa. A retomada por evento depende de suporte e assinatura feitos pelo cliente; as instruções de Events do ChatGPT estão em [MCP-EVENTS.md](MCP-EVENTS.md).

## 5. Acompanhar uma demanda executada pelo Claude

Para uma tarefa longa delegada a outra sessão, use os [watchers nativos da Ponte](WATCHERS.md). **Crie `bridge_watch_create` antes de enviar a demanda**, com `trigger: {"type":"signal","source":"claude-code","runId":"neurolaudos-demanda-..."}`. Resolva uma eventual aprovação e entregue ao executor a URL e o token exclusivos retornados em `callback`, mantendo o segredo em ambiente ou arquivo privado. O script `scripts/ponte-watch-notify.mjs` envia o recibo explícito de `succeeded`, `failed` ou `needs_input` para esse `runId`.

Uma chamada SSH ou `tmux send-keys` concluída comprova o envio, e não o término da demanda neurolaudos. Um hook `Stop` genérico também não comprova a tarefa inteira: a [referência oficial de hooks](https://code.claude.com/docs/en/hooks#stop) o define como o momento em que o agente principal terminou de responder. O produtor deve sinalizar apenas depois de conferir os critérios de aceite, ou sinalizar a falha/pendência que efetivamente encontrou. Nenhum hook global é instalado por esse fluxo.

Use `bridge_watch_wait` no mesmo `watcherId`, com espera padrão de **25 segundos**, ou `waitMs` de 0 a **300000**. O cliente pode encerrar a chamada antes desse limite. O watcher `signal` persiste no serviço, inclusive após reinício da Ponte; uma desconexão remove só aquela espera. Não é necessário criar automations ou cron no Claude/ChatGPT, nem repetir a operação original. Volte a consultar ou aguardar o mesmo acompanhamento.

O [guia oficial MCP do Claude Code](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls) informa que, por padrão, uma chamada da conversa principal ainda em execução após **dois minutos** passa a uma tarefa em segundo plano, com exceções e configuração própria. Essa tarefa do cliente não sobrevive à saída da sessão. O watcher da Ponte e seu prazo são independentes dela; manter o resultado no servidor não garante acordar um chat encerrado. [WATCHERS.md](WATCHERS.md) apresenta o fluxo completo, o wrapper de processo e seus limites, sem alterar a instalação ou as conexões MCP existentes.

## Diagnóstico

| Sintoma | O que conferir |
|---|---|
| O Claude não alcança o servidor | Use a URL HTTPS `/mcp` correta; mantenha a Ponte e o túnel ativos; confira se a API inteira está encaminhada. |
| Descoberta OAuth falha | `/.well-known/oauth-protected-resource/mcp` e `/.well-known/oauth-authorization-server` devem responder JSON público. O `resource` deve ser a mesma URL `/mcp` cadastrada. |
| A interface exige um cliente OAuth | Escolha registro automático/DCR. Não preencha os tokens locais como Client ID ou Client Secret. |
| A autorização fica pendente | Compare o código e aprove no painel. Se a página mostrar um erro de rede ou do túnel, resolva esse erro e inicie outro pedido se ele expirou. |
| Claude Code rejeita o retorno | Atualize e reinicie a Ponte; confira o endereço local mostrado no pedido. Não acrescente curingas nem edite o callback manualmente. |
| Desktop informa falha de processo | Confira caminhos absolutos, JSON válido, diretório de estado e serviço iniciado. Reinicie completamente o Desktop. |
| A ferramenta está aguardando revisão | Abra **Execuções**, revise o trabalho e depois consulte o mesmo `jobId`. |
| A URL pública mudou | Atualize a origem no painel e reconecte; tokens do emissor anterior não são reutilizados. |

## Cobertura da implementação

Os testes automatizados exercitam descoberta, DCR público com o callback hospedado do Claude, consentimento local, PKCE, troca de código, renovação, revogação e chamadas reais de ferramentas por Streamable HTTP. Também cobrem callbacks locais com portas efêmeras, recusa de mudanças de host/caminho/query, erros sem redirecionamento inseguro e a regressão do fluxo ChatGPT com cliente confidencial.

O fluxo de teste usa listeners HTTP locais para simular os identificadores HTTPS. Ele não verifica um túnel externo, configurações de uma conta Claude, a interface do Claude Desktop ou a instalação do Claude Code do usuário. Faça a chamada da seção anterior após configurar o cliente para confirmar esses componentes.
