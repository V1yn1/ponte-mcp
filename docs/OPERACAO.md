# Operação e configuração — Ponte MCP 0.8.0

[Índice da documentação](README.md) · [Integrações](INTEGRACOES.md) · [Segurança](SEGURANCA.md)

## Pré-requisitos e instalação

A exigência do programa é **Node.js >= 22.12.0**, conforme [package.json](../package.json). Instale o Node pelo [site oficial](https://nodejs.org/). Git é necessário somente se você escolher clonar e atualizar o repositório dessa forma. Roblox Studio, Claude Code e servidores upstream têm instalação própria.

No Windows, abra o PowerShell na pasta em que deseja manter o projeto:

```powershell
git clone https://github.com/V1yn1/ponte-mcp.git
cd ponte-mcp
npm.cmd ci --ignore-scripts
npm.cmd run build
node dist/cli.js init --workspace "C:\Projetos\MeuProjeto"
npm.cmd start
```

Para instalar por ZIP, extraia o pacote e execute os mesmos comandos a partir de `npm.cmd ci`, na pasta que contém `package.json`. No macOS/Linux, use `npm` no lugar de `npm.cmd` e adapte o caminho do projeto.

`npm.cmd run setup` equivale a `node dist/cli.js init` sem uma pasta personalizada. Na configuração inicial, cria o projeto `principal` no diretório `workspace`, ao lado do diretório de estado. `init` preserva uma configuração já existente: `--workspace`, `--port` e `--api-port` não sobrescrevem as opções previamente salvas.

O serviço fica em primeiro plano; mantenha o terminal aberto. Abra [http://127.0.0.1:4317](http://127.0.0.1:4317). Em outro terminal na pasta da instalação:

```powershell
node dist/cli.js token admin
```

Use a saída somente para entrar no painel local. Não cole tokens em conversas, tickets ou capturas de tela. Em **Projetos**, configure as pastas reais, a permissão de escrita e, quando necessário, a permissão de execução de comandos.

### Scripts auxiliares do Windows

[scripts/install.ps1](../scripts/install.ps1) confere Node, instala as dependências, compila e inicializa a configuração. Se sua política PowerShell já permite scripts locais:

```powershell
.\scripts\install.ps1 -Workspace "C:\Projetos\MeuProjeto"
```

Se ela bloquear o script, use os comandos individuais acima; a instalação não exige alterar a política do sistema. [scripts/start.cmd](../scripts/start.cmd) inicia o programa compilado. Nenhum deles instala um serviço Windows ou configura inicialização automática.

## Diretório de estado

A prioridade de seleção é:

1. `--state-dir PASTA` fornecido ao comando;
2. variável de ambiente `PONTE_STATE_DIR`;
3. `.ponte` dentro da pasta de instalação do programa.

O padrão não depende da pasta atual do terminal. Para caminhos personalizados, prefira caminhos absolutos e use o mesmo diretório nos comandos `start`, `token`, `doctor` e na configuração stdio.

```powershell
node dist/cli.js init --state-dir "C:\Dados\Ponte" --workspace "C:\Projetos\MeuProjeto"
node dist/cli.js start --state-dir "C:\Dados\Ponte"
```

Em outro terminal:

```powershell
node dist/cli.js doctor --state-dir "C:\Dados\Ponte"
node dist/cli.js token admin --state-dir "C:\Dados\Ponte"
```

Não inicie duas instâncias com o mesmo estado. O diretório contém credenciais e dados privados; mantenha-o fora do Git e dos pacotes públicos.

| Item | Conteúdo e persistência |
|---|---|
| `config.json` | Portas, URL pública, política, projetos e upstreams |
| `secrets.json` | Tokens distintos de administração e API; a chave API também participa da derivação dos tokens de watchers |
| `oauth.json` | Clientes OAuth, autorizações e informações de renovação/revogação |
| `events.json` | Inscrições, destinos e segredos de webhook, fila, resultados de jobs e metadados de watchers retidos por Events |
| `watchers.json` | Acompanhamentos, resultados, vínculo de proprietário e hashes de credenciais de sinal |
| `audit.jsonl` | Metadados de execuções, sem conteúdo de argumentos ou resultados |
| `backups/` | Cópias anteriores dos arquivos substituídos pelas ferramentas de escrita |

Arquivos de subsistemas podem surgir quando o serviço os inicializa ou quando há dados para persistir. Preserve o diretório completo em vez de selecionar somente alguns JSONs.

### O que acontece ao reiniciar

| Estado | Comportamento |
|---|---|
| Configuração, tokens e autorizações OAuth concluídas | Persistem se o mesmo estado e a mesma origem pública forem mantidos |
| Pedido OAuth ou código de autorização ainda em andamento | Ficam em memória; inicie novamente o fluxo de conexão |
| Trabalhos comuns | A fila é volátil; não são reexecutados automaticamente |
| Trabalho com resultado retido por Events | Pode ser consultado pela mesma identidade durante a retenção; uma execução interrompida não é retomada |
| Watcher `signal` | Continua com o mesmo ID, prazo e credencial enquanto válido e autorizado |
| Watcher `job` | Depende de o trabalho ainda poder ser recuperado; se ele desapareceu, termina como `interrupted`; um trabalho arquivado pode já estar `cancelled` |
| Chamada `bridge_watch_wait` aberta | A conexão termina; consulte ou aguarde novamente o mesmo watcher |
| Pausa de execuções | É estado de execução em memória; confira a condição após iniciar |

## Atualizar sem perder a configuração

1. Aguarde operações sensíveis concluírem ou confira o estado delas. Encerre a Ponte com `Ctrl+C`.
2. Faça uma cópia privada de **todo** o diretório de estado. Inclua `secrets.json` e `watchers.json` do mesmo conjunto.
3. Atualize os arquivos do programa e compile.
4. Reinicie usando o mesmo estado, confira a versão e recarregue o catálogo no cliente.

Para uma instalação Git, na pasta do repositório:

```powershell
git status --short
git pull --ff-only
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd start
```

Se houver alterações locais ou o avanço direto falhar, preserve essas alterações e resolva a divergência antes de atualizar. Não use `reset --hard` ou apague o estado para contornar a atualização.

Para ZIP, substitua os arquivos do programa com a Ponte parada e preserve o estado completo. Se extrair em outra pasta, aponte para o estado antigo:

```powershell
node dist/cli.js start --state-dir "C:\Projetos\ponte-mcp-antiga\.ponte"
```

Atualize também o caminho do executável `dist/cli.js` na configuração de clientes stdio. Uma conexão OAuth já concluída pode continuar válida com a mesma origem e o mesmo estado; pedidos de conexão em andamento devem ser refeitos.

Confira `version: "0.8.0"` em `bridge_status` ou no resultado de `doctor` da instância realmente conectada. Atualize a descoberta no chat: `bridge_watch_wait` deve anunciar máximo de **45000 ms**, e o catálogo Events deve incluir **`ponte.watcher.completed`** junto de `ponte.job.completed`. As três ferramentas `bridge_mcp_*` e as cinco `bridge_watch_*` continuam disponíveis. `bridge_list_tools` e `bridge_call` permitem usar ferramentas do catálogo atual, mas não atualizam a descoberta de Events do cliente. Os guias de [ChatGPT](CHATGPT.md) e [Claude](CLAUDE.md) explicam a atualização.

Uma espera antiga com `waitMs: 300000` será rejeitada pela 0.8.0, preservando o ID e orientando `bridge_watch_get`; use 25000 ms na próxima espera se o acompanhamento continuar em `waiting`. Isso não recria o watcher nem renova seu `expiresAt`. A versão do repositório ou um build local não confirmam, sozinhos, atualização do serviço instalado.

### Estado de Events e retorno a uma versão anterior

A 0.8.0 lê os arquivos `events.json` anteriores com `version: 1` e acrescenta `watcherArchives` ao persistir os metadados do novo evento. Essa compatibilidade permite atualizar a instalação; ela não garante a leitura do estado novo por uma versão antiga, cujo schema estrito pode recusar esse campo.

Para voltar a uma versão anterior, pare o serviço e restaure um **backup completo e compatível feito antes da atualização**, junto do código correspondente. Trocar somente o programa deixa o estado novo no disco. Preserve também uma cópia privada do estado atual para investigar diferenças e resultados produzidos depois do backup. Restaurar estado não desfaz efeitos externos nem autoriza reenviar tarefas.

### Credenciais e restauração

**Não apague ou recrie `secrets.json` isoladamente para “renovar o token”.** Na v0.8.0, a chave API é usada para validar as credenciais de watchers persistidos. Trocar essa chave sem migrar o estado pode fazer a inicialização recusar `watchers.json`. Esta versão não oferece um comando de rotação coordenada dessas chaves.

Para restaurar uma instalação, pare o serviço e restaure o conjunto completo e coerente de estado a partir da cópia privada. Isso volta os dados ao momento do backup; efeitos já produzidos em arquivos ou sistemas externos não são revertidos por essa restauração. Confira os destinos antes de repetir uma tarefa cujo resultado ficou incerto.

Backups de arquivo são separados do backup da instalação. Uma escrita informa `backupId`; o conteúdo anterior fica em `backups/ID.bak`. A restauração de um arquivo é manual, após revisar a cópia. Não há botão de desfazer.

## Referência da CLI

Todos os comandos abaixo são executados como `node dist/cli.js COMANDO`. `--help` mostra a ajuda sem carregar o estado.

| Comando | Uso |
|---|---|
| `init [--workspace PASTA]` | Criar configuração e credenciais; preserva uma configuração existente |
| `start` | Iniciar painel e API em loopback, usando as portas salvas |
| `stdio` | Expor MCP local por stdio, encaminhando ao serviço já iniciado |
| `token admin` | Mostrar a credencial administrativa no terminal local |
| `token api` | Mostrar a credencial REST/Actions no terminal local |
| `doctor` | Verificar diretórios de projetos e consultar o serviço local |
| `add-project ID PASTA` | Adicionar/substituir o projeto com esse ID, com escrita permitida e execução desabilitada; reinicie para carregar |
| `add-roblox` | Adicionar/substituir o preset Roblox; requer Windows/macOS; reinicie para conectar |
| `export-openapi --url HTTPS --output ARQUIVO` | Exportar o schema Actions para uma origem HTTPS; não exige inicializar o estado |

As opções `--port` e `--api-port` escolhem portas somente ao **criar** a configuração. Exemplo:

```powershell
node dist/cli.js init --port 5317 --api-port 5318 --workspace "C:\Projetos\MeuProjeto"
```

Portas válidas vão de 1024 a 65535 e devem ser diferentes. Para alterar uma instalação existente, pare o serviço, faça backup, edite esses campos em `config.json` e inicie novamente. Ajuste o túnel e o endereço do painel às novas portas. Alterações de projetos/upstreams pelo painel e novos cadastros de MCPs pelo chat são aplicados pelo serviço; os comandos CLI de cadastro exigem reinício.

## Configuração e variáveis de ambiente

[src/core/config.ts](../src/core/config.ts) define os schemas. `config.json` usa `version: 1`; esse é o formato da configuração, não a versão do produto. Campos desconhecidos são recusados.

| Campo | Regra |
|---|---|
| `port`, `apiPort` | Portas distintas de painel/API |
| `publicUrl` | Opcional; origem HTTPS sem caminho, query, fragmento ou credenciais |
| `approvalMode` | `mutations`, `all` ou `automatic` |
| `projects` | Até 100; ID único, nome, caminho absoluto, `allowWrite` e `allowExec` |
| `upstreams` | Até 30; IDs únicos e transporte `stdio`, `http` ou `sse` |

IDs de projeto e upstream começam com letra minúscula, seguidos de letras minúsculas, números, `_` ou `-`, até 32 caracteres. Os limites de ferramentas são descritos em [API](API.md); as regras de aprovação ficam em [Segurança](SEGURANCA.md).

| Variável | Onde é usada |
|---|---|
| `PONTE_STATE_DIR` | CLI da Ponte, como alternativa a `--state-dir` |
| `${NOME_DA_VARIAVEL}` em `env`/`headers` de upstream | Resolvida no ambiente do processo da Ponte ao conectar o servidor |
| `PONTE_WATCH_URL`, `PONTE_WATCH_TOKEN`, `PONTE_WATCH_RUN_ID` | Script produtor, no ambiente do executor de uma tarefa específica |

Depois de mudar uma variável no terminal que inicia a Ponte, reinicie o processo para que ele receba o novo ambiente. O produtor de watcher deve receber suas variáveis por tarefa; não configure o mesmo token como credencial global de todos os executores. Veja [Watchers](WATCHERS.md).

## Conexões adicionadas durante a conversa

O cadastro por `bridge_mcp_add` aparece em **Conexões MCP** e é salvo em `config.json`, no mesmo diretório de estado. Não exige reiniciar a Ponte. A execução segue a política atual; prévias e resultados ficam em **Execuções**. Leia [MCPs pelo chat](MCPS-PELO-CHAT.md) para exemplos, campos e revisão.

Uma falha de conexão não apaga automaticamente o cadastro. Confira comando/endpoint, dependências e variáveis de ambiente antes de tentar novamente. O chat pode listar o status e reconectar com a revisão atual; editar e remover ficam no painel. Configurações administrativas existentes com o mesmo ID não são substituídas pelo chat.

Credenciais no contrato do chat usam referências `${NOME}` (ou `Bearer ${NOME}` nos headers) resolvidas no ambiente da Ponte. Se precisar disponibilizar uma variável nova a um processo já iniciado, encerre-o e inicie novamente com esse ambiente, preservando o estado. Cadastrar um upstream não instala programas do sistema nem autentica automaticamente uma conta externa.

Depois de conectar, `bridge_list_tools` com `source: "mcp:ID"` retorna as ferramentas atuais para uso por `bridge_call`. Uma atualização de metadados do cliente pode ser necessária para que os nomes também apareçam diretamente na interface, mas não é requisito para a chamada pelo broker.

## URL pública e diagnóstico

A API usa a porta **4318** por padrão; o painel usa **4317**. A Ponte não abre túneis automaticamente. Publique a API inteira por HTTPS, salve a origem no painel e mantenha o serviço/túnel ativos enquanto forem necessários.

Se o domínio do túnel mudar, atualize **Conectar IA → URL pública da API** e inicie novas autorizações OAuth: a mudança invalida as autorizações vinculadas à origem anterior. Um executor com callback antigo também precisa da URL alcançável correta. Evite alterar a origem no meio de um fluxo OAuth. Os detalhes estão em [ChatGPT](CHATGPT.md).

| Sintoma | Conferência útil |
|---|---|
| Painel não abre | Terminal do serviço, erro de porta ocupada e endereço/porta de `config.json` |
| `doctor` mostra `connected: false` | Inicie `start` com o mesmo diretório de estado e confira a porta API |
| Login recusa token | Use `token admin` do mesmo estado; token API não entra no painel |
| `Host não autorizado` | Confira a origem pública salva e o host que o túnel encaminha |
| HTTP 405 ao abrir `/mcp` | Depois de autenticar, GET é recusado; MCP usa POST. Use `doctor` ou `bridge_status` para testar |
| Ferramenta antiga ou watcher ausente | Recompile/reinicie, confirme a versão do servidor e atualize a descoberta no cliente |
| Erro ao carregar watchers após trocar credenciais | Restaure o conjunto coerente de estado; não descarte o arquivo como solução automática |
| Execução terminou, tarefa externa não | Confira se o job apenas delegou a demanda; use watcher `signal` para a conclusão real |
| Espera de watcher interrompida ou acima de 45000 ms recusada | Consulte `bridge_watch_get` pelo mesmo ID; retome esperas de 25000 ms somente se continuar `waiting` |
| Cliente só descobre `ponte.job.completed` | Confira a versão da instância, reinicie após atualizar e recarregue Events no plugin; a 0.8.0 também publica `ponte.watcher.completed` |

## Verificação em desenvolvimento

```sh
npm ci --ignore-scripts
npm run verify
npm run smoke
```

`verify` confere tipos, executa a suíte e gera `dist`. O smoke precisa desse build. Os testes usam diretórios temporários e portas locais; o ambiente deve permitir listeners de loopback. A evidência por versão e as verificações ainda dependentes do computador do usuário estão em [Validação](VALIDACAO.md).
