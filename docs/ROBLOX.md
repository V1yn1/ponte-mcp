# Roblox Studio com Ponte MCP 0.6.0

A Ponte conecta o chat ao servidor MCP integrado ao Roblox Studio. O Studio continua executando no seu computador; a Ponte inicia o processo de comunicação por `stdio`, descobre as ferramentas disponíveis e aplica a política de aprovação do painel.

[Índice da documentação](README.md) · [Instalação da Ponte](../README.md) · [Integrações MCP](INTEGRACOES.md)

## 1. Preparar a Ponte e o Studio

Instale e inicie a Ponte conforme o [README](../README.md). Esta versão exige Node.js **22.12 ou superior**. Abra o painel no endereço informado pela CLI, normalmente `http://127.0.0.1:4317`, e entre com o token de administração.

Execute a Ponte e o Studio na mesma máquina Windows ou macOS e no perfil de usuário que contém a instalação do Studio. Na versão atualizada do Studio, abra o place desejado e habilite **Assistant → … → Manage MCP Servers → Enable Studio as MCP server**.

Esse é o fluxo da [documentação oficial do Studio MCP](https://create.roblox.com/docs/studio/mcp), consultada em **22 de outubro de 2026**. A integração embutida fornece o processo stdio; este guia não requer um plugin Lua adicional.

## 2. Cadastrar a conexão

No painel, abra **Conexões MCP → Preset Roblox**. O preset cria uma conexão com estes valores:

| Campo | Valor |
|---|---|
| Nome | `Roblox Studio` |
| Identificador | `roblox` |
| Transporte | `stdio — processo local` |
| Timeout por chamada (ms) | `120000` |
| Ferramentas de leitura | Vazio (`readOnlyTools: []`) |
| Limitar ferramentas expostas | Desmarcado |
| Ativar esta conexão ao salvar | Marcado |

O comando depende do sistema operacional da **Ponte**, conforme o [preset implementado](../src/core/config.ts):

| Sistema | Comando | Argumentos (array JSON) |
|---|---|---|
| Windows | `cmd.exe` | `["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]` |
| macOS | `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` | `[]` |

Esses pontos de entrada também estão documentados no [guia oficial do Roblox](https://create.roblox.com/docs/studio/mcp#json-configuration). Se cadastrar manualmente em **Adicionar conexão**, coloque o executável em **Comando** e somente o array em **Argumentos**. Não cole um objeto `mcpServers` nesse campo.

Aguarde **Conectado** e a quantidade de ferramentas no card. O Studio também mostra um indicador verde de clientes conectados em suas configurações MCP. Uma conexão estabelecida confirma a comunicação; o teste com o place vem na próxima seção.

Se o identificador `roblox` já existir, o botão **Preset Roblox** reconecta a configuração existente. Use **Editar conexão** para conferir ajustes anteriores.

### Alternativa pela CLI

Na pasta da Ponte, com o serviço parado:

```bash
node dist/cli.js add-roblox
npm start
```

No PowerShell, `npm.cmd start` também pode ser usado. Se a instalação utiliza outro diretório de estado, mantenha o mesmo `--state-dir` em todos os comandos:

```powershell
node dist/cli.js add-roblox --state-dir "C:\Projetos\ponte-mcp\.ponte"
node dist/cli.js start --state-dir "C:\Projetos\ponte-mcp\.ponte"
```

A CLI grava o preset no disco e exige reiniciar o serviço. Ao contrário do botão do painel, `add-roblox` substitui a configuração de mesmo ID pelos valores do preset.

### Linux e outros ambientes

O preset da Ponte 0.6.0 aceita apenas Windows e macOS. Em Linux, inclusive quando a Ponte roda dentro de WSL ou de um contêiner Linux, ele retorna uma mensagem pedindo o computador com o Studio. Para esse fluxo, execute a Ponte no Windows/macOS junto ao Studio e conecte o chat àquela instância da Ponte.

Um cliente remoto usa a conexão da Ponte descrita em [CHATGPT.md](CHATGPT.md) ou [CLAUDE.md](CLAUDE.md). O endereço público é o da API da Ponte, não uma porta presumida do Studio.

## 3. Descobrir as ferramentas e verificar o place

Abra **Ferramentas** e pesquise `roblox`. Pelo chat, a mesma pesquisa pode ser feita com `bridge_list_tools`:

```json
{"search":"roblox","limit":50}
```

Se houver `nextOffset`, continue a consulta com esse valor em `offset`. Confirme a origem `mcp:roblox` e copie o **nome completo devolvido pelo catálogo** para chamar a ferramenta diretamente ou em `bridge_call`.

A Ponte acrescenta um prefixo e um hash ao nome, podendo truncar a parte original para caber no limite do protocolo. Não monte o nome exportado à mão. O `inputSchema` da versão instalada é a referência para os argumentos.

Faça a validação em etapas:

| Etapa | Ação | Evidência a conferir |
|---|---|---|
| Descoberta | Localize a ferramenta original `list_roblox_studios` e envie os argumentos exigidos pelo schema. | A instância aberta aparece no resultado com sua identificação. |
| Seleção | Use o ID retornado como `studio_id` nas chamadas que o exigirem. | O alvo corresponde ao place desejado, especialmente quando há várias janelas. |
| Inspeção | Localize `get_studio_state` ou `inspect_instance` e preencha seu schema. | Estado ou objetos retornados conferem com o editor. |
| Alteração | Em um place de teste, solicite uma pequena alteração de script e revise os argumentos. | A mudança aparece no script e no local esperado. |
| Execução | Teste o comportamento em play mode, usando as ferramentas anunciadas para esse fluxo. | O resultado observado no jogo corresponde à mudança solicitada. |

Os nomes originais acima constam no [catálogo oficial](https://create.roblox.com/docs/studio/mcp#how-the-studio-mcp-server-works); a Ponte encaminha apenas o catálogo que o servidor instalado efetivamente anunciar. Campos como `studio_id` e `datamodel_type` devem seguir o schema retornado. Edit, Client e Server representam alvos distintos.

No painel, use **Enviar solicitação**. Se aparecer **Aguardando aprovação**, abra **Revisar detalhes**, confira a instância e os argumentos e aprove. Depois consulte o resultado em **Execuções**.

## 4. Aprovações e permissões

Em **Visão geral → Você no controle → Política de aprovação**, há três modos:

| Opção do painel | Comportamento com o preset Roblox |
|---|---|
| Aprovar alterações e comandos (`mutations`, padrão) | Todas as ferramentas aguardam revisão porque o preset começa sem ferramentas declaradas de leitura. |
| Aprovar todas as solicitações (`all`) | Todas aguardam revisão, inclusive as posteriormente declaradas de leitura. |
| Aprovar automaticamente todas (`automatic`) | Chamadas válidas e pendentes válidos são liberados para os clientes autorizados, respeitando a pausa e as ferramentas expostas. |

Para classificar uma ferramenta como leitura, informe seu **nome original exato**, um por linha, em **Ferramentas de leitura**. Use essa opção depois de conferir o comportamento da ferramenta. O campo não recebe o prefixo/hash acrescentado pela Ponte.

**Limitar ferramentas expostas** também recebe nomes originais. Desmarcado expõe todas as ferramentas descobertas; marcado com lista vazia expõe nenhuma. A classificação de leitura, sozinha, não restringe o catálogo.

As permissões **Permitir escrita** e **Permitir comandos** de **Projetos** controlam ferramentas locais como `local_write_file` e `local_exec`. Elas não concedem nem bloqueiam operações feitas dentro do Studio por um MCP externo. Para o Studio, use a política de aprovação e a lista de ferramentas permitidas; as permissões da própria sessão Roblox também continuam valendo.

O diff e os backups da Ponte se aplicam aos arquivos de texto manipulados pelas ferramentas locais. Uma chamada externa é revisada pelos argumentos e pelo resultado: a Ponte não produz um diff do data model nem um backup do place. Detalhes em [SEGURANCA.md](SEGURANCA.md).

## 5. Acompanhar a execução

Há dois prazos diferentes:

- A conexão Roblox usa `timeoutMs: 120000` para as operações MCP. O executor de trabalhos da Ponte também limita uma execução a 120 segundos.
- A chamada do chat aguarda até 25 segundos por um trabalho na fila ou em execução. Se precisar de aprovação, a resposta inicial retorna imediatamente com `pending_approval`.

Quando a resposta trouxer `jobId`, consulte **o mesmo trabalho** com `bridge_job` e `waitMs: 25000`. Essa consulta pode aguardar tanto a aprovação quanto a execução; `waitMs: 0` consulta imediatamente. Revise o status final e o conteúdo retornado antes de afirmar que a tarefa terminou.

Se uma ferramenta do Studio apenas iniciar uma tarefa assíncrona e devolver um identificador próprio, a conclusão do job da Ponte confirma o retorno dessa chamada. Acompanhe a tarefa interna pelas ferramentas que o Studio anunciar. Um acompanhamento da Ponte baseado em `job` também observa a chamada, não descobre sozinho quando a tarefa remota terminou.

Para acompanhamento durante o turno, veja [WATCHERS.md](WATCHERS.md). Para avisos após a conclusão de um job, clientes compatíveis podem usar [MCP-EVENTS.md](MCP-EVENTS.md). Uma espera ou um watcher, por si só, não reabre uma conversa encerrada.

Em caso de timeout, desconexão ou cancelamento, confira o Studio antes de repetir a ação: a operação externa pode ter continuado. A Ponte não reenvia automaticamente a chamada. Resultados MCP podem conter imagens, cuja apresentação depende do cliente; o limite total do resultado de um job é 4 MiB.

## 6. Resolver problemas

| Sintoma | Verificação e próximo passo |
|---|---|
| Executável ou diretório não encontrado no Windows | No PowerShell, execute `Test-Path "$env:LOCALAPPDATA\Roblox\mcp.bat"`. Se retornar `False`, confira a instalação e o perfil de usuário do Studio. Use o caminho de entrada oficial, não uma pasta de versão presumida. |
| Executável não encontrado no macOS | Confira `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` e a instalação atual do Studio. |
| Preset recusado em Linux/WSL | Inicie a Ponte no mesmo Windows/macOS que executa o Studio. |
| Conexão com erro ou encerrada | Confirme que o Studio está aberto, que seu MCP está habilitado e que o comando cadastrado corresponde ao sistema. Reinicie o Studio se necessário e clique em **Reconectar**. |
| Conectado, mas sem ferramentas | Confira se **Limitar ferramentas expostas** está marcado com lista vazia ou com nomes exportados pela Ponte em vez dos nomes originais. Atualize o catálogo após corrigir. |
| Ferramenta ausente ou argumentos rejeitados | Pesquise novamente o catálogo e use o schema atual. Reconectar ou atualizar o Studio pode alterar o catálogo e invalidar uma solicitação anterior. |
| Job parado em `pending_approval` | Revise no painel; a espera pelo resultado não aprova a ação. Solicitações pendentes expiram após 15 minutos. |
| Timeout ou resultado muito grande | Consulte o mesmo job e o estado real no Studio. Reduza o escopo ou o volume retornado antes de formular uma nova chamada. |
| O chat não vê as ferramentas novas | Atualize as ferramentas do cliente/plugin ou pesquise com `bridge_list_tools`. Confirme que o cliente aponta para a mesma Ponte e o mesmo diretório de estado. |

## Escopo da validação

Este guia foi conferido contra o [preset e schema de configuração](../src/core/config.ts), o [agregador MCP](../src/mcp/hub.ts), o [gateway de ferramentas](../src/mcp/server.ts), o [executor de trabalhos](../src/core/jobs.ts) e os campos do [painel](../public/index.html).

A revisão documental não executou o Roblox Studio, uma edição de place ou um playtest no computador do usuário. A seção 3 fornece o roteiro para registrar essa validação no ambiente real. Os testes automatizados e seus limites estão descritos em [VALIDACAO.md](VALIDACAO.md).

Ao atualizar a Ponte, siga o guia de [Operação](OPERACAO.md#atualizar-sem-perder-a-configuração), preserve o diretório de estado e atualize o catálogo do cliente. Reconectar uma instância existente não comprova que uma operação anterior terminou: consulte seu resultado antes de continuar.
