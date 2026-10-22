# Ponte MCP

**Ferramentas do seu computador e dos seus servidores MCP em uma única conexão para o chat.**

A Ponte é um serviço local com painel em português. Ela permite que clientes compatíveis, como ChatGPT e Claude, trabalhem em projetos autorizados, executem comandos e usem ferramentas de outros servidores MCP, incluindo Roblox Studio e Playwright. Cada solicitação segue as permissões e a política de aprovação definidas no painel.

**Versão atual: 0.7.0.** O chat agora pode **cadastrar e reconectar servidores MCP pelo próprio catálogo da Ponte**, a pedido do usuário ou quando identificar uma capacidade necessária à tarefa. A solicitação mostra uma prévia e segue a política do painel, inclusive aprovação automática. Os watchers nativos continuam disponíveis para acompanhar a conclusão real de tarefas.

[Documentação completa](docs/README.md) · [Instalar e atualizar](docs/OPERACAO.md) · [ChatGPT](docs/CHATGPT.md) · [Claude](docs/CLAUDE.md) · [MCPs pelo chat](docs/MCPS-PELO-CHAT.md) · [Watchers](docs/WATCHERS.md) · [Histórico de versões](CHANGELOG.md)

## Recursos

| Área | O que a Ponte oferece |
|---|---|
| Projetos e arquivos | Pastas autorizadas, leitura UTF-8, busca literal, criação de diretórios, gravação e edição com hash e backup |
| Comandos | Executável e argumentos separados, limites de tempo e saída, cancelamento e permissão por projeto |
| Aprovação | Revisar alterações e comandos, revisar todas as execuções ou aprovar automaticamente |
| Agregação MCP | Clientes stdio, Streamable HTTP e SSE legado; descoberta de schemas e namespace |
| MCPs pelo chat | Listar conexões, cadastrar e reconectar com justificativa, revisão e uso imediato pelo catálogo dinâmico |
| Chats | MCP HTTP com OAuth, MCP local por stdio e API REST com OpenAPI para GPT Actions |
| Watchers | Criar, consultar, listar, aguardar e cancelar; gatilhos `signal` e `job`; estado e resultados persistidos |
| MCP Events | Evento `ponte.job.completed` por trabalho, com inscrição e callback fornecidos por um cliente compatível |
| Painel | Projetos, conexões, ferramentas, execuções, acompanhamentos, autorização OAuth e diagnóstico de Events |

A Ponte não inclui um modelo de IA e não remove cotas do chat ou dos serviços conectados. O cliente precisa oferecer integração de ferramentas; apenas colar uma URL em uma conversa não dá acesso ao computador. O projeto foi feito para uso pessoal em um computador, com um único administrador.

## Começar no Windows

