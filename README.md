# Ponte MCP

**Conecte ChatGPT, Claude, Gemini ou Grok às ferramentas do seu computador sem precisar entender MCP por dentro.**

A Ponte MCP roda **no seu próprio computador**. Ela cria um painel local onde você escolhe quais pastas e ferramentas a IA pode usar, acompanha o que está acontecendo e decide quando uma ação precisa de aprovação.

> [!TIP]
> **Nunca instalou um projeto pelo terminal?** Sem problema. Este README já traz o caminho mais simples. Se quiser explicações ainda mais detalhadas, com “o que você deve ver” em cada etapa, abra o [Guia para iniciantes](docs/GUIA-INICIANTE.md).

**Versão atual: 0.10.0**

## O que a Ponte faz?

Imagine a Ponte como um intermediário entre o chat e o seu computador:

```text
ChatGPT / Claude / Gemini / Grok
                │
                ▼
            Ponte MCP
                │
       ┌────────┼─────────┐
       ▼        ▼         ▼
   Arquivos   Terminal   Outros MCPs
                         Roblox, Playwright…
```

O chat não recebe acesso irrestrito ao computador. Você cadastra projetos, escolhe permissões e define a política de aprovação no painel.

### Antes de instalar: 5 termos em linguagem simples

| Termo | Significado |
|---|---|
| **Node.js** | Programa necessário para executar a Ponte. Você instala uma vez. |
| **Terminal / PowerShell** | Janela onde você cola os comandos deste guia. |
| **MCP** | Padrão que permite a um chat usar ferramentas externas. Você não precisa programar MCP para usar a Ponte. |
| **Token de administração** | Senha local do painel da Ponte. Não compartilhe esse token. |
| **Túnel HTTPS** | Endereço público temporário usado quando um chat na internet precisa alcançar a Ponte no seu PC. |

---

# Instalação rápida no Windows

Este é o caminho recomendado para quem está instalando pela primeira vez.

## 1. Instale o Node.js

A Ponte precisa de **Node.js 22.12.0 ou superior**.

1. Abra <https://nodejs.org/>.
2. Baixe a versão **LTS**.
3. Instale usando as opções padrão.
4. Depois da instalação, feche e abra novamente o terminal.

### Confirme que funcionou

Abra o **PowerShell** ou **Terminal do Windows** e execute:

```powershell
node --version
```

Você deve ver algo parecido com:

```text
v24.x.x
```

Se aparecer `node não é reconhecido`, reinicie o Windows ou reinstale o Node.js marcando a opção de adicionar ao PATH.

---

## 2. Baixe a Ponte

### Opção mais simples: ZIP

1. No GitHub, clique em **Code → Download ZIP**.
2. Extraia o ZIP para uma pasta permanente, por exemplo:

```text
C:\PonteMCP
```

Evite deixar a instalação dentro do arquivo ZIP ou em uma pasta que você pretende apagar depois.

### Opção para quem já usa Git

```powershell
git clone https://github.com/V1yn1/ponte-mcp.git
cd ponte-mcp
```

Se usou o ZIP, abra a pasta extraída e continue na próxima etapa.

---

## 3. Abra um terminal dentro da pasta da Ponte

No Explorador de Arquivos:

1. Abra a pasta que contém o arquivo `package.json`.
2. Clique com o botão direito em uma área vazia.
3. Escolha **Abrir no Terminal**.

Você também pode clicar na barra de endereço da pasta, digitar:

```text
powershell
```

e pressionar Enter.

> [!IMPORTANT]
> Os comandos seguintes precisam ser executados **na pasta que contém `package.json`**.

---

## 4. Instale as dependências

Cole:

```powershell
npm.cmd ci --ignore-scripts
```

Esse comando baixa as bibliotecas que a Ponte usa.

**Resultado esperado:** o comando termina sem erro e volta a mostrar a linha do PowerShell.

Depois compile:

```powershell
npm.cmd run build
```

**Resultado esperado:** a compilação termina sem mensagens de erro.

---

## 5. Faça a configuração inicial

Execute:

```powershell
npm.cmd run setup
```

Na primeira execução, a Ponte cria uma pasta privada chamada `.ponte` e um projeto de exemplo chamado `principal`.

Você não precisa editar esses arquivos manualmente.

---

## 6. Inicie a Ponte

Execute:

```powershell
npm.cmd start
```

Deixe essa janela aberta enquanto estiver usando a Ponte.

Você deve ver algo semelhante a:

```text
Ponte MCP pronta.
Painel: http://127.0.0.1:4317
MCP: http://127.0.0.1:4318/mcp
```

Agora abra no navegador:

<http://127.0.0.1:4317>

Se a página abrir, **a instalação local está funcionando**.

