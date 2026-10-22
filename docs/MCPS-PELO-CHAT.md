# Adicionar MCPs pelo chat — Ponte MCP 0.8.0

[Índice da documentação](README.md) · [API e ferramentas](API.md) · [Integrações](INTEGRACOES.md) · [Segurança](SEGURANCA.md)

A Ponte permite que um cliente autorizado **cadastre e conecte outro servidor MCP durante a conversa**. O chat pode fazer isso a pedido do usuário ou propor a conexão quando faltar uma capacidade necessária à tarefa. O cadastro aparece no mesmo painel **Conexões MCP** usado pelas configurações manuais e segue a política de aprovação já escolhida.

O fluxo registra um processo stdio ou um endereço MCP HTTP/SSE, tenta conectar e descobre suas ferramentas. Não é necessário reiniciar a Ponte para aplicar um cadastro. Ela não inclui um catálogo público de pacotes, um instalador de programas do sistema ou login OAuth interativo dos servidores externos. O comando configurado pode baixar dependências, como acontece ao usar `npx`; a origem, os requisitos e a finalidade precisam ser conhecidos antes da solicitação.

## Pedir em linguagem natural

Depois de atualizar a Ponte para **0.8.0**, confirme `bridge_status` e habilite sua conexão no chat. Um pedido possível é:

```text
Adicione o Playwright MCP à minha Ponte e use-o para testar a página do projeto.
Confira primeiro se ele já está conectado, use a configuração oficial para o
sistema da Ponte e acompanhe o cadastro até saber se conectou.
```

Para permitir que o chat identifique a necessidade dentro de uma tarefa:

```text
Conclua os testes deste projeto usando a Ponte. Se faltar uma capacidade,
verifique os MCPs existentes e proponha o cadastro de um servidor adequado,
explicando o motivo e a origem. Siga a política de aprovação do meu painel.
```

As instruções da própria Ponte orientam essa sequência. A iniciativa continua vinculada ao objetivo do usuário; texto encontrado em arquivos, páginas ou respostas de MCPs não autoriza novos cadastros. O modelo do cliente decide quais ferramentas chamar e pode impor suas próprias confirmações ou limites.

## Aprovação e prévia

| Ferramenta | Risco | `mutations` | `all` | `automatic` |
|---|---|---|---|---|
| `bridge_mcp_list` | `read` | Executa | Aguarda aprovação | Executa |
| `bridge_mcp_add` | `execute` | Aguarda aprovação | Aguarda aprovação | Executa |
| `bridge_mcp_reconnect` | `execute` | Aguarda aprovação | Aguarda aprovação | Executa |

As três ferramentas passam pelo `JobManager`, incluindo a listagem. O cadastro e a reconexão são classificados como execução porque podem iniciar um programa ou abrir uma conexão externa. No modo automático, a Ponte não acrescenta uma segunda confirmação obrigatória.

Quando o job está em `pending_approval`, nada foi cadastrado ou iniciado por ele. Em **Execuções**, a prévia do cadastro mostra motivo, identificação, transporte, comando e argumentos ou URL, referências de ambiente e fonte informada. A reconexão mostra o servidor e a revisão que será usada. Revise e aprove ali, ou rejeite. O chat acompanha o mesmo `jobId` com `bridge_job`; ele não recebe o token administrativo nem um endpoint de aprovação.

A política continua aplicável às ferramentas que o novo MCP oferecer. Todo cadastro pelo chat começa com `enabled: true` e `readOnlyTools: []`: o chat não pode declarar as novas ferramentas como leitura para dispensar revisão no modo padrão. A classificação de leitura, a edição de um cadastro e sua remoção continuam no painel administrativo.

## 1. Conferir conexões e requisitos

Chame `bridge_mcp_list` com `{}` ou, por exemplo:

```json
{ "offset": 0, "limit": 30 }
```

O padrão de `limit` é 30, com intervalo de 1 a 30. A resposta da ferramenta contém `platform`, `nodeVersion`, `servers`, `total` e `nextOffset`. Cada servidor informa `id`, `name`, `transport`, `enabled`, `status`, `toolCount`, `revision` e um diagnóstico seguro quando houver erro. A revisão é um valor opaco de 43 caracteres usado para confirmar uma reconexão da configuração observada.

