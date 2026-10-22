# Usar a Ponte MCP com dots — 0.9.0

[Índice da documentação](README.md) · [Conectar ao ChatGPT](CHATGPT.md) · [API e ferramentas](API.md) · [Operação](OPERACAO.md)

A Ponte 0.9.0 oferece um caminho de descoberta e execução para seu dot usar as ferramentas registradas na Ponte pela própria conexão MCP. A operação acontece no computador que executa a Ponte; o servidor não exige abrir uma sessão Work ou Codex. “Todas as ferramentas” significa as ferramentas disponíveis e autorizadas nesse catálogo, incluindo MCPs conectados à Ponte. Não significa acesso às ferramentas internas de todos os outros plugins da conta.

A [documentação oficial de dots](https://learn.chatgpt.com/docs/dots/computers-and-apps) informa que eles podem usar plugins compatíveis instalados e habilitados, inclusive para atualizar documentos. O acesso depende da conta conectada, das permissões e do ambiente. A documentação também permite ao dot [criar outras threads e delegar trabalho](https://learn.chatgpt.com/docs/dots/tasks-and-memory). Portanto, a Ponte oferece execução direta no servidor, mas não controla a disponibilidade de ferramentas nem as decisões de delegação do ChatGPT.

**Validação no dot: ainda não verificada para a 0.9.0.** Na consulta real de 22 de outubro de 2026, a instância conectada respondeu `version: "0.6.0"`, `approvalMode: "automatic"` e `toolCount: 62`. Esse resultado confirma uma chamada àquela instância antiga; não valida o perfil compacto nem a execução da nova versão no dot. Testes locais e evidência no cliente são registrados separadamente em [Validação](VALIDACAO.md).

## 1. Conectar e atualizar a descoberta

Se a Ponte ainda não está conectada, siga [Conectar ao ChatGPT](CHATGPT.md) para publicar a API por HTTPS, cadastrar `/mcp`, concluir OAuth e autorizar a conexão no painel local. O dot usa o plugin instalado e habilitado na mesma conta; conversar com seu dot por outro canal não conecta automaticamente os apps necessários.

Se a conexão já funciona:

1. Atualize e reinicie a Ponte com o mesmo diretório de estado, conforme [Operação](OPERACAO.md#atualizar-sem-perder-a-configuração).
2. Consulte `bridge_status` na conexão usada pelo dot. Confirme `version: "0.9.0"`; a versão dos arquivos locais, sozinha, não confirma qual serviço recebeu a chamada.
3. Em **Plugins**, abra a conexão da Ponte e use **Refresh/Atualizar**. Confira `bridge_tool_schema`, `bridge_read` e `bridge_invoke` entre os descritores descobertos.
4. Confirme que o plugin continua instalado, habilitado e autenticado. A atualização do catálogo não exige novo OAuth se a autorização permanece válida.
5. Peça ao dot uma nova consulta de `bridge_status` e `bridge_list_tools`. Se a sessão conservar ferramentas antigas, teste também em uma nova conversa compatível para localizar o problema; esse teste auxiliar não substitui o teste no dot.

O [procedimento oficial de conexão e teste](https://developers.openai.com/plugins/deploy/connect-chatgpt) recomenda atualizar os metadados e testar em nova conversa depois de alterar os descritores. Ele não garante que uma conversa de dot já aberta recarregue imediatamente cada ferramenta. Preserve a conexão e a evidência do erro antes de refazer cadastros.

### Ler `directExecution` corretamente

`bridge_status.directExecution` informa o contrato oferecido pelo servidor:

| Campo | O que significa |
|---|---|
| `supported: true`, `executionLocation: "ponte_host"` | A Ponte executa os alvos no seu próprio ambiente |
| `requiresWorkSession: false`, `requiresCodexSession: false` | O servidor não depende dessas sessões para atender a chamada MCP |
| `toolExposure: "full"` ou `"compact"` | Perfil do catálogo anunciado |
| `catalogTool`, `schemaTool`, `readTool`, `invokeTool` | Nomes dos controles para descobrir e chamar alvos |
| `argumentEncoding: "json_object_string"`, `dynamicCatalog: true` | O gateway aceita o objeto de argumentos serializado e consulta o catálogo atual |
| `clientToolAvailability: "not_observable_by_server"` | A Ponte não enxerga quais ferramentas o host entregou ao agente |
| `hostPermissionsApply: true`, `clientMayDelegate: true` | Permissões e escolhas de execução do ChatGPT continuam aplicáveis |
| `refreshClientAfterUpdate: true` | A descoberta do cliente precisa ser conferida após atualizar |

Esses campos não são um teste de prontidão do dot. O roteiro da seção 6 verifica o que ocorreu no cliente.

## 2. Escolher o catálogo: completo ou compacto

Em **Conectar IA → Catálogo MCP**, escolha o perfil adequado e atualize a descoberta no cliente depois de salvar:

| Perfil | Catálogo MCP anunciado | Uso |
|---|---|---|
| `full` — padrão | Ferramentas gerais, locais, gerenciamento, watchers e upstreams | Preserva a exposição direta usada nas versões anteriores |
| `compact` — opcional | Oito ferramentas gerais e quatro controles de watchers | Reduz o conjunto inicial de descritores; o agente descobre os alvos pelo catálogo real |

As **12 ferramentas anunciadas em `compact`** são:

- `bridge_status`, `bridge_list_tools`, `bridge_tool_schema`;
- `bridge_read`, `bridge_invoke`, `bridge_call`;
- `bridge_job`, `bridge_cancel`;
- `bridge_watch_get`, `bridge_watch_list`, `bridge_watch_wait`, `bridge_watch_cancel`.

`bridge_watch_create`, `bridge_mcp_list/add/reconnect`, ferramentas locais e upstreams continuam no catálogo real. Use `bridge_list_tools` e os gateways para chamá-las. Nomes diretos que o cliente já conhece continuam chamáveis: `compact` é uma escolha de exposição, não uma lista de permissões. Trocar o perfil não muda `/mcp`, OAuth, aprovação, pastas autorizadas ou cotas.

O valor é salvo em `config.json` como `mcpToolExposure`; configurações anteriores sem o campo assumem `full`. O painel usa o `PATCH /admin/settings` existente. Não há uma API exclusiva de dots nem uma configuração `defer_loading` da Ponte.

## 3. Instrução para usar na conversa

Este texto é uma orientação copiável, não uma skill ou uma configuração do dot:

```text
Para a tarefa autorizada, prefira usar as ferramentas MCP da Ponte nesta
conversa. Consulte bridge_status e bridge_list_tools; obtenha o contrato
com bridge_tool_schema e use bridge_read para leitura ou bridge_invoke
para os demais alvos, com argumentsJson conforme o schema real. A Ponte
executa as operações no seu host, sem exigir uma sessão Work ou Codex.
Se faltar uma ferramenta, informe o nome e o erro observado antes de
propor outra forma de execução.
```

Peça também que o dot acompanhe o mesmo `jobId`, confira o resultado e apresente a evidência da conclusão. O exemplo ampliado em [chat-instructions.txt](../examples/chat-instructions.txt) inclui aprovação, arquivos, upstreams e watchers.

As [regras de controle de dots](https://learn.chatgpt.com/docs/dots/controls) distinguem instruções de autorização e acesso a apps. Um pedido com escopo claro ajuda a conduzir a tarefa, mas não torna uma ferramenta ausente disponível. A restrição de somente leitura citada nessa documentação se refere à pesquisa proativa; ela não descreve todas as ações de um dot.

## 4. Descobrir o alvo e montar a chamada

### Consultar o catálogo atual

Use `bridge_list_tools` com um resumo quando ainda estiver escolhendo a ferramenta:

```json
{ "includeSchemas": false, "offset": 0, "limit": 25 }
```

Percorra `nextOffset` quando presente. `includeSchemas` é `true` por padrão, para preservar os clientes anteriores. `search` pesquisa o catálogo e `source` filtra uma origem exata: `local`, `bridge:mcps`, `bridge:watchers` ou `mcp:` seguido do ID real do servidor.

Para inspecionar uma ferramenta local conhecida, chame `bridge_tool_schema`:

```json
{ "tool": "local_read_file" }
```

O retorno é o próprio descritor com `name`, `title`, `description`, `inputSchema`, `risk` e `source`, acrescido de `invocation`. Em `invocation`, `tool` indica `bridge_read` ou `bridge_invoke`, `target` contém o nome exato e `argumentsJson` descreve a string de argumentos obrigatória. Não procure esse schema em `resposta.tool.inputSchema`: não existe esse nível intermediário. A orientação não contém argumentos já preenchidos nem representa uma chamada executada.

### Leitura e edição de um arquivo com hash atual

Comece identificando um projeto real por `local_projects`, chamado por `bridge_read`:

```json
{ "tool": "local_projects", "argumentsJson": "{}" }
```

Escolha um arquivo de teste existente e uma alteração reversível autorizada. Confira os schemas de `local_read_file` e `local_edit_file`. O trecho abaixo demonstra a montagem dos argumentos: `projectId`, `path`, `oldText` e `newText` precisam vir da tarefa e do arquivo real; `leitura` é o resultado bem-sucedido de `local_read_file`.

```javascript
// Envie este objeto a bridge_read e acompanhe o resultado da leitura.
const pedidoDeLeitura = {
  tool: "local_read_file",
  argumentsJson: JSON.stringify({ projectId, path }),
};

// Depois da leitura, envie este objeto a bridge_invoke.
const pedidoDeEdicao = {
  tool: "local_edit_file",
  argumentsJson: JSON.stringify({
    projectId,
    path,
    oldText,
    newText,
    expectedHash: leitura.sha256,
  }),
  idempotencyKey: chaveUnicaDestaEdicao,
};
```

Isso é uma receita de payload, não um script pronto para executar. `oldText` precisa ocorrer exatamente uma vez. Nunca fabrique `expectedHash`: use o SHA-256 retornado pela leitura atual. Após a edição, leia novamente e confira o trecho. Para restaurar o arquivo, inverta a alteração com o **novo** hash e outra chave de idempotência. `expectedHash: null` serve somente para criar um arquivo inexistente com `local_write_file`, não para editar um arquivo que já existe.

### Upstream sem adivinhar nomes ou argumentos

Liste as conexões por `bridge_mcp_list` e pesquise `bridge_list_tools` com `source` igual a `mcp:` mais o ID retornado. Escolha um item real e consulte `bridge_tool_schema` com seu `name` exato. Não remova o namespace ou um eventual hash do nome exportado.

Para qualquer upstream, a montagem usa o schema recebido:

```javascript
// item é um descritor real escolhido em bridge_list_tools.
const pedidoDeSchema = { tool: item.name };
// Envie pedidoDeSchema a bridge_tool_schema.

// descriptor é a resposta real de bridge_tool_schema.
// argumentosDoAlvo deve obedecer a descriptor.inputSchema e à tarefa.
const pedidoAoGateway = {
  tool: descriptor.invocation.target,
  argumentsJson: JSON.stringify(argumentosDoAlvo),
  idempotencyKey: chaveUnicaDestaOperacao,
};
// Envie pedidoAoGateway à ferramenta indicada em descriptor.invocation.tool.
```

Não há nome ou schema universal de ferramenta externa. O objeto serializado precisa conter apenas os campos que aquele `inputSchema` aceita. `bridge_read` recusa alvos `write` e `execute`, inclusive se o risco mudar enquanto um job aguarda. Para esses alvos, use `bridge_invoke` dentro da autorização e da política existentes. Não altere a classificação de uma ferramenta para fazê-la passar pela rota de leitura.

`argumentsJson` deve ser uma string contendo objeto JSON; arrays, `null`, escalares e JSON inválido são recusados. A string e o envelope HTTP estão sujeitos aos limites de 1 MiB. O gateway preserva a validação do alvo, os blocos de resultado, imagens e erros, sem aumentar os limites da Ponte. `bridge_call` continua disponível com `arguments` como objeto.

## 5. Acompanhar e apresentar o resultado

A chamada inicial pode aguardar até 25 segundos por um job `queued` ou `running`. Se voltar `pending_approval`, apresente a necessidade de revisão no painel **Execuções**. Continue pelo mesmo `jobId`:

```json
{ "jobId": "ID_REAL_RETORNADO", "waitMs": 25000 }
```

O ID acima é um marcador para substituir, não um registro existente. `bridge_job` aceita de 0 a 25000 ms, com padrão 0. Consulte o estado terminal, `isError` e todos os blocos pertinentes do resultado. Não reenvie a operação para saber se terminou. `bridge_read` também passa pela aprovação de jobs quando a política é `all`.

Para uma tarefa externa assíncrona, os [watchers nativos](WATCHERS.md) mantêm o fluxo da 0.8.0: criar antes de delegar, receber o sinal real do executor e aguardar o mesmo `watcherId`. `bridge_watch_wait` usa 25000 ms por padrão e no máximo 45000 ms por chamada. Após falha de comunicação, consulte `bridge_watch_get` antes de esperar novamente. Não crie um agendamento para substituir esse acompanhamento.

[MCP Events](MCP-EVENTS.md) permanece opcional e separado. A [OpenAI documenta suporte a eventos com dots](https://developers.openai.com/plugins/build/mcp-events), mas descoberta, inscrição, entrega HTTP e continuação do dot são evidências diferentes. Os valores `monitorDurable: true` e `canWakeClosedConversation: false` permanecem no contrato da Ponte.

## 6. Roteiro de aceitação no dot

Execute este roteiro na instalação atualizada e na conversa do dot. Registre data, versão, perfil, ferramenta e resultado, sem tokens, conteúdo privado ou identificadores de usuário em registros públicos.

| Etapa | Ação | Evidência necessária |
|---|---|---|
| Instância | Chamar `bridge_status` | Versão 0.9.0, perfil e política da instância realmente acessada |
| Descoberta | Listar resumo e obter o schema de um alvo | Nome, origem, risco e contrato coerentes; paginação preservada |
| Leitura local | Ler um arquivo autorizado por `bridge_read` | Resultado real, conteúdo conferido e hash |
| Escrita reversível | Editar um trecho único com `expectedHash`, reler e restaurar com o novo hash | Resultado de cada job e conteúdo restaurado; aprovação quando exigida |
| Upstream | Descobrir um alvo disponível e realizar uma operação autorizada conforme seu schema | Nome exportado real, argumentos válidos e resultado do serviço |
| Continuidade | Acompanhar qualquer job pendente pelo mesmo ID | Estado terminal e evidência, sem submissão duplicada |
| Cliente | Revisar a conversa e a atividade do dot | Registrar se o dot usou MCP na própria conversa ou abriu uma tarefa Work/Codex |

Marque **execução sem Work/Codex observada** somente para as etapas em que isso ocorreu no cliente. Se o host delegar, registre o comportamento e o ponto da delegação; não marque o critério como aprovado. Um teste em MCP Inspector, Work ou Codex verifica outra superfície. O objetivo é concluir as operações pela Ponte; o servidor não consegue atestar sozinho o caminho escolhido pelo dot.

## 7. Diagnóstico por camada

| Observação | Camada a conferir | Próximo passo |
|---|---|---|
| `bridge_status` ainda informa 0.6.0 ou 0.8.0 | Processo instalado, túnel e diretório de estado | Atualizar/reiniciar a instância realmente conectada |
| Cliente lista exatamente 12 ferramentas em `compact` | Perfil de exposição | Comportamento esperado; consultar o catálogo real por `bridge_list_tools` |
| Novo gateway não aparece | Metadados ou disponibilidade no host | Atualizar a conexão e conferir plugin/conta; preservar o erro observado |
| Alvo ausente no catálogo real | Runtime ou upstream | Conferir conexão, lista permitida e paginação; não inventar nome |
| `bridge_tool_schema` encontra o alvo, mas a chamada falha | Argumentos, permissão, aprovação ou serviço | Comparar `argumentsJson` com o schema e ler o erro real |
| `bridge_read` recusa uma operação | Risco do alvo | Conferir se exige `bridge_invoke` e autorização; não mascarar escrita como leitura |
| `pending_approval` | Política da Ponte | Revisar o mesmo job no painel e consultá-lo depois |
| Hash desatualizado | Arquivo alterado desde a leitura | Reler e reapresentar a edição sobre o estado atual |
| Dot propõe Work/Codex apesar de a Ponte responder | Disponibilidade e condução da tarefa no cliente | Reafirmar o fluxo desejado e registrar a ferramenta ou limitação concreta; as flags do servidor não provam acesso do dot |
| HTTP aceito, mas resultado ou continuação ausente | Execução e processamento pelo cliente | Consultar o registro autenticado; não confundir transporte com conclusão |

O [guia oficial de diagnóstico](https://developers.openai.com/plugins/deploy/troubleshooting) recomenda separar servidor, descoberta e cliente e reunir chamada, erro e comportamento observado. Descrições claras ajudam a seleção, conforme [Optimize Metadata](https://developers.openai.com/plugins/guides/optimize-metadata); elas não substituem uma ferramenta efetivamente disponível.