---

## 7. Entre no painel

O painel pede um token de administração.

Sem fechar a janela onde a Ponte está rodando:

1. Abra **outro terminal** na mesma pasta.
2. Execute:

```powershell
node dist/cli.js token admin
```

3. Copie o valor exibido.
4. Cole no login do painel.

> [!WARNING]
> O token `admin` controla o painel local. Não envie esse token para chats, prints públicos, repositórios ou outras pessoas.

---

# Primeiro teste seguro

Antes de conectar qualquer chat, confirme que a Ponte consegue usar as próprias ferramentas.

1. No painel, abra **Ferramentas**.
2. Procure por `local_projects`.
3. Abra a ferramenta.
4. Use estes argumentos:

```json
{}
```

5. Clique em **Enviar solicitação**.

O resultado deve mostrar pelo menos o projeto `principal`.

Se isso funcionou, você já confirmou:

- a Ponte iniciou;
- o painel está conectado;
- as ferramentas locais estão funcionando.

## Adicione sua pasta real

Abra **Projetos → Adicionar projeto**.

Exemplo:

| Campo | Exemplo |
|---|---|
| Nome | Meu projeto |
| Identificador | `meu-projeto` |
| Diretório raiz | `C:\Users\SeuNome\Documents\MeuProjeto` |
| Permitir escrita | Marque somente se quiser permitir alterações |
| Permitir comandos | Deixe desligado até realmente precisar |

A Ponte não precisa ter acesso ao seu disco inteiro. Prefira adicionar somente as pastas necessárias.

---

# Conectar ao ChatGPT

> [!NOTE]
> A instalação local já funciona sem túnel. O túnel só é necessário quando um serviço na internet, como o ChatGPT web, precisa alcançar a Ponte no seu computador.

O ChatGPT precisa receber uma URL **HTTPS pública** que leve até a porta **4318** da Ponte.

A documentação oficial da OpenAI recomenda expor o servidor MCP por uma URL pública durante o desenvolvimento. Um exemplo simples é o ngrok.

## 1. Crie um túnel para a porta 4318

Instale e configure o ngrok seguindo <https://ngrok.com/docs/getting-started/>.

Depois execute em um terminal:

```powershell
ngrok http 4318
```

O ngrok mostrará um endereço parecido com:

```text
https://abcd-1234.ngrok-free.app
```

Mantenha esse terminal aberto.

## 2. Salve essa URL na Ponte

No painel da Ponte:

1. Abra **Conectar IA**.
2. Em **URL pública da API**, cole somente a origem:

```text
https://abcd-1234.ngrok-free.app
```

3. **Não** coloque `/mcp` nesse campo.
4. Clique em **Salvar**.

A Ponte mostrará a URL MCP completa:

```text
https://abcd-1234.ngrok-free.app/mcp
```

## 3. Adicione a Ponte ao ChatGPT

No ChatGPT web:

1. Abra **Plugins**.
2. Clique em **+**.
3. Escolha **Add custom MCP server**.
4. Nome: `Ponte`.
5. Server URL: use a URL HTTPS terminada em `/mcp`.
6. Em autenticação, escolha **OAuth**.
7. Não invente Client ID ou Client Secret; a Ponte oferece registro automático.
8. Revise o aviso de segurança e crie o plugin.

A documentação oficial da OpenAI para MCP personalizado está em:
<https://developers.openai.com/api/docs/guides/custom-mcp-server>

## 4. Autorize no computador

Durante o OAuth, aparecerá uma página com um código.

No painel local da Ponte:

1. Abra **Conectar IA**.
2. Entre em **Solicitações de conexão**.
3. Confirme que o código é o mesmo.
4. Confira o cliente e a URL de retorno.
5. Autorize.

Depois volte ao ChatGPT para concluir a conexão.

## 5. Teste a conexão

No ChatGPT, selecione a Ponte com `@` e peça:

```text
Use a Ponte e consulte bridge_status.
```

Depois teste:

```text
Use a Ponte para listar meus projetos locais.
```

Se ambos funcionarem, o caminho completo está pronto:

```text
ChatGPT → HTTPS → Ponte → ferramentas do computador
```

---

# Qual política de aprovação escolher?

No painel, abra **Visão geral → Você no controle**.

Para começar, use:

**Aprovar alterações e comandos**

Nesse modo:

- leituras simples podem acontecer diretamente;
- escrita de arquivos e execução de comandos pedem aprovação;
- você consegue revisar cada ação antes de liberar.

Quando já conhecer bem a instalação, você pode escolher outros modos.

---

# Conectar Roblox Studio, Playwright e outros MCPs

Depois da instalação básica funcionar, você pode ampliar a Ponte.

