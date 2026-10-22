# Ponte MCP

**Dê ao seu chat ferramentas para trabalhar nos seus projetos e no Roblox Studio, por uma única ponte local.**

Ponte MCP é um servidor local com painel em português. Ele reúne ferramentas de arquivos, execução de comandos e servidores MCP externos. O chat escolhe uma ferramenta; a ponte valida a solicitação, apresenta alterações para revisão quando necessário e devolve o resultado.

A versão **0.6.0** acrescenta **acompanhamentos duráveis** de tarefas externas e execuções da Ponte, com sinal explícito do executor, consulta, espera e cancelamento. O painel inclui a seção **Acompanhamentos** e distingue monitores ativos de chamadas MCP em espera. O acompanhamento continua após a chamada e após reiniciar a Ponte; a retomada do chat depende do cliente. Permanecem as conexões com **ChatGPT, Claude, Claude Desktop e Claude Code**, OAuth com autorização local, aprovação automática opcional e painel azul cobalto/grafite. O projeto é destinado a uso pessoal em um computador e inclui código TypeScript, painel, testes e exemplos de integração. Não contém modelo de IA, assinatura comercial, chave de fornecedor ou instalador proprietário.

## O que está implementado

| Área | Recursos |
|---|---|
| Projetos | Cadastro de pastas, permissão de escrita e ativação explícita de comandos por projeto |
| Arquivos | Listagem, leitura UTF-8, busca literal, criação de pastas, gravação completa e substituição de trecho exato |
| Aprovação | Três políticas: revisar alterações e comandos, revisar todas ou aprovar automaticamente; diff, SHA-256 esperado e backup de arquivos |
| Terminal | Executável e argumentos separados, diretório do projeto, limite de tempo e saída, cancelamento |
| MCPs | Clientes stdio, Streamable HTTP e SSE legado; descoberta de ferramentas, namespaces e reconexão |
| Roblox | Preset do servidor MCP integrado oficialmente ao Studio |
| Conexão com chats | ChatGPT e Claude por MCP Streamable HTTP com OAuth; Claude Desktop/Code por stdio; API REST com OpenAPI para Actions |
| Resultados MCP | Espera de até 25 segundos na chamada e consulta do mesmo trabalho com `bridge_job` e `waitMs` |
| Acompanhamentos | `bridge_watch_create`, `bridge_watch_get`, `bridge_watch_list`, `bridge_watch_wait` e `bridge_watch_cancel`; gatilhos `signal` e `job`, persistência e resultado explícito |
| MCP Events | Evento `ponte.job.completed` por `jobId`, assinatura pelo cliente, callback HTTPS verificado e assinado, entrega persistente e diagnóstico no painel |
| OAuth | Authorization code com PKCE S256, descoberta, cadastro dinâmico de clientes, renovação e revogação |
| Painel | Visão geral, projetos, conexões, ferramentas, execuções, acompanhamentos, abas ChatGPT/Claude, aprovação OAuth e diagnóstico de avisos de conclusão |
| Operação | Tokens distintos de administração e API, autorizações OAuth persistentes, pausa de novas execuções, idempotência, auditoria de metadados |

## O que a ponte resolve — e seus limites

O benefício é reunir as ferramentas do computador e dos MCPs atrás de uma interface reutilizável. Assim, um chat que ofereça integração de ferramentas pode solicitar essas ações sem você copiar manualmente todo o código entre as janelas.

**Ela não remove cotas do modelo, do plano, do chat, do Roblox ou dos serviços conectados.** O chat precisa oferecer MCP, Actions ou uma API de ferramentas. Colar uma URL em uma conversa sem esse suporte não concede acesso ao computador. Uma conversa também não se torna um agente autônomo de longa duração apenas por ter acesso a ferramentas; planejamento, quantidade de chamadas e continuidade continuam dependendo do cliente e do modelo.

## Instalação no Windows

