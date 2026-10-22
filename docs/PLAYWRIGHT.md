# Playwright MCP com Ponte MCP 0.6.0

A Ponte pode iniciar o servidor oficial `@playwright/mcp` como uma conexão **stdio**. As ferramentas do navegador passam a aparecer no catálogo da Ponte e ficam disponíveis aos clientes já conectados a ela. O navegador executa na máquina da Ponte, mesmo quando o chat está em outro computador.

[Índice da documentação](README.md) · [Instalação da Ponte](../README.md) · [Integrações MCP](INTEGRACOES.md)

## 1. Conferir os pré-requisitos

Tenha a Ponte instalada e iniciada, usando **Node.js 22.12 ou superior**, conforme [package.json](../package.json). O Node compatível com a Ponte atende ao requisito publicado para o Playwright MCP. O processo da Ponte também precisa encontrar o npm/npx no `PATH`.

Confira no mesmo ambiente em que você inicia a Ponte:

**Windows — PowerShell**

```powershell
node --version
npm.cmd --version
Get-Command npx.cmd
```

**Linux ou macOS — terminal**

```bash
node --version
npm --version
command -v npx
```

O primeiro uso pode baixar o pacote npm e o navegador. A [instalação oficial](https://playwright.dev/mcp/installation) descreve o download automático do navegador. Rede, proxy e requisitos do sistema precisam permitir essa etapa; **Conectado** no card ainda não comprova que o navegador conseguiu abrir.

Os comandos e opções externos deste guia foram conferidos na documentação oficial em **22 de outubro de 2026**. `@latest` acompanha a versão publicada; depois de validar sua instalação, você pode substituir esse sufixo pela versão que efetivamente testou para tornar o ambiente reproduzível.

## 2. Adicionar a conexão no painel

Abra o painel no endereço informado pela CLI, normalmente `http://127.0.0.1:4317`. Entre com o token de administração e acesse **Conexões MCP → Adicionar conexão**.

Preencha os campos comuns:

| Campo | Valor inicial |
|---|---|
| Nome | `Playwright` |
| Identificador | `playwright` |
| Transporte | `stdio — processo local` |
| Timeout por chamada (ms) | `120000` |
| Comando e Argumentos | Use a configuração do seu sistema abaixo. |
| Diretório de trabalho | Vazio para o teste inicial; para trabalhar com arquivos de um projeto, use uma pasta absoluta existente. |
| Ferramentas de leitura | Vazio |
| Limitar ferramentas expostas | Desmarcado para descobrir o catálogo completo |
| Variáveis de ambiente / Cabeçalhos HTTP | Vazios no cadastro básico |
| Ativar esta conexão ao salvar | Marcado |

### Windows

Para iniciar o npx explicitamente pelo interpretador de comandos do Windows, use:

**Comando**

```text
cmd.exe
```

**Argumentos (array JSON)**

```json
["/d", "/s", "/c", "npx", "-y", "@playwright/mcp@latest"]
```

A Ponte também aceita **Comando** `npx` e **Argumentos** `["-y", "@playwright/mcp@latest"]` no Windows: o transporte stdio do SDK utiliza `cross-spawn` para resolver executáveis e scripts do npm. A configuração com `cmd.exe` torna essa invocação explícita.

### Linux ou macOS

**Comando**

```text
npx
```

**Argumentos (array JSON)**

```json
["-y", "@playwright/mcp@latest"]
```

As duas configurações executam o pacote indicado no [README oficial da Microsoft](https://github.com/microsoft/playwright-mcp#readme). `-y` evita que o npm espere uma confirmação interativa de instalação durante a inicialização do servidor.

### Salvar e verificar

Cole somente o array no campo **Argumentos**. O objeto `mcpServers` dos exemplos de outros clientes não pertence a esse campo, e a linha inteira `npx -y @playwright/mcp@latest` não deve ir em **Comando**.

Clique em **Salvar conexão**. Aguarde **Conectado**, acompanhado da quantidade de ferramentas. O cadastro pelo painel atualiza a conexão em execução; não é necessário reiniciar toda a Ponte para adicionar esse upstream.

## 3. Fazer um teste verificável

Em **Ferramentas**, pesquise `browser_navigate`. Escolha o resultado cuja origem seja `mcp:playwright` e confira **Ver esquema dos parâmetros (JSON Schema)**.

O nome exportado tem prefixo, parte do nome original e hash. Copie o nome que o catálogo retornar; não invente o sufixo. A ferramenta de navegação documentada atualmente recebe uma URL:

```json
{"url":"https://example.com"}
```

Clique em **Enviar solicitação**. Se aparecer **Aguardando aprovação**, revise os argumentos e aprove no painel. Confirme em **Execuções** que o trabalho terminou com sucesso e que o resultado corresponde à URL solicitada. A página de exemplo deve apresentar a identificação **Example Domain**. A [referência de navegação](https://playwright.dev/mcp/tools/navigation) descreve a ferramenta; se a versão instalada anunciar outro schema, use o catálogo real.

No modo padrão, você também deve observar uma janela do navegador na máquina da Ponte. Em modo `--headless`, valide pelo resultado e pelas ferramentas de inspeção anunciadas, sem esperar uma janela.

Na conversa já conectada à Ponte, você pode pedir:

```text
Use bridge_list_tools para encontrar as ferramentas do Playwright.
Confira os schemas, abra https://example.com e informe a URL e o
título observados. Se a Ponte retornar um jobId, acompanhe esse mesmo
trabalho com bridge_job até obter o resultado, sem repetir a navegação.
```

A pesquisa dinâmica é:

```json
{"search":"playwright","limit":50}
```

Se houver `nextOffset`, use-o como `offset` para obter a página seguinte. Chame o nome completo retornado diretamente ou por `bridge_call`, com os argumentos do schema. Caso o cliente mantenha um catálogo antigo, atualize as ferramentas do plugin ou reconecte o cliente.

O teste está concluído quando houver evidência de **conexão, chamada executada e página observada**. Um card conectado, um `jobId` criado ou uma solicitação enviada não confirmam sozinhos a navegação.

## 4. Ajustar navegador, perfil e diretório

Acrescente as opções desejadas **depois de `@playwright/mcp@latest`**, preservando os argumentos próprios de Windows ou Linux/macOS:

| Objetivo | Argumentos adicionais |
|---|---|
| Executar sem janela, inclusive em Linux sem sessão gráfica | `"--headless"` |
| Selecionar Microsoft Edge | `"--browser", "msedge"` |
| Usar um perfil de sessão em memória | `"--isolated"` |
| Escolher um diretório de perfil persistente | `"--user-data-dir", "CAMINHO_ABSOLUTO_DO_PERFIL"` |

Por exemplo, no Windows com `cmd.exe`, a configuração sem janela fica:

```json
["/d", "/s", "/c", "npx", "-y", "@playwright/mcp@latest", "--headless"]
```

No Linux/macOS com `npx`:

```json
["-y", "@playwright/mcp@latest", "--headless"]
```

As opções estão na [referência de configuração](https://playwright.dev/mcp/configuration/options). O perfil padrão do MCP preserva o estado entre sessões. Em `--isolated`, cookies e logins daquela sessão são perdidos ao fechar o navegador; não combine essa opção com `--user-data-dir`. Um perfil persistente não deve ser aberto por dois processos ao mesmo tempo. Veja [Profile & State](https://playwright.dev/mcp/configuration/user-profile).

Para controlar abas já abertas, siga a configuração separada de [conexão a navegadores existentes](https://playwright.dev/mcp/configuration/browser-extension). Cadastrar o MCP básico não seleciona automaticamente as abas do navegador que você já utiliza.

### Arquivos e ambiente do processo

Se o fluxo usa arquivos locais, informe em **Diretório de trabalho** uma pasta existente da máquina da Ponte, como `C:\Projetos\meu-site` ou `/home/usuario/projetos/meu-site`. Campo vazio faz o processo herdar o diretório em que a Ponte foi iniciada.

O cadastro em **Projetos** não define automaticamente o diretório do Playwright nem é enviado como uma lista de pastas MCP para esse upstream. As permissões **Permitir escrita** e **Permitir comandos** se aplicam às ferramentas locais da Ponte; não bloqueiam as operações próprias do navegador. A aprovação de ferramentas e a lista de ferramentas expostas controlam as solicitações encaminhadas ao Playwright.

O processo stdio recebe um ambiente mínimo, mais as entradas de **Variáveis de ambiente (JSON)**. Se o navegador com janela funciona no terminal Linux, mas falha pela Ponte, confira as variáveis da sessão gráfica. Por exemplo, quando `DISPLAY` existir no ambiente que inicia a Ponte:

```json
{"DISPLAY":"${DISPLAY}"}
```

A referência é resolvida no processo da Ponte. Uma variável ausente provoca erro; defini-la em outro terminal depois de iniciar o serviço não atualiza o ambiente já em execução. Para um teste sem dependência de sessão gráfica, use `--headless`.

## 5. Definir aprovações e ferramentas expostas

O cadastro inicial usa `readOnlyTools: []`. Assim, no modo padrão **Aprovar alterações e comandos** (`mutations`), todas as ferramentas do Playwright aguardam aprovação, inclusive as anunciadas pelo servidor como leitura. A Ponte só classifica como leitura os nomes declarados explicitamente no seu cadastro.

| Política em **Visão geral → Você no controle** | Efeito |
|---|---|
| Aprovar alterações e comandos (`mutations`) | Leituras declaradas podem executar diretamente; as demais aguardam revisão. |
| Aprovar todas as solicitações (`all`) | Exige revisão também das leituras declaradas. |
| Aprovar automaticamente todas (`automatic`) | Libera solicitações válidas, inclusive pendentes válidos, para os clientes autorizados. |

A pausa e as ferramentas permitidas continuam valendo em modo automático. A política é global para a Ponte, não exclusiva desta conexão.

Em **Ferramentas de leitura** e **Ferramentas permitidas**, informe **nomes originais exatos do servidor**, um por linha, sem o prefixo/hash da Ponte. Confira o comportamento antes de marcar uma ferramenta como leitura: uma ferramenta que executa código ou envia dados em uma página pode produzir efeitos além da consulta.

**Limitar ferramentas expostas** desmarcado expõe todas as ferramentas descobertas; marcado com lista vazia expõe nenhuma. A classificação de leitura e a limitação do catálogo são controles independentes. Veja [SEGURANCA.md](SEGURANCA.md).

## 6. Entender os prazos e recuperar resultados

| Prazo | O que controla |
|---|---|
| **Timeout por chamada** da conexão | As operações com o servidor upstream, incluindo conexão, descoberta e chamadas. O schema aceita `100` a `120000` ms; este guia configura `120000`. |
| Limite do executor da Ponte | Um job em execução tem limite de 120 segundos. |
| Espera inicial do chat | Até 25 segundos por um job na fila ou em execução. `pending_approval` retorna imediatamente. |
| `bridge_job` com `waitMs` | Aguarda o mesmo job por até 25000 ms, inclusive enquanto precisa de aprovação. O padrão `0` consulta imediatamente. |

Os timeouts internos do Playwright também continuam valendo; aumentar o campo da Ponte não altera automaticamente os limites de ações e navegações do navegador.

Se a chamada retornar `jobId`, acompanhe-o com `bridge_job` e `waitMs: 25000` em vez de repetir a ferramenta. Após timeout, cancelamento ou desconexão, confira o navegador e o resultado antes de reenviar: a ação externa pode ter continuado, e a Ponte não a reenvia automaticamente.

Para acompanhamento durante o turno, veja [WATCHERS.md](WATCHERS.md). Clientes compatíveis podem usar [MCP-EVENTS.md](MCP-EVENTS.md) para avisos de conclusão de jobs. A aprovação automática não cria uma assinatura de eventos, e uma espera ou um watcher não reabre uma conversa encerrada.

## 7. Distinguir conexão local, HTTPS e credenciais

O cadastro **stdio** deste guia não precisa de URL nem de token do Playwright. **Cabeçalhos HTTP** não autenticam um processo stdio.

| Conexão | Onde configurar |
|---|---|
| Ponte → Playwright local por stdio | **Conexões MCP**, com comando e argumentos deste guia. |
| Chat → Ponte local por stdio | **Conectar IA**, usando a configuração de cliente gerada pela Ponte e mantendo o serviço iniciado. |
| Chat remoto → Ponte | **Conectar IA**, com a origem HTTPS da API e a autenticação descrita em [CHATGPT.md](CHATGPT.md) ou [CLAUDE.md](CLAUDE.md). |

O token de administração abre o painel. O token de API é usado nos fluxos Bearer, como GPT Actions; conexões OAuth usam as credenciais emitidas nesse fluxo. Adicionar Playwright não exige reutilizar nenhum desses tokens nos campos do upstream.

Se você já mantém o Playwright como servidor HTTP, o [modo standalone oficial](https://github.com/microsoft/playwright-mcp#standalone-mcp-server) usa `--port 8931` e o endpoint `http://localhost:8931/mcp`. Nesse caso, escolha **HTTP — Streamable HTTP** no painel e informe o endpoint MCP em **URL do servidor**. O processo HTTP precisa estar iniciado separadamente.

A Ponte aceita HTTP apenas em endereços locais de loopback e exige HTTPS para upstreams remotos. Se o serviço HTTP tiver autenticação, use as credenciais dele em **Cabeçalhos HTTP (JSON)**, conforme [examples/upstream-http.json](../examples/upstream-http.json). A URL do upstream é a do servidor MCP, não a página que você pretende automatizar.

## 8. Resolver problemas

### Primeiro download ou inicialização demorou

Para preparar o pacote npm e conferir suas opções, execute uma vez fora da Ponte:

**PowerShell**

```powershell
npx.cmd -y @playwright/mcp@latest --help
```

**Linux/macOS**

```bash
npx -y @playwright/mcp@latest --help
```

Aguarde o comando terminar e clique em **Reconectar** no card. `--help` verifica a inicialização do pacote e mostra as opções; não comprova a instalação ou abertura do navegador. A primeira navegação ainda pode precisar baixá-lo.

Não mantenha uma segunda instância stdio aberta em outro terminal para “ajudar” a conexão: o processo iniciado pela Ponte usa seus próprios canais de entrada e saída.

### Outros diagnósticos

| Sintoma | Verificação e próximo passo |
|---|---|
| Comando não encontrado | Confira Node/npm e o `PATH` do processo da Ponte. Reinicie a Ponte depois de corrigir o ambiente ou configure o caminho absoluto do executável. |
| Erro ao salvar argumentos | Use um array JSON de strings. Separe executável e argumentos; mantenha as barras invertidas escapadas em caminhos dentro de JSON. |
| Diretório não encontrado | Corrija **Diretório de trabalho** para uma pasta absoluta existente ou deixe o campo vazio para o teste inicial. |
| Conectado, mas o navegador não abre | Leia o resultado do job. Confira downloads, navegador escolhido e dependências exigidas pelo sistema; em Linux sem sessão gráfica use `--headless`. |
| Perfil já em uso | Encerre a outra instância que usa o perfil ou configure `--isolated`/um diretório de perfil distinto. |
| Zero ferramentas | Confira **Limitar ferramentas expostas** e os nomes originais permitidos. |
| Ferramenta ou schema mudou | Atualize o catálogo e revise a chamada com o schema atual. Uma atualização de `@latest` pode mudar a interface do servidor. |
| Job aguarda aprovação | Revise no painel. A aprovação pendente expira após 15 minutos; uma consulta de status não aprova a chamada. |
| MCP HTTP recusa autenticação | Confira a URL, os cabeçalhos do serviço e as variáveis de ambiente referenciadas. Não use o token de administração da Ponte como credencial de outro servidor. |
| Falha genérica de comunicação | A Ponte resume o erro de conexão e não captura o stderr do upstream para exibição no card. O teste com `--help` pode revelar erros de inicialização; depois reteste uma única chamada pelo painel. |

## Escopo da validação

Os campos e o parser foram conferidos no [painel](../public/app.js), os limites no [schema](../src/core/config.ts), o transporte e o ambiente no [agregador MCP](../src/mcp/hub.ts), e o acompanhamento no [gateway](../src/mcp/server.ts) e no [executor de trabalhos](../src/core/jobs.ts).

Esta revisão documental não instalou o Playwright MCP, baixou navegadores ou executou automação no computador do usuário. Também não comprova a disponibilidade de navegador, sessão gráfica ou dependências do sistema naquele ambiente. O procedimento da seção 3 verifica a instalação real depois de salvar a conexão. Consulte [VALIDACAO.md](VALIDACAO.md) para o alcance dos testes da Ponte.
