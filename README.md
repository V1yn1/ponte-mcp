# Ponte MCP

**Dê ao seu chat ferramentas para trabalhar nos seus projetos e no Roblox Studio, por uma única ponte local.**

Ponte MCP é um servidor local com painel em português. Ele reúne ferramentas de arquivos, execução de comandos e servidores MCP externos. O chat escolhe uma ferramenta; a ponte valida a solicitação, apresenta alterações para revisão quando necessário e devolve o resultado.

Esta é a versão **0.2.1**, destinada a uso pessoal em um computador. Ela oferece OAuth para conectar a fachada MCP ao ChatGPT, com autorização no painel local e conexões revogáveis. Esta atualização corrige a consulta de aprovação por túneis como o ngrok e mostra erros de conexão na página de consentimento. O projeto inclui código TypeScript completo, frontend, testes, build e exemplos de integração. Não contém modelo de IA, assinatura, chave de fornecedor ou instalador proprietário.

## O que está implementado

| Área | Recursos |
|---|---|
| Projetos | Cadastro de pastas, permissão de escrita e ativação explícita de comandos por projeto |
| Arquivos | Listagem, leitura UTF-8, busca literal, criação de pastas, gravação completa e substituição de trecho exato |
| Revisão | Diff, SHA-256 esperado, cópia de segurança antes da substituição, aprovação por trabalho |
| Terminal | Executável e argumentos separados, diretório do projeto, limite de tempo e saída, cancelamento |
| MCPs | Clientes stdio, Streamable HTTP e SSE legado; descoberta de ferramentas, namespaces e reconexão |
| Roblox | Preset do servidor MCP integrado oficialmente ao Studio |
| Conexão com chats | MCP Streamable HTTP com OAuth, adaptador stdio e API REST com OpenAPI para Actions |
| OAuth | Authorization code com PKCE S256, descoberta, cadastro dinâmico de clientes, renovação e revogação |
| Painel | Visão geral, projetos, conexões, ferramentas, execuções e aprovação das conexões do ChatGPT |
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

A versão mostrada no painel deve ser **0.2.1**. Após atualizar, cancele a tentativa de conexão OAuth antiga no ChatGPT e comece outra: os pedidos em andamento não sobrevivem ao reinício do serviço. Mantenha o ngrok encaminhando a porta da API, **4318**, e confira se a URL pública salva no painel corresponde ao endereço atual do túnel. O roteiro específico está em [Conectar ao ChatGPT](docs/CHATGPT.md).

### Instalações por ZIP e atualização da versão 0.1.0

Encerre a ponte antiga com `Ctrl+C` e faça uma cópia privada do diretório de estado antes de substituir os arquivos do programa. Preserve a pasta `.ponte`: ela contém os projetos cadastrados, credenciais e backups. Na mesma pasta de instalação, execute novamente `npm.cmd ci --ignore-scripts` e `npm.cmd run build`, depois inicie o serviço.

Se extrair a nova versão em outra pasta, aponte explicitamente para o estado antigo:

```powershell
node dist/cli.js start --state-dir "C:\Projetos\ponte-mcp-antiga\.ponte"
```

Use esse mesmo `--state-dir` nos comandos `token`, `doctor` e na configuração stdio. Por padrão, o estado fica em `.ponte` **dentro da pasta da instalação**, independentemente da pasta atual do terminal. `PONTE_STATE_DIR` também pode definir o caminho; `--state-dir` tem precedência. Não inicie duas versões usando o mesmo estado.

Os clientes stdio, Actions e MCP com token API continuam funcionando. O fluxo nativo de OAuth do ChatGPT cria suas próprias autorizações; não exige substituir os tokens existentes. Veja o passo a passo em [Conectar ao ChatGPT](docs/CHATGPT.md).

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

Abra a solicitação em **Execuções**, confira o diff e aprove. O arquivo aparecerá na pasta do projeto. Depois use `local_read_file` com o mesmo `projectId` e `path`.

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

Inicie a ponte e copie a configuração stdio da aba **Conectar ChatGPT**, em **Clientes locais e GPT Actions**. Um exemplo, adaptando os caminhos:

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

O caminho HTTP da versão 0.2.1 usa **OAuth com cadastro dinâmico de cliente (DCR)**. Você autoriza a conexão no seu computador; o ChatGPT recebe credenciais OAuth próprias e renováveis.

1. Inicie a ponte e encaminhe **toda a API da porta 4318** por uma origem HTTPS estável. O encaminhamento precisa atender `/mcp` e os endpoints de descoberta e OAuth. Mantenha a porta 4317 exclusivamente local.
2. Em **Conectar ChatGPT**, salve a origem HTTPS em **URL pública da API**, por exemplo `https://sua-ponte.exemplo.com`, sem `/mcp`.
3. No ChatGPT, abra **Plugins → + → Add custom MCP server**. Informe `https://sua-ponte.exemplo.com/mcp`, escolha **OAuth** e deixe as credenciais de cliente vazias. Se houver escolha de registro, selecione **DCR**.
4. Quando o fluxo de autorização abrir a página da Ponte, confira o código de verificação de oito caracteres. No painel local, abra **Conectar ChatGPT**, encontre o mesmo código, revise a solicitação e autorize.
5. Volte à página de autorização. Ela retorna automaticamente ao ChatGPT após a aprovação. Conclua **Create as a plugin**, instale o plugin e selecione-o com `@` em uma conversa.
6. Peça: `Use a Ponte para consultar bridge_status e listar os projetos disponíveis.`