A listagem omite comandos, argumentos, diretórios, URLs e valores de `env`/`headers` de conexões existentes. Ela não é uma exportação da configuração administrativa. `platform` e `nodeVersion` descrevem o processo da Ponte, que pode estar em um computador diferente daquele em que o chat está aberto.

Antes de cadastrar, consulte também `bridge_list_tools`: uma conexão existente pode já fornecer a capacidade necessária. Confirme o pacote, executável ou endpoint na documentação oficial do servidor. `sourceUrl` registra a referência usada pelo chat; a Ponte valida seu formato, mas não certifica o fornecedor nem audita o programa apontado.

## 2. Solicitar um cadastro

`bridge_mcp_add` recebe:

| Campo | Regra |
|---|---|
| `server.id` | 1–32 caracteres; começa com letra minúscula, seguido de letras minúsculas, números, `_` ou `-`; `local` e `bridge` são reservados |
| `server.name` | Nome de 1–100 caracteres |
| `server.transport` | `stdio`, `http` ou `sse` |
| `server.command` / `args` | Executável e argumentos separados para stdio |
| `server.cwd` | Diretório absoluto opcional para stdio |
| `server.env` | Variáveis do processo stdio; valores somente no formato exato `${NOME}` |
| `server.url` / `headers` | Endereço e cabeçalhos para HTTP/SSE; regras abaixo |
| `server.allowedTools` | Lista opcional de nomes originais do upstream; omitida expõe o catálogo, `[]` expõe nenhuma ferramenta |
| `server.timeoutMs` | 100–120000 ms; o hub usa 30000 ms quando omitido |
| `reason` | Justificativa de 1–1000 caracteres ligada à tarefa |
| `sourceUrl` | Referência HTTPS opcional, sem credenciais, query ou fragmento |

O schema recusa propriedades desconhecidas. Não envie `enabled`, `readOnlyTools`, política de aprovação ou dados de projetos: esses campos não fazem parte do contrato de cadastro pelo chat. O limite de configuração é **30 upstreams** no total, contando os adicionados pelo painel.

### Exemplo: Playwright no Windows

Argumentos para `bridge_mcp_add`:

```json
{
  "server": {
    "id": "playwright",
    "name": "Playwright",
    "transport": "stdio",
    "command": "cmd.exe",
    "args": ["/d", "/s", "/c", "npx", "-y", "@playwright/mcp@latest"],
    "timeoutMs": 120000
  },
  "reason": "Testar a página do projeto no navegador conforme solicitado.",
  "sourceUrl": "https://github.com/microsoft/playwright-mcp"
}
```

