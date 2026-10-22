# Guia para iniciantes — instalar e usar a Ponte MCP

Este guia foi escrito para quem **não é desenvolvedor**, não sabe o que é MCP ou nunca instalou um projeto pelo terminal.

Se você consegue copiar um comando, colar no PowerShell e seguir uma sequência de telas, consegue instalar a Ponte.

> [!IMPORTANT]
> Este guia usa **Windows 10/11** como exemplo principal. No final há uma seção curta para macOS/Linux.

---

## 1. O que você vai conseguir fazer

Ao terminar, você terá:

1. a Ponte MCP rodando no seu computador;
2. um painel aberto no navegador;
3. pelo menos uma pasta do seu computador cadastrada como projeto;
4. um teste local confirmado;
5. opcionalmente, o ChatGPT conectado à Ponte.

A instalação local não exige que você entenda OAuth, JSON Schema, Events ou watchers. Esses recursos ficam para depois.

---

## 2. Como a Ponte funciona

A Ponte fica aberta no seu PC e oferece ferramentas para um chat.

```text
Você
 │
 ▼
ChatGPT / Claude / Gemini / Grok
 │
 ▼
Ponte MCP
 │
 ├─ lê arquivos autorizados
 ├─ altera arquivos quando permitido
 ├─ executa comandos quando permitido
 └─ usa outros MCPs, como Roblox e Playwright
```

A Ponte não entrega automaticamente acesso ao computador inteiro.

Você cadastra as pastas que quer disponibilizar e escolhe se cada projeto pode:

- apenas ser lido;
- receber alterações;
- executar comandos.

---

## 3. O que você precisa instalar

### Obrigatório

- Windows 10 ou 11;
- navegador;
- Node.js 22.12.0 ou superior;
- a pasta da Ponte MCP.

### Opcional

- Git, se quiser atualizar por `git pull`;
- ngrok ou outro túnel HTTPS, se quiser conectar um chat que roda na internet;
- Roblox Studio, Playwright ou outros MCPs, conforme o que pretende fazer.

---

# Parte A — instalação local

## 4. Instale o Node.js

Abra:

<https://nodejs.org/>

Baixe a versão **LTS** e instale normalmente.

Durante a instalação, mantenha as opções padrão.

### Verificação

Abra o menu Iniciar, procure por:

```text
PowerShell
```

e abra.

Digite:

```powershell
node --version
```

### Deu certo se…

Aparecer uma versão igual ou superior a `v22.12.0`.

Exemplo:

```text
v24.11.0
```

### Se aparecer “node não é reconhecido”

1. Feche o PowerShell.
2. Abra novamente.
3. Tente outra vez.
4. Se ainda falhar, reinicie o Windows.
5. Se continuar falhando, reinstale o Node.js LTS.

---

## 5. Baixe a Ponte

### Método recomendado para iniciantes: ZIP

Abra:

<https://github.com/V1yn1/ponte-mcp>

Clique em:

**Code → Download ZIP**

Depois:

1. abra a pasta Downloads;
2. clique com o botão direito no ZIP;
3. escolha **Extrair tudo**;
4. mova a pasta extraída para um local permanente.

Exemplo recomendado:

```text
C:\PonteMCP
```

O nome exato da pasta não importa.

### Como saber se abriu a pasta correta

Dentro dela deve existir:

```text
package.json
README.md
src
docs
```

Se você estiver vendo outro ZIP dentro da pasta, ainda não extraiu corretamente.

---

## 6. Abra o terminal na pasta correta

Abra no Explorador de Arquivos a pasta que contém `package.json`.

Na barra de endereço, apague o caminho, digite:

```text
powershell
```

e pressione Enter.

Uma janela azul/preta deve abrir já nessa pasta.

### Confirme a pasta

Execute:

```powershell
Get-ChildItem package.json
```

### Deu certo se…

O PowerShell mostrar o arquivo `package.json`.

Se disser que o arquivo não existe, feche o terminal e abra novamente na pasta correta.

---

## 7. Baixe as dependências da Ponte

Execute:

```powershell
npm.cmd ci --ignore-scripts
```

Esse passo pode baixar vários arquivos. É normal.

### Deu certo se…

O terminal terminar o comando e voltar a aceitar texto, sem uma mensagem final de erro.