O token de administração fica no painel local. A autorização da conexão não aprova futuras escritas ou comandos: essas operações continuam passando pelas permissões dos projetos e pela revisão de cada trabalho.

O roteiro completo, testes de descoberta e solução de problemas estão em [docs/CHATGPT.md](docs/CHATGPT.md). A implementação pode ser verificada localmente; **a conexão com uma conta real do ChatGPT ainda precisa ser validada no seu ambiente**. A disponibilidade de MCP e as permissões para adicionar plugins dependem da conta e do workspace. A documentação oficial também prevê Secure MCP Tunnel; veja [outras opções de conexão](docs/INTEGRACOES.md).

### GPT personalizado com Actions

1. Encaminhe **somente a porta 4318** por um túnel HTTPS confiável, configurado por você. Mantenha o painel da porta 4317 local.
2. Salve a origem HTTPS em **Conectar ChatGPT → URL pública da API**. Exemplo: `https://sua-ponte.exemplo.com`, sem `/mcp`.
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

Defina `MEU_SERVICO_TOKEN` no ambiente do processo da ponte. Uma mudança na variável requer reiniciar o processo. O formulário preserva credenciais omitidas durante a edição. `allowedTools` pode limitar os nomes originais expostos. `readOnlyTools` é uma lista explícita de ferramentas que você autoriza executar automaticamente como leitura; não coloque ferramentas com efeitos colaterais nessa lista.

MCPs stdio são programas executados com a conta do usuário. Instale e conecte programas em que você confia. O agregador não isola processos de terceiros.

## Fluxo das operações

1. O cliente consulta o catálogo.
2. A ponte valida argumentos e permissões.
3. Leitura local pode executar imediatamente; alterações aguardam revisão.
4. O usuário aprova os argumentos exatos no painel.
5. A ponte executa e armazena o resultado em memória.
6. O chat consulta o trabalho e usa o resultado na resposta.

`bridge_job` acompanha solicitações MCP. A API REST devolve um `id` consultável por `getJob`. `bridge_call` e a API aceitam `idempotencyKey`. Reenvios com a mesma chave e os mesmos argumentos recuperam o trabalho existente enquanto ele estiver retido; não reaproveite a chave para uma operação diferente.

## Configuração, cópias de segurança e histórico

O diretório `.ponte` é criado somente na instalação local e fica fora do pacote:

- `config.json`: projetos, portas e MCPs.
- `secrets.json`: dois tokens aleatórios distintos.
- `oauth.json`: clientes registrados e autorizações OAuth, incluindo segredos de clientes e hashes dos tokens.
- `audit.jsonl`: metadados das execuções, sem argumentos, códigos ou resultados.
- `backups/ID.bak`: conteúdo anterior de arquivos substituídos.

O resultado da escrita informa `backupId`. Para restaurar, identifique a cópia correspondente e substitua o arquivo manualmente após revisar seu conteúdo. Não há botão de desfazer nesta versão.

Trabalhos e resultados são voláteis e limitados. Reiniciar a ponte não reexecuta trabalhos antigos. A auditoria permanece, mas não recupera resultados completos. Aprovações de trabalhos expiram após 15 minutos. Ações em execução têm limite de 120 segundos; os limites específicos de cada ferramenta podem ser menores. Cancelar ou receber timeout não garante que um serviço externo desfez a operação.

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

- Uso pessoal, com um único proprietário. Todas as conexões OAuth usam o mesmo conjunto de projetos e políticas; não há isolamento por usuário ou por conexão.
- Acesso a arquivos é restrito às pastas cadastradas; **terminal e MCPs externos não são sandboxes do sistema operacional**.
- O proxy cobre ferramentas MCP. Resources, prompts, sampling, elicitation e login OAuth interativo de upstreams não são encaminhados.
- Reconexão é manual. A ponte nunca repete uma operação externa automaticamente.
- Não há captura genérica de desktop, controle de mouse fora do MCP conectado, processo autônomo de planejamento ou serviço Windows instalado.
- Não inclui LLM local; pode ser conectado a um cliente compatível que use modelos locais.
- Consulte `docs/VALIDACAO.md` para os testes efetivamente executados. A integração com Windows, Studio real e sua conta do ChatGPT precisa ser validada no seu computador; publicar a URL e configurar a conta são etapas de implantação.

Consulte `docs/VALIDACAO.md` para o resultado observado na entrega e `docs/SEGURANCA.md` para os limites de confiança.