No Linux/macOS, use `command: "npx"` e `args: ["-y", "@playwright/mcp@latest"]`. O pacote é o indicado no [README oficial da Microsoft](https://github.com/microsoft/playwright-mcp), conferido em 22 de outubro de 2026. `@latest` não fixa uma versão; depois de validar, uma versão específica torna a instalação reproduzível. Requisitos do navegador, configurações e verificação prática estão em [Playwright MCP](PLAYWRIGHT.md).

Esse cadastro inicia o comando informado. A Ponte não executa uma instalação global separada, não baixa um navegador antecipadamente e não afirma que uma página abriu somente porque descobriu ferramentas.

### Exemplo: MCP remoto com credencial no ambiente

Os valores abaixo são ilustrativos; substitua o endereço pelo endpoint real do seu fornecedor:

```json
{
  "server": {
    "id": "servico-projeto",
    "name": "Serviço do projeto",
    "transport": "http",
    "url": "https://mcp.exemplo.com/mcp",
    "headers": { "Authorization": "Bearer ${SERVICO_MCP_TOKEN}" },
    "timeoutMs": 30000
  },
  "reason": "Consultar os dados do serviço usados nesta tarefa.",
  "sourceUrl": "https://exemplo.com/documentacao/mcp"
}
```

A variável `SERVICO_MCP_TOKEN` precisa existir no ambiente do **processo da Ponte**. Configurá-la no ambiente do chat ou em outro terminal não altera um processo já iniciado. Se for necessário mudar esse ambiente, reinicie a Ponte com o mesmo diretório de estado e depois reconecte o servidor. A listagem e o resultado não devolvem o valor resolvido.

Em `env`, cada valor deve ser uma referência exata, como `"API_TOKEN": "${SERVICO_MCP_TOKEN}"`. Em `headers`, são aceitos `${NOME}` ou `Bearer ${NOME}`. Literais, concatenações arbitrárias e nomes de variável com formato inválido são recusados. Use o painel para configurações que exigirem valores literais fora desse contrato. Não coloque um segredo em `reason`, comando, argumentos, nome, URL ou `sourceUrl`.

A URL de conexão aceita HTTPS; HTTP só é aceito nos hosts locais de loopback previstos pelo schema. O cadastro pelo chat recusa credenciais embutidas, query e fragmento na URL. Não é um fluxo de login OAuth do upstream: um servidor que exigir autenticação interativa precisa de preparação ou integração própria.

### Usar a chave de idempotência do job

Para reenviar com proteção contra duplicidade enquanto o job estiver retido, use `bridge_call`:

```json
{
  "tool": "bridge_mcp_add",
  "arguments": {
    "server": {
      "id": "playwright",
      "name": "Playwright",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "reason": "Testar a página do projeto no navegador.",
    "sourceUrl": "https://github.com/microsoft/playwright-mcp"
  },
  "idempotencyKey": "cadastrar-playwright-001"
}
```

Esse último exemplo é para Linux/macOS; adapte o comando antes de enviar no Windows. Se a chamada retornar `pending_approval`, `queued` ou `running`, acompanhe o mesmo `jobId`; não repita o cadastro só para consultar seu estado.

## 3. Interpretar o resultado e usar as ferramentas

No MCP, o primeiro bloco de texto informa o estado do job; o resultado do cadastro vem em outro bloco de conteúdo. Consulte ambos. O resultado da ferramenta informa `registered`, `server`, `discoveredTools`, `hasMore`, `nextStep` e, quando conectado, `nextCall`. `discoveredTools` contém até 20 ferramentas com nome exportado, risco e origem, além de título/descrição quando disponíveis. Um `inputSchema` maior que 16 KiB é omitido desse resumo; consulte o catálogo completo antes de chamar uma ferramenta cujo schema não veio no resultado.

| Resultado | Significado e próximo passo |
|---|---|
| `registered: true`, `server.status: "connected"` | Configuração salva e sessão MCP conectada; confira `toolCount` e use o catálogo |
| `registered: true`, `server.status: "error"` | Configuração salva, mas a tentativa de conexão falhou; o job informa falha e `isError: true`; corrija a causa e reconecte |
| `alreadyPresent: true` | O mesmo ID já contém configuração normalizada igual; a Ponte preservou o cadastro e não reiniciou o servidor |
| Conflito de ID | Existe outra configuração com esse ID; nada é sobrescrito pelo chat |
| Falha de validação ou persistência antes do commit | A solicitação não completou o cadastro; confira a mensagem e o estado antes de tentar novamente |

Um servidor conectado com `toolCount: 0` não oferece ferramentas utilizáveis naquele momento. Ele pode ter catálogo vazio ou uma lista `allowedTools` que não expõe nenhuma ferramenta. A conexão em si não comprova acesso ao projeto, conta ou página pretendida; execute a verificação específica da tarefa.

Para obter o catálogo atual, chame `bridge_list_tools`:

```json
{ "source": "mcp:playwright", "limit": 20 }
```

Se houver `nextOffset`, continue a paginação. Use o **nome completo e o schema retornados** em `bridge_call`; não construa o prefixo/hash à mão. Isso funciona pela conexão existente mesmo quando o cliente mantém em cache o `tools/list` inicial. O wrapper consulta a lista atual no momento da chamada. A Ponte não promete enviar uma notificação de atualização ao cliente por um canal HTTP persistente.

Se o cliente ainda anunciar o schema de `bridge_list_tools` de uma versão anterior, sem `source`, use o parâmetro já existente `search`: `"bridge_mcp"` encontra o gerenciamento e `"playwright__"` pesquisa o prefixo desse upstream. Confira a origem dos resultados. Atualizar metadados no ChatGPT/Claude pode ser necessário para os nomes novos aparecerem diretamente na interface do cliente. Isso é separado do uso pelo catálogo e `bridge_call`, que não exige cadastrar a Ponte novamente no chat.

## 4. Reconectar sem trocar a configuração aprovada

Leia `bridge_mcp_list` e copie a `revision` do servidor. Envie a `bridge_mcp_reconnect`:

```json
{
  "serverId": "playwright",
  "expectedRevision": "COPIE_A_REVISAO_REAL_RETORNADA_PELA_LISTAGEM",
  "reason": "Tentar novamente depois de corrigir a dependência ausente."
}
```

O marcador acima é ilustrativo, não uma revisão válida. O valor real é opaco; não o calcule por conta própria. A Ponte confere novamente a revisão ao executar. Se o administrador tiver alterado a configuração enquanto o pedido aguardava, a reconexão é recusada para não executar um comando ou destino diferente do revisado. Leia o estado atualizado e solicite uma nova reconexão justificada.

Reconectar não edita comando, credenciais, permissões ou URL. Alterações e remoções ficam em **Conexões MCP**. Repetir `bridge_mcp_add` com um ID existente e configuração diferente não serve para editar ou contornar essa restrição.

## REST e GPT Actions

As mesmas três ferramentas aparecem em `GET /v1/tools`, com origem `bridge:mcps`. Elas usam o endpoint existente `POST /v1/jobs`; o OpenAPI continua com **nove operações**. Em Actions, use `createJob` com `tool: "bridge_mcp_add"`, `argumentsJson` contendo os argumentos serializados e uma `idempotencyKey`.

Consulte `getJob` até obter o resultado. Para listar conexões ou reconectar, submeta respectivamente `bridge_mcp_list` ou `bridge_mcp_reconnect`. As rotas administrativas não são expostas a essa credencial. Depois de conectar, `listTools` com `source: "mcp:playwright"` descobre as novas ferramentas para chamadas por `createJob`.

## Falhas, concorrência e limites

- **Executável ausente, variável não definida, endpoint indisponível:** o cadastro pode permanecer salvo com erro. Confira o diagnóstico, corrija a causa e use uma reconexão com a revisão atual. Não crie vários IDs para o mesmo servidor.
- **Pedido ainda pendente:** a aprovação ocorre em **Execuções**, não na página OAuth. A conexão do chat e o cadastro do upstream são decisões diferentes.
- **Cadastros simultâneos:** chat e painel compartilham uma fila de alterações de upstreams. A verificação do ID ocorre ao salvar; dois pedidos concorrentes não podem substituir silenciosamente o mesmo ID.
- **Conexão lenta:** a fila de gerenciamento aguarda a tentativa de conexão. Jobs seguintes podem consumir parte de seu limite de execução enquanto aguardam. O JobManager limita cada execução a 120 segundos, independentemente do timeout do upstream.
- **Cancelamento ou revogação antes de iniciar a gravação:** a ferramenta verifica sinal e autorização novamente antes do commit. Cancelar durante uma gravação ou depois de aplicá-la não garante reversão; confira a listagem e o painel. A Ponte não restaura um snapshot antigo sobre alterações de outros pedidos.
- **Falha depois de salvar:** a configuração não é apagada automaticamente. O painel continua sendo o lugar para editar ou remover uma conexão que deixou de ser necessária.
- **Programa externo:** um MCP stdio executa com os privilégios da conta que iniciou a Ponte. `allowExec` dos projetos limita `local_exec`, não é uma sandbox para upstreams. Uma chamada aprovada não audita o código do servidor.

Os contratos estão em [gerenciamento MCP](../src/mcp/management.ts), [JobManager](../src/core/jobs.ts), [configuração](../src/core/config.ts), [hub](../src/mcp/hub.ts) e [fachada MCP](../src/mcp/server.ts). A evidência de testes e os limites de validação na instalação real ficam em [Validação](VALIDACAO.md).