Alguns avisos do npm podem aparecer sem impedir a instalação.

---

## 8. Compile a Ponte

Execute:

```powershell
npm.cmd run build
```

### Deu certo se…

O comando terminar sem erro do TypeScript.

Você não precisa abrir a pasta `dist`; ela é criada para o programa.

---

## 9. Crie a configuração inicial

Execute:

```powershell
npm.cmd run setup
```

Esse comando cria o estado privado da instalação.

A pasta principal usada para isso é:

```text
.ponte
```

Ela pode conter:

- configuração;
- tokens;
- autorizações;
- watchers;
- backups.

> [!WARNING]
> Não publique, compartilhe nem envie a pasta `.ponte` para o GitHub.

---

## 10. Inicie a Ponte

Execute:

```powershell
npm.cmd start
```

### Deu certo se…

Você vir algo parecido com:

```text
Ponte MCP pronta.
Painel: http://127.0.0.1:4317
MCP: http://127.0.0.1:4318/mcp
```

**Não feche essa janela.**

Enquanto ela estiver aberta, a Ponte está rodando.

---

## 11. Abra o painel

No navegador, abra:

<http://127.0.0.1:4317>

Aparecerá a tela de login da Ponte.

Se o navegador disser que não conseguiu acessar:

1. volte ao terminal;
2. confirme que `npm.cmd start` ainda está aberto;
3. veja se apareceu algum erro;
4. tente abrir a URL novamente.

---

## 12. Pegue o token do painel

Abra **outro PowerShell**, sem fechar a Ponte.

Vá até a mesma pasta ou abra o terminal nela novamente.

Execute:

```powershell
node dist/cli.js token admin
```

O terminal mostrará uma sequência longa de letras e números.

Copie e cole no login do painel.

### O que é esse token?

É a senha do painel local.

Ele não é:

- chave da OpenAI;
- chave da Gemini;
- senha do Windows;
- token de um MCP externo.

É apenas a credencial administrativa da sua Ponte.

---

# Parte B — testar antes de conectar qualquer chat

## 13. Faça o teste mais simples

No painel:

1. clique em **Ferramentas**;
2. procure `local_projects`;
3. abra;
4. mantenha os argumentos como:

```json
{}
```

5. clique em **Enviar solicitação**.

### Deu certo se…

O resultado mostrar uma lista contendo um projeto chamado `principal`.

Nesse ponto, a instalação local está pronta.

---

## 14. Cadastre uma pasta sua

Abra:

**Projetos → Adicionar projeto**

Preencha, por exemplo:

```text
Nome: Meu projeto
Identificador: meu-projeto
Diretório raiz: C:\Users\SeuNome\Documents\MeuProjeto
```

### Permitir escrita

Marque se quiser que as ferramentas possam alterar/criar arquivos.

### Permitir comandos

Marque somente quando realmente precisar executar programas ou comandos dentro desse projeto.

Para o primeiro uso, é seguro deixar **Permitir comandos** desligado.

---

## 15. Entenda a aprovação antes de usar IA

Em:

**Visão geral → Você no controle**

comece com:

**Aprovar alterações e comandos**

Isso significa:

- leituras podem acontecer normalmente;
- ações que alteram arquivos ou executam comandos passam pela sua revisão.

É a opção mais amigável para aprender como a Ponte se comporta.

---

# Parte C — conectar ao ChatGPT

Você pode parar aqui se só queria testar a Ponte localmente.

Para o ChatGPT web acessar o seu PC, ele precisa chegar à API da Ponte por HTTPS.

A OpenAI documenta o uso de um servidor MCP público ou de um túnel durante o desenvolvimento:
<https://developers.openai.com/api/docs/guides/custom-mcp-server>

## 16. Entenda por que existe um túnel

Seu navegador consegue acessar:

```text
http://127.0.0.1:4318
```

porque ele está no mesmo PC.

Os servidores do ChatGPT estão na internet e não conseguem acessar diretamente o `127.0.0.1` do seu computador.

Um túnel cria um endereço parecido com:

```text
https://alguma-coisa.ngrok-free.app
```

e encaminha esse endereço até a porta 4318 do seu PC.

O painel da porta 4317 deve continuar local.

---