Requisito: **Node.js 22.12 ou superior**. Recomenda-se uma versão LTS ainda suportada. Instale pelo [site oficial do Node.js](https://nodejs.org/).

1. Extraia o ZIP para uma pasta, por exemplo `C:\Projetos\ponte-mcp`.
2. Abra o PowerShell nessa pasta e execute:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd run setup
npm.cmd start
```

3. Mantenha o terminal aberto e entre em **http://127.0.0.1:4317**.
4. Em outro terminal, na mesma pasta, obtenha o token do painel:

```powershell
node dist/cli.js token admin
```

5. Cole esse token no campo de login do painel. Em **Projetos**, adicione a pasta do seu projeto real.

O primeiro `setup` cria um projeto de demonstração na pasta `workspace`. Para cadastrar sua pasta principal já na primeira configuração:

```powershell
node dist/cli.js init --workspace "C:\Projetos\MeuJogo"
```

O comando `init` preserva uma configuração existente; para mudar as pastas depois, use o painel. Há também `scripts/install.ps1` para quem já executa scripts PowerShell localmente e `scripts/start.cmd` para iniciar após a instalação.

No macOS/Linux, os mesmos comandos funcionam com `npm` no lugar de `npm.cmd`. O Roblox Studio deve rodar em uma plataforma oficialmente suportada por ele.

## Atualizar uma instalação existente

Se instalou pelo GitHub, encerre a Ponte com `Ctrl+C` e execute na mesma pasta:

```powershell
git pull --ff-only
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd start
```

Confira **0.6.0** no painel. Preserve a pasta `.ponte`: a política de aprovação, os projetos, as autorizações OAuth já concluídas e os acompanhamentos persistidos continuam disponíveis após reiniciar. Uma conexão que já funciona não precisa ser recriada. Somente pedidos OAuth ainda em andamento precisam ser iniciados novamente após o reinício.

No ChatGPT, abra **Plugins → Ponte → Atualizar ferramentas** e confirme as cinco ferramentas `bridge_watch_*`. Para o acompanhamento nativo, use `bridge_watch_create` e `bridge_watch_wait`; não crie uma automação no ChatGPT. Mantenha o ngrok encaminhando toda a API da porta **4318**, inclusive `/hooks/watchers/.../signal`, e confira se a URL pública salva corresponde à origem atual do túnel. O roteiro está em [Conectar ao ChatGPT](docs/CHATGPT.md) e [Watchers](docs/WATCHERS.md). Quem já usa o fluxo separado de MCP Events pode atualizar também sua descoberta de eventos.

### Instalações por ZIP e atualização da versão 0.1.0

Encerre a ponte antiga com `Ctrl+C` e faça uma cópia privada do diretório de estado antes de substituir os arquivos do programa. Preserve a pasta `.ponte`: ela contém os projetos cadastrados, credenciais e backups. Na mesma pasta de instalação, execute novamente `npm.cmd ci --ignore-scripts` e `npm.cmd run build`, depois inicie o serviço.

Se extrair a nova versão em outra pasta, aponte explicitamente para o estado antigo:

```powershell
node dist/cli.js start --state-dir "C:\Projetos\ponte-mcp-antiga\.ponte"
```

Use esse mesmo `--state-dir` nos comandos `token`, `doctor` e na configuração stdio. Por padrão, o estado fica em `.ponte` **dentro da pasta da instalação**, independentemente da pasta atual do terminal. `PONTE_STATE_DIR` também pode definir o caminho; `--state-dir` tem precedência. Não inicie duas versões usando o mesmo estado.

Os clientes stdio, Actions e MCP com token API continuam funcionando. O fluxo nativo de OAuth do ChatGPT cria suas próprias autorizações; não exige substituir os tokens existentes. Veja o passo a passo em [Conectar ao ChatGPT](docs/CHATGPT.md).

## Escolher a política de aprovação

No painel, abra **Visão geral → Você no controle → Política de aprovação**. A seleção é salva imediatamente e permanece após reiniciar a Ponte.

| Opção no painel | `approvalMode` | Comportamento |
|---|---|---|
| Aprovar alterações e comandos | `mutations` | Padrão: leituras podem executar diretamente; alterações e comandos aguardam revisão |
| Aprovar todas as solicitações | `all` | Todas as chamadas de ferramentas aguardam revisão manual, inclusive leituras |
| Aprovar automaticamente todas | `automatic` | Libera as solicitações pendentes válidas e as futuras chamadas de ferramentas locais e MCP |

O modo automático vale para **todos os clientes autorizados** e para as chamadas pelo próprio painel. O aviso **Aprovação automática ativa** identifica a política em uso. A política preserva as permissões de escrita e execução dos projetos, as listas de ferramentas permitidas, a validação de argumentos, `expectedHash` e os backups. Novas conexões OAuth continuam exigindo aprovação no painel local.

A pausa bloqueia novas solicitações e a partida da fila, inclusive no modo automático. Ao sair desse modo, trabalhos aprovados automaticamente que ainda estão na fila voltam à revisão quando a nova política exigir; trabalhos já em execução continuam. `bridge_status` informa `approvalMode`, e os detalhes e a auditoria dos trabalhos identificam aprovações `manual` ou `automatic` quando aplicável.

## Primeiro teste, sem depender de IA

No painel, abra **Ferramentas** e procure `local_write_file`. Envie:

```json
{
  "projectId": "principal",
  "path": "teste-ponte.txt",
  "content": "Arquivo criado pela Ponte MCP.\n",
  "expectedHash": null
}
```

Na política padrão, abra a solicitação em **Execuções**, confira o diff e aprove. No modo automático, acompanhe diretamente o resultado. Após a conclusão, o arquivo aparecerá na pasta do projeto. Use `local_read_file` com o mesmo `projectId` e `path` para conferir.

`expectedHash: null` significa **criar somente se ainda não existir**. Para alterar um arquivo existente, leia-o primeiro e envie o `sha256` retornado como `expectedHash`. A ponte recusa a alteração se o conteúdo tiver mudado. Arquivos suportados: texto UTF-8, até 1 MiB; para solicitações via HTTP, o JSON completo também precisa caber no limite de 1 MiB.

## Conectar o Roblox Studio

1. Atualize o Studio e abra o seu jogo.
2. No Studio: **Assistant → … → Manage MCP Servers → Enable Studio as MCP server**.
3. Na ponte: **Conexões MCP → Preset Roblox** para adicionar a conexão.
4. Aguarde o estado conectado. Se necessário, pressione reconectar.
5. Em **Ferramentas**, filtre pela origem `mcp:roblox`.

No Windows, o preset usa o ponto de entrada oficial:

```json
{
  "id": "roblox",
  "name": "Roblox Studio",
  "transport": "stdio",
  "enabled": true,
  "command": "cmd.exe",
  "args": ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
  "readOnlyTools": [],
  "timeoutMs": 120000
}
```

Os nomes e schemas são descobertos no Studio instalado; a ponte não mantém uma cópia fixa das ferramentas. Elas aparecem com um prefixo e hash para evitar colisões. Ferramentas como edição de scripts e execução Luau são encaminhadas ao Studio. **A integração não foi executada em um Studio real neste ambiente de entrega**; veja o roteiro de validação em `docs/ROBLOX.md`.

## Conectar um chat

### Cliente com MCP local por stdio

Inicie a ponte e copie a configuração stdio da aba **Conectar IA**, em **Clientes locais e GPT Actions**. Um exemplo, adaptando os caminhos:

```json
{
  "mcpServers": {
    "ponte": {
      "command": "node",
      "args": [
        "C:\\Projetos\\ponte-mcp\\dist\\cli.js",
        "stdio",
        "--state-dir",
        "C:\\Projetos\\ponte-mcp\\.ponte"
      ]
    }
  }
}
```

O adaptador stdio lê a credencial local e encaminha para o serviço já iniciado. Ele não abre outro painel e não duplica os servidores conectados.

### ChatGPT com MCP

O caminho HTTP da versão 0.6.0 usa **OAuth com cadastro dinâmico de cliente (DCR)**. Você autoriza a conexão no seu computador; o ChatGPT recebe credenciais OAuth próprias e renováveis.

1. Inicie a ponte e encaminhe **toda a API da porta 4318** por uma origem HTTPS estável. O encaminhamento precisa atender `/mcp` e os endpoints de descoberta e OAuth. Mantenha a porta 4317 exclusivamente local.
2. Em **Conectar IA**, salve a origem HTTPS em **URL pública da API**, por exemplo `https://sua-ponte.exemplo.com`, sem `/mcp`.
3. No ChatGPT, abra **Plugins → + → Add custom MCP server**. Informe `https://sua-ponte.exemplo.com/mcp`, escolha **OAuth** e deixe as credenciais de cliente vazias. Se houver escolha de registro, selecione **DCR**.
4. Quando o fluxo de autorização abrir a página da Ponte, confira o código de verificação de oito caracteres. No painel local, abra **Conectar IA**, encontre o mesmo código, revise a solicitação e autorize.
5. Volte à página de autorização. Ela retorna automaticamente ao ChatGPT após a aprovação. Conclua **Create as a plugin**, instale o plugin e selecione-o com `@` em uma conversa.
6. Peça: `Use a Ponte para consultar bridge_status e listar os projetos disponíveis.`

O token de administração fica no painel local. Depois de autorizar a conexão, as chamadas seguem a política de aprovação escolhida, inclusive `automatic`. As permissões dos projetos e das ferramentas continuam valendo.

O roteiro completo, testes de descoberta e solução de problemas estão em [docs/CHATGPT.md](docs/CHATGPT.md). Chamadas reais de ferramentas do plugin foram confirmadas nesta instalação; a retomada por Events ainda não foi concluída. A disponibilidade de MCP e as permissões para adicionar plugins dependem da conta e do workspace. A documentação oficial também prevê Secure MCP Tunnel; veja [outras opções de conexão](docs/INTEGRACOES.md).

### Claude, Claude Desktop e Claude Code

Abra **Conectar IA → Claude** no painel. Para o conector remoto, use a mesma URL HTTPS `/mcp` e escolha OAuth com registro automático/DCR. Autorize o código exibido pela Ponte no painel local. O modo local do Claude Desktop usa o JSON `mcpServers` gerado com os caminhos reais da instalação e dispensa túnel.

Para Claude Code, o painel gera o comando HTTP:

```sh
claude mcp add --transport http ponte https://sua-ponte.exemplo.com/mcp
claude mcp login ponte
```

O guia [Conectar ao Claude](docs/CLAUDE.md) inclui configuração local, callbacks, aprovação e diagnóstico. Os fluxos OAuth foram exercitados com clientes de teste; a conexão em uma conta real do Claude precisa ser conferida depois da configuração.

### Acompanhar a conclusão real de uma tarefa

Crie o acompanhamento **antes de delegar**: chame `bridge_watch_create` com nome, prazo e um dos dois gatilhos. A criação segue a política de aprovação da Ponte. Com `signal`, informe `source` e um `runId` exclusivo; configure o executor com o callback retornado, incluindo sua URL e token exclusivo. O executor envia `succeeded`, `failed` ou `needs_input`, com um resumo explícito, quando souber o resultado real. O produtor [scripts/ponte-watch-notify.mjs](scripts/ponte-watch-notify.mjs) usa `PONTE_WATCH_URL`, `PONTE_WATCH_TOKEN` e `PONTE_WATCH_RUN_ID` para enviar esse sinal. Não exponha o token no chat ou em registros.

Com `job`, informe o `jobId` de uma execução da Ponte. Esse gatilho observa o estado final daquela execução. O fim de um comando que apenas envia uma demanda ao Claude, por exemplo, não comprova a conclusão do trabalho delegado.

Depois de delegar, use `bridge_watch_wait` com o mesmo `watcherId`. A espera padrão é **25 segundos**, e `waitMs` aceita de **0 a 300000**: esperas de até **300 segundos** dependem do timeout aceito pelo cliente. Uma resposta `waiting` permite continuar a espera pelo mesmo acompanhamento, sem repetir a tarefa. O prazo do acompanhamento é independente da chamada: padrão de uma hora, configurável de um segundo a sete dias.

O monitor e seus resultados sobrevivem ao fim da chamada e a reinícios da Ponte. **Isso não usa agendador do ChatGPT/Claude e não acorda uma conversa encerrada.** O acompanhamento continua na Ponte; a retomada do chat depende do cliente. Consulte o resultado com `bridge_watch_get` ou no painel **Acompanhamentos**. Cancelar o acompanhamento não interrompe nem desfaz o trabalho externo.

Pela API REST, crie com `POST /v1/jobs`, `tool: "bridge_watch_create"` e os argumentos serializados na string `argumentsJson`; acompanhe a aprovação e o resultado pelo job devolvido. Consulte os monitores por `GET /v1/watchers` ou `GET /v1/watchers/{watcherId}`, aguarde por `POST /v1/watchers/{watcherId}/wait` e cancele por `POST /v1/watchers/{watcherId}/cancel`. O callback do executor usa a credencial exclusiva retornada na criação, separada do token API. O guia [Acompanhamentos duráveis](docs/WATCHERS.md) traz exemplos completos, inclusive para uma sessão remota do Claude.

### Continuar uma tarefa com MCP Events

Use uma conversa **Work no navegador** ou **Work com Cloud selecionado no aplicativo desktop**, conforme a [documentação da OpenAI](https://developers.openai.com/plugins/build/mcp-events). Atualize as ferramentas e os eventos do plugin depois de instalar a 0.6.0. A disponibilidade também depende das permissões da conta e do workspace.

Quando uma chamada retornar um `jobId` ainda pendente, peça:

```text
Acompanhe a conclusão do trabalho JOB_ID pela Ponte, usando o evento
ponte.job.completed. Quando o aviso chegar, consulte bridge_job para
esse mesmo ID e continue esta tarefa a partir do resultado. Não reenvie
a operação que criou o trabalho.
```

O cliente cria a assinatura com `arguments.jobId` e fornece o callback e a chave de assinatura. A Ponte verifica o destino antes de ativar o aviso. Você pode acompanhar a inscrição, as tentativas e a entrega em **Conectar IA → Avisos de conclusão**, ou usar **Encerrar aviso**.

A aprovação automática e os avisos são independentes: `automatic` libera ferramentas; MCP Events informa o cliente sobre uma execução específica. A retomada depende da assinatura, do suporte do cliente e das instruções da conversa. **Aviso recebido** confirma a entrega ao cliente, e não a conclusão das próximas ações do ChatGPT. O [guia completo](docs/MCP-EVENTS.md) explica o teste, a retenção de resultados e os limites.

Na investigação da mensagem `Webhook connectors could not be validated before creation`, o ChatGPT descobriu o evento, mas a tentativa de criar a tarefa não enviou `events/subscribe` à Ponte. Esse erro não foi resolvido pela atualização do servidor: o bloqueio observado acontece antes da assinatura, e sua causa interna ainda não foi identificada. O painel da 0.5.0 passa a distinguir essas etapas sem mostrar callbacks ou segredos. Consulte os registros em [VALIDACAO.md](docs/VALIDACAO.md) e o roteiro de diagnóstico de [MCP Events](docs/MCP-EVENTS.md).

### GPT personalizado com Actions

1. Encaminhe **somente a porta 4318** por um túnel HTTPS confiável, configurado por você. Mantenha o painel da porta 4317 local.
2. Salve a origem HTTPS em **Conectar IA → URL pública da API**. Exemplo: `https://sua-ponte.exemplo.com`, sem `/mcp`.
3. Baixe o OpenAPI pelo painel ou gere-o:

```powershell
node dist/cli.js export-openapi --url "https://sua-ponte.exemplo.com" --output "ponte-openapi.json"
```

4. No editor de Actions do seu GPT, importe o schema e configure **API Key → Bearer**.
5. Use o token retornado por `node dist/cli.js token api`. **Não use o token admin.**
6. Copie as instruções de `examples/chat-instructions.txt` e teste `getBridgeStatus`.

O projeto não abre túneis nem modifica sua conta automaticamente. O formato exato das telas e a disponibilidade de Actions/MCP dependem do cliente. Detalhes e fontes estão em `docs/INTEGRACOES.md`.

## Usar outros MCPs

Cadastre a configuração em **Conexões MCP**. Para MCPs stdio, instale o executável ou pacote no computador antes de conectá-lo. Para MCPs remotos, use a URL MCP completa.

Para automatizar um navegador, consulte [Adicionar Playwright MCP](docs/PLAYWRIGHT.md), com os campos prontos para o painel e o teste de conexão no Windows.

```json
{
  "id": "servico",
  "name": "Meu serviço",
  "transport": "http",
  "enabled": true,
  "url": "https://mcp.exemplo.com/mcp",
  "headers": { "Authorization": "Bearer ${MEU_SERVICO_TOKEN}" },
  "readOnlyTools": [],
  "timeoutMs": 30000
}
```

Defina `MEU_SERVICO_TOKEN` no ambiente do processo da ponte. Uma mudança na variável requer reiniciar o processo. O formulário preserva credenciais omitidas durante a edição. `allowedTools` pode limitar os nomes originais expostos. `readOnlyTools` declara quais ferramentas são de leitura: elas dispensam revisão no modo `mutations`, mas aguardam aprovação em `all`. O modo `automatic` dispensa a revisão de todas as ferramentas expostas. Não classifique ferramentas com efeitos colaterais como leitura.

MCPs stdio são programas executados com a conta do usuário. Instale e conecte programas em que você confia. O agregador não isola processos de terceiros.

## Fluxo das operações

1. O cliente consulta o catálogo.
2. A ponte valida argumentos e permissões.
3. A ponte aplica a política `mutations`, `all` ou `automatic`.
4. Se o trabalho ficar em `pending_approval`, o usuário revisa os argumentos exatos no painel; a aprovação automática libera os trabalhos válidos pela política escolhida.
5. A ponte executa e armazena o resultado. Trabalhos com assinatura de Events também têm estado e resultado retidos em disco por prazo limitado.
6. O chat consulta o trabalho e usa o resultado na resposta. Se o cliente criou uma assinatura, a Ponte envia o aviso de conclusão ao callback daquela conversa.

Chamadas MCP de ferramentas, inclusive `bridge_call`, aguardam até **25 segundos** enquanto o trabalho está `queued` ou `running`. Se a chamada inicial exigir aprovação, `pending_approval` retorna imediatamente para o chat informar onde revisar.

Para acompanhar o mesmo trabalho durante o turno ativo, use:

```json
{ "jobId": "ID_RETORNADO", "waitMs": 25000 }
```

`bridge_job` aceita `waitMs` inteiro de **0 a 25000**, com padrão **0** para consulta imediata. A espera acompanha `pending_approval`, `queued` e `running`, retornando ao concluir ou vencer o prazo. O `jobId` continua consultável; use consultas limitadas, sem reenviar a operação nem manter um ciclo ilimitado. Essa espera **não reabre uma conversa encerrada**.

A API REST devolve um `id` consultável por `getJob`; a espera `waitMs` pertence à ferramenta MCP `bridge_job`. `bridge_call` e a API aceitam `idempotencyKey`. Reenvios com a mesma chave e os mesmos argumentos recuperam o trabalho existente enquanto ele estiver retido; não reaproveite a chave para uma operação diferente.

A fachada HTTP oferece os métodos `server/discover`, `tools/list`, `tools/call` e `events/list`, `events/subscribe`, `events/unsubscribe` do protocolo `2026-07-28` por um adaptador específico. O SDK MCP 1.32.1 continua atendendo clientes legados e conexões upstream. Isso mantém a compatibilidade existente sem anunciar recursos modernos que não foram implementados. Events usa webhooks; não depende de um GET/SSE aberto em `/mcp`. Consulte [MCP Events](docs/MCP-EVENTS.md) para o contrato e as referências oficiais.

## Configuração, cópias de segurança e histórico

O diretório `.ponte` é criado somente na instalação local e fica fora do pacote:

- `config.json`: projetos, portas, MCPs e `approvalMode`.
- `secrets.json`: dois tokens aleatórios distintos.
- `oauth.json`: clientes registrados e autorizações OAuth, incluindo segredos de clientes e hashes dos tokens.
- `events.json`: assinaturas, callbacks e chaves de webhook, fila de entrega e resultados dos trabalhos acompanhados; é um arquivo privado e sensível.
- `watchers.json`: acompanhamentos persistidos, resultados e dados privados de autorização; preserve junto com o estado da instalação.
- `audit.jsonl`: metadados das execuções e tipo de aprovação, sem argumentos, códigos ou resultados.
- `backups/ID.bak`: conteúdo anterior de arquivos substituídos.

O resultado da escrita informa `backupId`. Para restaurar, identifique a cópia correspondente e substitua o arquivo manualmente após revisar seu conteúdo. Não há botão de desfazer nesta versão.

Trabalhos comuns e seus resultados permanecem em memória. A consulta e o cancelamento pelo cliente são vinculados à autorização OAuth ou identidade do token API que criou o trabalho; o painel administrativo mantém acesso a todas as execuções. Para trabalhos acompanhados por Events, a Ponte retém uma cópia sem os argumentos de entrada e com o resultado por até o prazo da assinatura, que tem padrão e máximo de 24 horas; renovações podem estender a retenção. `bridge_job` recupera essa cópia para a mesma conexão após reiniciar. Um trabalho acompanhado que estava em andamento ao reiniciar é marcado como interrompido/cancelado, sem repetir a operação. A auditoria guarda metadados e não substitui esse resultado. Aprovações de trabalhos expiram após 15 minutos. Ações em execução têm limite de 120 segundos; os limites específicos de cada ferramenta podem ser menores. Cancelar ou receber timeout não garante que um serviço externo desfez a operação.

Clientes e autorizações OAuth persistem em `oauth.json`. Pedidos de conexão aguardam aprovação por até 10 minutos; o código OAuth emitido no retorno após aprovar vale por 2 minutos. Access tokens valem por até 1 hora. A renovação usa refresh tokens rotativos e tem prazo absoluto de 30 dias a partir da autorização; renovar não reinicia esse prazo. O painel permite revogar uma autorização antes do vencimento. Pedidos e códigos OAuth ainda em andamento ficam em memória: após reiniciar o serviço, inicie esses fluxos novamente.

## Desenvolvimento

```sh
npm ci --ignore-scripts
npm run verify
npm run dev
```

`verify` verifica tipos, executa testes e compila. Os testes criam apenas diretórios temporários e servidores locais. Um ambiente restrito precisa permitir sockets de loopback para testar HTTP.

Depois do build, `npm run smoke` verifica uma conexão MCP HTTP real, leitura, escrita com revisão, separação de tokens e backup, usando portas livres e arquivos temporários. Não altera a configuração pessoal da ponte.

```text
src/
  core/        configuração, auditoria e fila de trabalhos
  tools/       filesystem e execução local
  mcp/         clientes upstream e fachada do servidor
  events/      assinaturas, resultados retidos e entrega de webhooks
  watchers/    acompanhamentos duráveis por sinal ou estado final de um job
  app.ts       composição e ciclo de vida
  http.ts      administração, REST e transporte MCP
  cli.ts       inicialização e adaptador stdio
  openapi.ts   schema de Actions
public/        painel sem dependências externas
tests/         testes comportamentais e integração com SDK MCP
examples/      configurações e instruções para o chat
docs/          arquitetura, integração, Roblox e limites
```

## Limitações desta entrega

- Uso pessoal, com um único proprietário. Catálogo, projetos e políticas são compartilhados. Consultas e cancelamentos de trabalhos, assinaturas e resultados arquivados ficam vinculados à identidade que criou o trabalho; isso não cria isolamento dos projetos entre usuários.
- Acesso a arquivos é restrito às pastas cadastradas; **terminal e MCPs externos não são sandboxes do sistema operacional**.
- O proxy cobre ferramentas MCP. Resources, prompts, sampling, elicitation e login OAuth interativo de upstreams não são encaminhados.
- Reconexão de upstreams é manual. A ponte não reexecuta ferramentas externas automaticamente; tentativas de entrega de avisos repetem somente o evento.
- Não há captura genérica de desktop, controle de mouse fora do MCP conectado, processo autônomo de planejamento ou serviço Windows instalado.
- Não inclui LLM local; pode ser conectado a um cliente compatível que use modelos locais.
- Consulte `docs/VALIDACAO.md` para os testes efetivamente executados. A integração com Windows, Studio real e sua conta do ChatGPT precisa ser validada no seu computador; publicar a URL e configurar a conta são etapas de implantação.

Consulte `docs/VALIDACAO.md` para o resultado observado na entrega e `docs/SEGURANCA.md` para os limites de confiança.
