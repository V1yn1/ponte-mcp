# Adicionar Playwright MCP ao painel

A Ponte pode iniciar o servidor oficial Playwright MCP como uma conexão **stdio**. Ele passa a aparecer no mesmo catálogo que os demais MCPs conectados. Este guia usa os campos da Ponte e a documentação oficial consultada em **22 de outubro de 2026**.

## 1. Criar a conexão

Abra **Conexões MCP → Adicionar conexão** e preencha:

| Campo | Valor |
|---|---|
| Nome | `Playwright` |
| Identificador | `playwright` |
| Transporte | `stdio — processo local` |
| Timeout por chamada (ms) | `120000` |
| Comando | `npx` |
| Argumentos (array JSON) | `["-y", "@playwright/mcp@latest"]` |
| Diretório de trabalho | Vazio |
| Ferramentas de leitura | Vazio para começar |
| Limitar ferramentas expostas | Desmarcado para descobrir o catálogo completo |
| Variáveis de ambiente / Cabeçalhos | Vazios |
| Ativar esta conexão ao salvar | Marcado |

Cole somente este array no campo **Argumentos**:

```json
["-y", "@playwright/mcp@latest"]
```

O objeto `mcpServers` dos exemplos de clientes não pertence a esse campo. A Ponte espera um array JSON de strings e recebe o executável no campo **Comando** separado.

Clique em **Salvar conexão** e aguarde **Conectado**, acompanhado da quantidade de ferramentas. O SDK usado pela Ponte resolve `npx` no Windows com `cross-spawn`; não é necessário colocar o comando inteiro no campo Comando.

O Node instalado para rodar a Ponte já atende ao requisito do Playwright MCP. O primeiro uso pode baixar o pacote e o navegador. O modo padrão abre uma janela visível e usa um perfil próprio do Playwright. A documentação oficial está em [Installation](https://playwright.dev/mcp/installation) e no [repositório da Microsoft](https://github.com/microsoft/playwright-mcp).

## 2. Testar

Abra **Ferramentas** e pesquise `browser_navigate`. Escolha a ferramenta do servidor Playwright; seu nome exposto pela Ponte terá o prefixo `playwright__` e um sufixo de identificação.

Envie:

```json
{"url":"https://example.com"}
```

Clique em **Enviar solicitação**. Se a política configurada pedir revisão, aprove o trabalho no painel. Confira o resultado da execução.

Na conversa já conectada à Ponte, você pode pedir:

```text
Use a Ponte para pesquisar as ferramentas do Playwright, abrir
https://example.com e informar o título da página.
```

A conexão existente entre o chat e a Ponte pode usar o novo upstream. Quando o cliente conservar um catálogo antigo, atualize as ferramentas do plugin. A pesquisa dinâmica `bridge_list_tools` também encontra as novas ferramentas com `{"search":"playwright"}`; o chat pode chamar o nome retornado por `bridge_call`.

## 3. Primeiro download demorou

Se o card informar timeout, abra um PowerShell e execute uma vez:

```powershell
npx.cmd -y @playwright/mcp@latest --help
```

Esse comando prepara o pacote, mostra as opções e termina. Aguarde sua conclusão e clique em **Reconectar** no card da Ponte. Não deixe uma segunda instância stdio aguardando entrada em outro terminal.

Se aparecer erro de comando não encontrado, confirme que Node/npm estão instalados e reinicie o processo da Ponte depois de corrigir o PATH. A janela que já estava aberta pode continuar com o ambiente anterior.

## Opções de navegador

Para escolher Microsoft Edge, use:

```json
["-y", "@playwright/mcp@latest", "--browser", "msedge"]
```

Para uma sessão cujo perfil fica somente na memória, a opção é:

```json
["-y", "@playwright/mcp@latest", "--isolated"]
```

No modo isolado, cookies e logins daquela sessão não persistem quando o navegador fecha. O modo de extensão, usado para acessar abas já abertas, é uma configuração separada. As opções atuais estão em [Configuration](https://playwright.dev/mcp/configuration/options).

## Limite da validação deste guia

Os campos, o parser de argumentos, o limite de timeout e o transporte Windows foram conferidos no código e nas dependências da Ponte. A configuração não foi instalada nem executada no computador do usuário durante a elaboração deste guia. O teste da seção 2 confirma a instalação real depois que você salvar a conexão.