## 17. Exemplo usando ngrok

Instale o ngrok pelo guia oficial:

<https://ngrok.com/docs/getting-started/>

Depois, com a Ponte já aberta, execute em outro terminal:

```powershell
ngrok http 4318
```

### Deu certo se…

O ngrok mostrar uma linha parecida com:

```text
Forwarding https://abcd.ngrok-free.app -> http://localhost:4318
```

Copie somente a parte HTTPS:

```text
https://abcd.ngrok-free.app
```

> [!NOTE]
> Dependendo do plano e da configuração do túnel, a URL pode mudar ao reiniciar o ngrok.

---

## 18. Informe a URL pública à Ponte

No painel:

**Conectar IA → URL pública da API**

Cole:

```text
https://abcd.ngrok-free.app
```

Não cole:

```text
https://abcd.ngrok-free.app/mcp
```

O campo pede somente a origem.

Depois de salvar, a Ponte monta a URL MCP:

```text
https://abcd.ngrok-free.app/mcp
```

---

## 19. Cadastre no ChatGPT

No ChatGPT web:

1. abra **Plugins**;
2. clique em **+**;
3. escolha **Add custom MCP server**;
4. use o nome `Ponte`;
5. cole a URL terminada em `/mcp`;
6. escolha OAuth;
7. conclua a criação do plugin.

A OpenAI documenta esse fluxo aqui:

<https://developers.openai.com/api/docs/guides/custom-mcp-server>

---

## 20. Autorize a conexão

Quando o ChatGPT iniciar OAuth, a Ponte abrirá uma página de autorização com um código.

No painel local:

1. vá em **Conectar IA**;
2. encontre **Solicitações de conexão**;
3. abra a solicitação;
4. compare os códigos;
5. confira o nome do cliente;
6. autorize.

### Regra importante

Autorize apenas quando:

- você iniciou a conexão;
- o código é igual;
- a URL de retorno faz sentido.

---

## 21. Instale/ative o plugin e faça o teste

Depois de concluir a autorização:

1. abra o plugin criado no ChatGPT;
2. instale/ative;
3. abra uma conversa compatível;
4. digite `@` e selecione a Ponte.

Teste:

```text
Use a Ponte e consulte bridge_status.
```

Depois:

```text
Use a Ponte para listar meus projetos.
```

### Deu certo se…

O ChatGPT fizer uma chamada de ferramenta e mostrar os dados reais da sua instalação.

---

# Parte D — depois que o básico funcionar

## 22. Roblox Studio

Leia:

[Roblox Studio](ROBLOX.md)

Resumo:

1. abra o Roblox Studio;
2. habilite o Studio como servidor MCP;
3. na Ponte, use o preset Roblox;
4. confirme o status **Conectado**;
5. só então teste as ferramentas do Studio.

---

## 23. Playwright

Leia:

[Playwright MCP](PLAYWRIGHT.md)

Ele permite que a Ponte use um navegador para abrir páginas, clicar, preencher formulários e fazer testes.

---

## 24. Gemini e Grok

O painel já oferece abas específicas.

- [Gemini](GEMINI.md)
- [Grok](GROK.md)

Não comece por essas integrações se a instalação local ainda não passou no teste `local_projects`.

---

# Parte E — o que fazer toda vez que ligar o computador

Você não precisa reinstalar.

Abra a pasta da Ponte e execute:

```powershell
npm.cmd start
```

Se estiver usando um túnel como ngrok, abra também o túnel:

```powershell
ngrok http 4318
```

Se a URL pública mudar, atualize **Conectar IA → URL pública da API**.

---

# Parte F — atualização

## Se você instalou com Git

Pare a Ponte com:

```text
Ctrl+C
```

Faça uma cópia privada da pasta `.ponte`.

Depois:

```powershell
git pull --ff-only
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd start
```

## Se você instalou por ZIP

Não simplesmente apague a instalação antiga.

Leia:

[Atualizar sem perder a configuração](OPERACAO.md#atualizar-sem-perder-a-configuração)

A pasta `.ponte` é o ponto mais importante a preservar.

---

# Parte G — solução de problemas

## “npm não pode ser carregado porque a execução de scripts foi desabilitada”

Use:

```powershell
npm.cmd
```

em vez de:

```powershell
npm
```

Exemplo:

```powershell
npm.cmd start
```

O guia usa `npm.cmd` justamente para evitar essa dificuldade comum no PowerShell.

---

## “package.json não encontrado”

Você abriu o terminal na pasta errada.

Volte ao Explorador, localize a pasta que contém `package.json` e abra o terminal nela.

---

## O terminal fecha ou a Ponte para

A Ponte precisa ficar rodando em uma janela aberta.

Se você fechar a janela de `npm.cmd start`, o serviço para.

Para iniciar de novo:

```powershell
npm.cmd start
```

---

## O painel abre, mas o ChatGPT não conecta

Isso é uma boa notícia: a instalação local provavelmente está correta.

Confira:

1. túnel aberto;
2. túnel apontando para `4318`;
3. URL pública atual salva no painel;
4. URL do plugin terminando em `/mcp`;
5. OAuth concluído;
6. plugin instalado/ativado.

---

## O painel não aceita o token

Gere novamente no mesmo diretório de estado:

```powershell
node dist/cli.js token admin
```

Se você tem mais de uma cópia da Ponte no computador, pode estar pegando o token da instalação errada.

---

## Uma ação está “Aguardando aprovação”

Isso não é erro.

Abra **Execuções**, revise a solicitação e escolha aprovar ou recusar.

---

## Uma ferramenta externa não aparece

Primeiro confirme se o servidor aparece como **Conectado** em **Conexões MCP**.

Depois atualize o catálogo no cliente ou use a descoberta dinâmica da Ponte.

---

# Parte H — glossário sem jargão

### API
Uma porta de comunicação usada por outro programa.

### OAuth
Forma de autorizar uma conexão sem copiar sua senha para o outro serviço.

### MCP
Padrão usado por chats para descobrir e chamar ferramentas.

### Projeto
Pasta que você autorizou a Ponte a usar.

### Upstream / servidor MCP
Outra ferramenta conectada à Ponte, como Roblox Studio ou Playwright.

### Job / execução
Uma chamada de ferramenta registrada pela Ponte.

### Watcher / acompanhamento
Registro que a Ponte mantém enquanto espera uma tarefa externa terminar.

### Events
Avisos enviados por webhook a clientes compatíveis. É recurso avançado; não é necessário para instalar.

---

# Parte I — qual documento ler agora?

Se você acabou de instalar:

1. faça o teste `local_projects`;
2. adicione uma pasta em **Projetos**;
3. mantenha a política padrão;
4. conecte apenas o cliente que realmente vai usar.

Depois escolha:

| Objetivo | Documento |
|---|---|
| Operar, atualizar ou recuperar a instalação | [Operação](OPERACAO.md) |
| Conectar ChatGPT | [ChatGPT](CHATGPT.md) |
| Conectar Claude | [Claude](CLAUDE.md) |
| Conectar Gemini | [Gemini](GEMINI.md) |
| Conectar Grok | [Grok](GROK.md) |
| Conectar Roblox Studio | [Roblox](ROBLOX.md) |
| Conectar Playwright | [Playwright](PLAYWRIGHT.md) |
| Entender permissões | [Segurança](SEGURANCA.md) |
| Usar recursos avançados | [Índice completo](README.md) |

---

## Checklist final

Use esta lista para confirmar a instalação:

- [ ] `node --version` funciona.
- [ ] `npm.cmd ci --ignore-scripts` terminou.
- [ ] `npm.cmd run build` terminou.
- [ ] `npm.cmd run setup` criou a configuração.
- [ ] `npm.cmd start` mostra “Ponte MCP pronta”.
- [ ] <http://127.0.0.1:4317> abre.
- [ ] O token `admin` permite entrar no painel.
- [ ] `local_projects` funciona no painel.
- [ ] Sua pasta real está cadastrada em **Projetos**.
- [ ] Se usa ChatGPT web, o túnel da porta 4318 está ativo.
- [ ] A URL pública atual está salva em **Conectar IA**.
- [ ] A conexão OAuth foi confirmada pelos códigos.
- [ ] `bridge_status` funciona no chat.

Se os oito primeiros itens estão marcados, **a instalação local está pronta**, mesmo que você ainda não tenha conectado nenhum chat.