Instale **Node.js 22.12 ou superior** pelo [site oficial](https://nodejs.org/). Para usar Git, clone o repositório:

```powershell
git clone https://github.com/V1yn1/ponte-mcp.git
cd ponte-mcp
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd run setup
npm.cmd start
```

Se baixou um ZIP pelo GitHub, extraia-o, abra o PowerShell na pasta que contém `package.json` e execute a partir de `npm.cmd ci --ignore-scripts`.

Mantenha o terminal aberto. Acesse [http://127.0.0.1:4317](http://127.0.0.1:4317) e, em outro terminal na mesma pasta, obtenha a credencial do painel:

```powershell
node dist/cli.js token admin
```

Cole a credencial somente no login do painel local. O `setup` cria um projeto de demonstração em `workspace`. Adicione sua pasta real em **Projetos**; a execução de comandos precisa ser habilitada explicitamente para cada projeto.

No macOS/Linux, use `npm` no lugar de `npm.cmd`. O preset do Roblox requer Windows ou macOS. Instalação com pasta própria, scripts auxiliares, portas e diagnóstico estão em [Operação](docs/OPERACAO.md).

## Escolher a conexão com o chat

| Cliente | Caminho | Guia |
|---|---|---|
| ChatGPT com plugin/conector MCP | API pública HTTPS em `/mcp`, OAuth e autorização no painel local | [ChatGPT](docs/CHATGPT.md) |
| Claude com conector remoto | API pública HTTPS em `/mcp`, OAuth e autorização local | [Claude](docs/CLAUDE.md) |
| Claude Desktop ou outro cliente stdio | Processo local `node dist/cli.js stdio`; serviço da Ponte já iniciado | [Claude](docs/CLAUDE.md) |
| Claude Code | MCP HTTP ou stdio, conforme o ambiente | [Claude](docs/CLAUDE.md) |
| GPT personalizado com Actions | OpenAPI da Ponte e autenticação Bearer com token API | [Integrações](docs/INTEGRACOES.md) |

Para conexões remotas, encaminhe **toda a API da porta 4318** por HTTPS e salve somente a origem em **Conectar IA → URL pública da API**, por exemplo `https://sua-ponte.exemplo.com`. A URL do servidor MCP será `https://sua-ponte.exemplo.com/mcp`. Mantenha o painel da porta **4317** local. O túnel precisa atender também descoberta, OAuth e callbacks de watchers; publicar apenas `/mcp` é insuficiente.

O token `admin` autentica o painel; o token `api` atende REST/Actions e o adaptador stdio; clientes OAuth recebem suas próprias credenciais. O token exclusivo de um callback de watcher tem outra finalidade. Veja os contratos em [API e ferramentas](docs/API.md).

Após conectar, peça ao chat para consultar `bridge_status` e `local_projects`. A aprovação OAuth confirma a autorização; uma chamada de leitura confirma o uso efetivo das ferramentas.

## Acompanhar uma tarefa externa

Para um fluxo como “enviar uma demanda ao Claude e aguardar a conclusão”, configure um watcher **antes de delegar**:

1. Chame `bridge_watch_create` com `trigger.type: "signal"`, `source` e um `runId` único. Se a criação exigir aprovação, acompanhe seu `jobId` até obter o resultado.
2. Configure o executor com a URL e a credencial exclusivas retornadas em `callback`. O executor deve informar `succeeded`, `failed` ou `needs_input` quando tiver verificado o resultado real.
3. Delegue a demanda uma única vez e chame `bridge_watch_wait` com o `watcherId` criado.
4. Se retornar `waiting`, continue a espera pelo mesmo ID durante o turno ativo, dentro dos limites do cliente. Depois de reconectar, use `bridge_watch_get` ou `bridge_watch_list`.

Exemplo de argumentos para criar o acompanhamento:

```json
{
  "name": "Aguardar tarefa delegada ao Claude",
  "trigger": {
    "type": "signal",
    "source": "claude-code",
    "runId": "demanda-2026-10-22-001"
  },
  "timeoutMs": 3600000,
  "idempotencyKey": "watch-demanda-2026-10-22-001"
}
```

O produtor [ponte-watch-notify.mjs](scripts/ponte-watch-notify.mjs) envia o resultado a partir do executor. O guia [Watchers](docs/WATCHERS.md) explica o preparo das credenciais, as chamadas, os estados finais, as tentativas de entrega e um fluxo com Claude remoto.

| Mecanismo | O que acompanha | Limite da continuidade |
|---|---|---|
| `bridge_job` | Uma execução da Ponte | Espera de até 25 s por chamada, durante o turno ativo |
| Watcher `signal` | O resultado explícito informado por um executor externo | Persiste após desconexão/reinício; `bridge_watch_wait` aceita até 300 s se o cliente permitir |
| Watcher `job` | O estado final de uma execução da Ponte | Não atribui ao trabalho um significado maior que a própria execução |
| MCP Events | A conclusão de um trabalho com inscrição ativa do cliente | Pode avisar um cliente compatível por webhook; depende da inscrição e do suporte do cliente |

**Watchers pertencem à Ponte e não usam o agendador do ChatGPT ou Claude.** Eles não abrem um novo turno em uma conversa encerrada. O fim de `tmux send-keys`, do comando que enviou a demanda ou de uma resposta do Claude não comprova a conclusão da tarefa. Cancelar o watcher encerra somente o acompanhamento, sem interromper o executor.

MCP Events é uma integração separada e opcional. Ela usa `events/subscribe`, um método do protocolo, com callback e segredo fornecidos pelo cliente. Um watcher não cria essa inscrição. Veja [MCP Events](docs/MCP-EVENTS.md).

## Política de aprovação

Em **Visão geral → Você no controle → Política de aprovação**, escolha:

| Opção | Valor | Comportamento dos trabalhos |
|---|---|---|
| Aprovar alterações e comandos | `mutations` | Padrão; leitura pode executar, escrita e execução aguardam revisão |
| Aprovar todas as solicitações | `all` | Todos os trabalhos, inclusive leituras, aguardam revisão |
| Aprovar automaticamente todas | `automatic` | Libera trabalhos pendentes válidos e os futuros, preservando as permissões e validações |

A política inclui ferramentas locais, ferramentas upstream, `bridge_watch_create` e as três ferramentas `bridge_mcp_*`. `bridge_mcp_list` é uma leitura submetida à fila; cadastro e reconexão são execuções. Consultas de estado/catálogo, acompanhamento de trabalhos e os controles `bridge_watch_get/list/wait/cancel` não criam trabalhos e não passam por essa fila de aprovação. A criação de uma conexão OAuth continua exigindo autorização local.

A pausa impede novas submissões e o início de trabalhos na fila. Ela não interrompe automaticamente o que já está executando nem apaga watchers. Consulte [Segurança](docs/SEGURANCA.md) para o alcance das permissões.

## Primeiro teste pelo painel

Em **Ferramentas**, selecione `local_write_file` e envie:

```json
{
  "projectId": "principal",
  "path": "teste-ponte.txt",
  "content": "Arquivo criado pela Ponte MCP.\n",
  "expectedHash": null
}
```

Na política padrão, confira o diff em **Execuções** e aprove. Depois de `succeeded`, leia o arquivo com `local_read_file`. `expectedHash: null` cria somente um arquivo inexistente. Para editar um arquivo existente, use o `sha256` retornado pela leitura; se o conteúdo tiver mudado, a Ponte recusa a gravação.

## Conectar outros MCPs

Você pode cadastrar pelo painel **Conexões MCP** ou pedir ao chat:

```text
Adicione o Playwright MCP à minha Ponte para testar a página deste projeto.
Confira o sistema, se já existe uma conexão e a configuração oficial.
```

O chat usa `bridge_mcp_list`, solicita `bridge_mcp_add` com configuração e motivo, acompanha o job e confirma o estado real da conexão. Se o modo for `mutations` ou `all`, revise em **Execuções**; em `automatic`, a solicitação válida executa sem nova aprovação local. O cadastro fica no painel e não substitui uma conexão existente com configuração diferente.

Depois de conectar, `bridge_list_tools` com `source: "mcp:playwright"` devolve os nomes e schemas atuais. O chat usa `bridge_call` para chamar essas ferramentas na mesma conversa, mesmo quando o cliente mantém o catálogo inicial em cache. Uma falha pode deixar o cadastro salvo com estado de erro; `bridge_mcp_reconnect` permite tentar novamente após corrigir a causa. O contrato completo está em [MCPs pelo chat](docs/MCPS-PELO-CHAT.md).

- [Roblox Studio](docs/ROBLOX.md): habilitar o servidor integrado, adicionar o preset e selecionar a sessão correta.
- [Playwright MCP](docs/PLAYWRIGHT.md): cadastrar pelo chat ou pelo painel, configurar o processo local e testar a conexão.
- [Outros upstreams](docs/INTEGRACOES.md): stdio, HTTP e SSE legado, variáveis de ambiente, filtros e tempos limite.

Processos MCP e comandos executam com os privilégios da conta local. As permissões das ferramentas de arquivos da Ponte não transformam esses processos em sandboxes do sistema operacional.

## Atualizar a instalação

Encerre com `Ctrl+C`, faça uma cópia privada do diretório de estado e, na instalação clonada pelo Git, execute:

```powershell
git pull --ff-only
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd start
```

Preserve a pasta `.ponte` inteira, incluindo `secrets.json`, `oauth.json`, `events.json`, `watchers.json` e backups. O watcher usa a chave da instalação; apagar ou recriar as credenciais isoladamente pode impedir a leitura do estado existente. Não execute duas instâncias sobre o mesmo diretório.

Confira **0.7.0** com `bridge_status` ou `doctor` e atualize o catálogo no cliente para encontrar `bridge_mcp_list`, `bridge_mcp_add` e `bridge_mcp_reconnect`, além das cinco ferramentas `bridge_watch_*`. Se o cliente ainda mantiver o catálogo anterior, pesquise `search: "bridge_mcp"` em `bridge_list_tools` e chame o nome retornado por `bridge_call`. Na listagem atual, `source: "bridge:mcps"` também seleciona essas ferramentas. Para instalações por ZIP, diretório personalizado, mudança de túnel e recuperação, siga [Operação](docs/OPERACAO.md).

## Desenvolvimento e evidência

```sh
npm ci --ignore-scripts
npm run verify
npm run smoke
npm run dev
```

`verify` confere tipos, executa testes e compila. `smoke` usa o programa compilado, estado temporário e listeners locais para verificar OAuth, MCP, aprovação, cadastro de upstream pelo chat, catálogo dinâmico, Events e watcher com sinal autenticado.

A evidência de cada versão está em [Validação](docs/VALIDACAO.md), separando testes controlados, observações em clientes reais e limites de cada etapa. Esses testes não validam todos os clientes e sistemas operacionais: cadastro de upstream, dependências externas e watchers precisam ser conferidos com o cliente e o executor da instalação.

| Diretório | Responsabilidade |
|---|---|
| `src/core/`, `src/tools/` | Configuração, auditoria, trabalhos e ferramentas locais |
| `src/auth/`, `src/mcp/` | OAuth, fachada MCP e clientes upstream |
| `src/watchers/`, `src/events/` | Acompanhamentos nativos e entrega de eventos ao cliente |
| `public/` | Painel e consentimento OAuth |
| `tests/`, `scripts/` | Testes, smoke, instalação e produtor de sinais |
| `examples/`, `docs/` | Configurações, instruções e guias |

## Escopo atual

O proxy agrega **ferramentas** MCP. Não encaminha resources, prompts, sampling, elicitation ou login OAuth interativo de upstreams. A reconexão de upstreams é solicitada pelo painel ou pelo chat; não há um ciclo automático de tentativas em segundo plano. Não há controle genérico de desktop, serviço Windows instalado ou processo autônomo de planejamento.

Projetos e políticas são compartilhados pelo administrador. A posse de trabalhos, watchers e assinaturas é verificada por identidade de conexão, mas isso não cria isolamento completo entre usuários. Os limites, estados persistidos e fronteiras de confiança estão em [Arquitetura](docs/ARQUITETURA.md) e [Segurança](docs/SEGURANCA.md).