| Quero conectar | Guia |
|---|---|
| Roblox Studio | [Roblox Studio](docs/ROBLOX.md) |
| Navegador com Playwright | [Playwright MCP](docs/PLAYWRIGHT.md) |
| Outro servidor MCP | [MCPs pelo chat](docs/MCPS-PELO-CHAT.md) |
| ChatGPT | [ChatGPT](docs/CHATGPT.md) |
| Claude | [Claude](docs/CLAUDE.md) |
| Gemini | [Gemini](docs/GEMINI.md) |
| Grok | [Grok](docs/GROK.md) |
| Dots | [Dots](docs/DOTS.md) |

Você também pode pedir ao próprio chat para cadastrar um MCP quando a Ponte já estiver conectada.

---

# Problemas comuns

## `node não é reconhecido`

O Node.js não está instalado corretamente ou o terminal ainda não recebeu o PATH novo.

Tente:

1. fechar todos os terminais;
2. abrir novamente;
3. executar `node --version`;
4. se continuar falhando, reinstalar o Node.js LTS.

## `npm.ps1 cannot be loaded`

Use os comandos deste guia com `npm.cmd`, por exemplo:

```powershell
npm.cmd run build
```

Não é necessário mudar a política de execução do PowerShell.

## O painel não abre

Confirme se a janela com:

```powershell
npm.cmd start
```

continua aberta.

Depois tente novamente:

<http://127.0.0.1:4317>

## A porta já está em uso

Outro programa — ou outra instância da Ponte — pode estar usando a porta.

Feche a instância antiga antes de iniciar outra. Não execute duas Pontes usando o mesmo diretório `.ponte`.

## O ChatGPT não consegue conectar

Confirme, nesta ordem:

1. a Ponte continua aberta;
2. o ngrok continua aberto;
3. o túnel aponta para a porta **4318**;
4. a URL salva em **Conectar IA** é a origem HTTPS atual;
5. no ChatGPT você usou a URL com `/mcp`;
6. se a URL do ngrok mudou, salve a nova origem e faça uma nova autorização.

## Não sei se o erro é da Ponte ou do ChatGPT

Faça o teste local primeiro:

- painel abre em `127.0.0.1:4317`;
- `local_projects` funciona no painel.

Se os dois funcionam, a instalação local está boa e o problema provavelmente está no túnel ou na conexão do cliente.

---

# Como iniciar novamente depois de reiniciar o PC

Entre na pasta da Ponte e execute:

```powershell
npm.cmd start
```

Você **não** precisa repetir `npm ci`, `build` ou `setup` toda vez.

Só repita esses passos quando estiver instalando ou atualizando a versão.

---

# Como atualizar

Se instalou por Git:

1. Pare a Ponte com `Ctrl+C`.
2. Faça uma cópia privada da pasta `.ponte`.
3. Execute:

```powershell
git pull --ff-only
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd start
```

Se instalou por ZIP, leia [Atualizar sem perder a configuração](docs/OPERACAO.md#atualizar-sem-perder-a-configuração).

> [!IMPORTANT]
> Não apague a pasta `.ponte` durante uma atualização. Ela contém sua configuração, autorizações e credenciais locais.

---

# Documentação por nível

### Estou começando

- [Guia para iniciantes](docs/GUIA-INICIANTE.md)
- [Índice da documentação](docs/README.md)

### Já instalei e quero configurar

- [Operação e configuração](docs/OPERACAO.md)
- [ChatGPT](docs/CHATGPT.md)
- [Claude](docs/CLAUDE.md)
- [Gemini](docs/GEMINI.md)
- [Grok](docs/GROK.md)

### Quero usar recursos avançados

- [Dots](docs/DOTS.md)
- [MCPs pelo chat](docs/MCPS-PELO-CHAT.md)
- [Watchers](docs/WATCHERS.md)
- [MCP Events](docs/MCP-EVENTS.md)
- [API e ferramentas](docs/API.md)
- [Segurança](docs/SEGURANCA.md)
- [Arquitetura](docs/ARQUITETURA.md)
- [Validação](docs/VALIDACAO.md)

---

# Segurança em uma frase

**A Ponte executa ações no seu computador, então conecte somente clientes e MCPs em que você confia e habilite escrita/comandos apenas nas pastas necessárias.**

A Ponte foi feita para uso pessoal, com um único administrador. Ela não é uma sandbox de sistema operacional e não remove limites, custos ou regras dos provedores de IA.

## Para desenvolver a Ponte

Se você está contribuindo com o projeto, e não apenas instalando:

```sh
npm ci --ignore-scripts
npm run verify
npm run smoke
npm run dev
```

O histórico de alterações está em [CHANGELOG.md](CHANGELOG.md).
