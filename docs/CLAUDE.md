# Conectar a Ponte MCP 0.8.0 ao Claude

[Índice da documentação](README.md) · [Instalação e operação](OPERACAO.md) · [API e ferramentas](API.md) · [ChatGPT](CHATGPT.md)

A Ponte oferece três caminhos para o Claude: conector remoto com OAuth, adaptador local para Claude Desktop e conexão pelo Claude Code. Todos usam os projetos, ferramentas e política de aprovação do mesmo serviço Ponte.

| Caminho | Configuração | Precisa publicar a API? |
|---|---|---|
| Claude no navegador ou conector remoto no Desktop | URL HTTPS `/mcp` e OAuth com registro automático | Sim |
| Claude Desktop local | Entrada `mcpServers` com o comando stdio da Ponte | Não |
| Claude Code | HTTP com OAuth ou comando stdio local | Somente para o caminho HTTPS deste guia |

As instruções de interface foram conferidas na documentação oficial em **22 de outubro de 2026**. A disponibilidade depende das políticas da conta ou organização. A cobertura automatizada da Ponte está descrita em [VALIDACAO.md](VALIDACAO.md); ela não representa uma conexão executada em uma conta real do Claude. Esta revisão documental não instalou nem autenticou um cliente Claude.

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

1. Compile e inicie a Ponte conforme [Instalação e operação](OPERACAO.md).
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

As solicitações executadas como jobs seguem a política da Ponte: `mutations` revisa alterações e comandos, `all` revisa também as leituras e `automatic` libera as chamadas permitidas. Controles diretos, como `bridge_status`, `bridge_job` e get/list/wait/cancel de watchers, não entram nessa fila. As permissões dos projetos e os controles do próprio Claude continuam valendo. Se uma ação retornar `pending_approval`, aprove o trabalho em **Execuções** e peça ao Claude para consultar **o mesmo `jobId`**, usando `bridge_job`:

```json
{ "jobId": "ID_RETORNADO", "waitMs": 25000 }
```

Consulte o mesmo job com esperas limitadas durante o turno ativo, sem repetir a operação original. Se o turno terminar, consulte o ID ao retornar. Uma autorização OAuth consulta seus próprios trabalhos; outra conexão OAuth não herda esse acesso. O painel administrativo pode acompanhar todos eles.

Esta integração com Claude usa chamadas MCP, consultas a `bridge_job` e as ferramentas de watcher descritas abaixo. O catálogo de MCP Events da Ponte não demonstra que o Claude cadastrou uma assinatura nem que retomará uma conversa. A retomada por evento depende de suporte e assinatura feitos pelo cliente; não foi validada por este roteiro. As instruções de Events do ChatGPT estão em [MCP-EVENTS.md](MCP-EVENTS.md).

## Adicionar MCPs pelo Claude conectado à Ponte

`bridge_mcp_list`, `bridge_mcp_add` e `bridge_mcp_reconnect` permitem gerenciar o cadastro de upstreams na mesma Ponte, usando a conexão já autorizada do Claude. O chat verifica se a capacidade existe, confirma a configuração oficial para a plataforma e solicita o cadastro com motivo. A política local decide entre revisão em **Execuções** e execução automática; as permissões e confirmações do próprio Claude continuam valendo.

O cadastro aparece em **Conexões MCP** sem reiniciar a Ponte. O resultado informa separadamente configuração salva e conexão estabelecida. IDs existentes não são sobrescritos com outra configuração; credenciais do contrato do chat usam referências de ambiente. A reconexão exige a revisão atual retornada pela listagem.

Mesmo que o cliente mantenha `tools/list` em cache, `bridge_list_tools` com `search: "bridge_mcp"` descobre essas operações para uso por `bridge_call`. O schema atual também aceita `source: "bridge:mcps"`. Depois de conectar o upstream, filtre `source: "mcp:ID"` e use o nome exportado retornado. Não é preciso cadastrar esse upstream separadamente no Claude. Exemplos e limites estão em [MCPs pelo chat](MCPS-PELO-CHAT.md).

## 5. Acompanhar uma demanda executada pelo Claude

Para uma tarefa longa delegada a outra sessão, use os [watchers nativos da Ponte](WATCHERS.md). **Crie `bridge_watch_create` antes de enviar a demanda**, com `trigger: {"type":"signal","source":"claude-code","runId":"meu-projeto-demanda-001"}`. Resolva uma eventual aprovação e entregue ao executor a URL e o token exclusivos retornados em `callback`, mantendo o segredo em ambiente ou arquivo privado. O [script produtor](../scripts/ponte-watch-notify.mjs) envia o recibo explícito de `succeeded`, `failed` ou `needs_input` para esse `runId`.

Uma chamada SSH ou `tmux send-keys` concluída comprova somente o envio à sessão. O watcher não inspeciona a janela do tmux, o texto do terminal ou um período sem atividade. Um hook `Stop` genérico também não comprova a tarefa inteira: a [referência oficial de hooks](https://code.claude.com/docs/en/hooks#stop) o define como o momento em que o agente principal terminou de responder. O produtor deve sinalizar depois de conferir os critérios de aceite, ou sinalizar a falha/pendência que efetivamente encontrou. Nenhum hook global é instalado por esse fluxo.

Use `bridge_watch_wait` no mesmo `watcherId`, com **25000 ms** por padrão e no máximo **45000 ms**. Enquanto retornar `waiting`, mantenha o turno ativo com novas esperas de 25000 ms até um estado terminal ou limite concreto do cliente. `waitMs` vale somente para a chamada; `timeoutMs` define o prazo total (padrão 1 hora, máximo 7 dias) registrado em `expiresAt`, sem renovação pelas esperas. Use o watcher nativo, sem automations, cron ou agendamentos no Claude/ChatGPT.

O watcher `signal` persiste no serviço, inclusive após reinício da Ponte; uma desconexão remove só aquela espera. Após timeout, falha durante a resposta ou HTTP 503 no caminho stdio, consulte `bridge_watch_get` pelo mesmo ID antes de voltar a esperar. A orientação estruturada não inventa estado. Um `waitMs` acima de 45000 é rejeitado com recuperação pelo mesmo ID, sem reduzir o valor silenciosamente. Autenticação inválida ou registro não encontrado exigem conferir conexão/ID, sem retry cego, nova criação ou reenvio da operação.

Informe `succeeded` ou `failed` com a evidência pertinente. `needs_input` é terminal: apresente a pendência e peça intervenção, sem continuar o loop. Uma nova etapa explicitamente autorizada usa outro watcher. `expired` significa que o prazo do acompanhamento venceu e não prova que o executor falhou.

As respostas individuais mantêm `monitorDurable: true` e `canWakeClosedConversation: false` na 0.8.0. O callback vai do executor à Ponte. No sentido inverso, o novo `ponte.watcher.completed` exige um cliente com `events/subscribe` e não comprova que Claude oferece esse fluxo. Se um job da Ponte somente cria o watcher ou envia o prompt, `ponte.job.completed` cobre apenas essa etapa. [WATCHERS.md](WATCHERS.md) apresenta o fluxo completo e a recuperação.

### Claude Code Channels: possibilidade futura

A [documentação de Channels](https://code.claude.com/docs/en/channels) descreve eventos enviados por um servidor MCP à sessão Claude Code em execução. A sessão e o processo precisam permanecer abertos. A [referência de canais próprios](https://code.claude.com/docs/en/channels-reference) exige capacidade `claude/channel`, notificações próprias e transporte stdio; o teste de canal customizado requer opt-in em sessão interativa, sujeito às políticas da organização.

A Ponte **não implementa Channels nesta entrega**. Essa pesquisa identifica um caminho possível para uma integração futura; o adaptador stdio atual e MCP Events não ativam um canal Claude automaticamente e não prometem retomar uma sessão encerrada.

## 6. Atualizar o catálogo e reconectar

Atualize e reinicie a Ponte conforme [Instalação e operação](OPERACAO.md), preservando o diretório de estado. Confirme `version: "0.8.0"` em `bridge_status` e as três ferramentas `bridge_mcp_*`, além dos cinco nomes `bridge_watch_*`, no catálogo. Para stdio, reinicie completamente o Desktop ou reconecte o servidor em `/mcp` no Claude Code. Para o conector remoto, atualize a conexão na interface disponível e valide a ferramenta em nova conversa.

Reiniciar o serviço com a mesma origem HTTPS e o mesmo estado preserva as autorizações OAuth concluídas. Se o login foi interrompido antes de terminar, inicie-o novamente. Uma nova autorização não herda os jobs e watchers da autorização anterior; tente consultar os IDs pela conexão ainda válida antes de substituí-la.

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
| MCP conectado, mas a ferramenta não aparece diretamente | Use `bridge_list_tools` com `source: "mcp:ID"` e chame o nome por `bridge_call`; o catálogo interno já é atualizado. |
| `bridge_watch_*` ou `bridge_mcp_*` não aparece | Confirme a 0.8.0 e recarregue o catálogo; reconecte o stdio ou atualize a conexão remota. |
| `claude mcp login` não existe na versão instalada | Use `/mcp` na sessão interativa para autenticar, e confira a documentação correspondente à sua versão do Claude Code. |
| O watcher está `waiting`, mas o tmux parece parado | Confira o recibo do executor. Inatividade ou fim de resposta não concluem uma tarefa. |
| O produtor confirmou o sinal, mas não há novo turno | Consulte o watcher; o recebimento pela Ponte não ativa sozinho uma conversa encerrada. |

## Cobertura da implementação

Os testes automatizados exercitam descoberta, DCR público com o callback hospedado do Claude, consentimento local, PKCE, troca de código, renovação, revogação e chamadas reais de ferramentas por Streamable HTTP. Também cobrem callbacks locais com portas efêmeras, recusa de mudanças de host/caminho/query, erros sem redirecionamento inseguro e a regressão do fluxo ChatGPT com cliente confidencial.

O fluxo de teste usa listeners HTTP locais para simular os identificadores HTTPS. Ele não verifica um túnel externo, configurações de uma conta Claude, a interface do Claude Desktop ou a instalação do Claude Code do usuário. Faça a chamada da seção 4 após configurar o cliente para confirmar esses componentes.

## Referências oficiais

- [Claude — conectores e registro de um MCP remoto](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).
- [Claude — autenticação de conectores](https://claude.com/docs/connectors/building/authentication).
- [Claude Code — transportes, login, reconexão e esperas MCP](https://code.claude.com/docs/en/mcp).
- [Claude Code — significado do hook Stop](https://code.claude.com/docs/en/hooks#stop).
- [Claude Code — Channels e necessidade de sessão em execução](https://code.claude.com/docs/en/channels).
- [Claude Code — contrato e opt-in de canais próprios](https://code.claude.com/docs/en/channels-reference).
- [MCP — configuração de servidores locais no Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
