# Ponte Cloud Relay 0.1.0 — preparação para Render

Este módulo adiciona um endereço HTTPS estável à **Ponte local 0.10.0**. Não é
uma nova instalação da Ponte na nuvem: arquivos, ferramentas, autorização OAuth,
watchers e aprovação continuam no computador do usuário.

**Estado desta entrega:** validado em testes de transporte locais. A publicação
na Render e o fluxo real de OAuth até o PC ainda precisam de validação. A
versão do núcleo permanece 0.10.0. Um serviço atende um único computador.

## Publicar

O arquivo [render.yaml](../render.yaml) cria somente um Web Service Free, sem
banco ou disco adicional. A Render gera o segredo `PONTE_RELAY_TOKEN`.

[Configurar o deploy na Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FV1yn1%2Fponte-mcp%2Ftree%2Frender-relay-20261108)

A conta da Render precisa poder ler o repositório. Para repositórios privados,
a integração GitHub da Render também precisa de acesso ao repositório; conectar
o plugin Render ao ChatGPT não concede automaticamente esse acesso ao GitHub.

Revise o recurso antes de confirmar. O plano deve ser **Free**. A URL real será
exibida no serviço criado, normalmente terminando em `.onrender.com`. Não use
um endereço de exemplo como se já fosse o endereço do seu serviço.

Não publique o painel administrativo nem a pasta `.ponte` na Render. O comando
na nuvem é `node server.mjs`, dentro de `relay`; **não é** `npm start` do núcleo.

## Conectar o PC uma vez

1. Copie a pasta `relay` desta versão para a pasta da sua instalação da Ponte.
   Os arquivos existentes do núcleo não precisam ser substituídos ou recompilados.
2. Inicie a Ponte normalmente. Abra o painel local e confira sua porta de API.
3. Após o serviço Render estar ativo, copie sua origem HTTPS real, sem `/mcp`.
   Salve-a em **Conectar IA → URL pública da API**. Essa mudança invalida a
   identidade OAuth vinculada ao endereço antigo: haverá uma autorização nova.
4. Na Render, abra **Environment** e copie o valor gerado para `PONTE_RELAY_TOKEN`.
   Não envie esse valor ao chat, não o capture em prints e não o coloque no Git.
5. Na pasta privada `.ponte`, crie `relay-client.json` usando o modelo abaixo.
   Substitua os dois valores de exemplo pelos valores reais.

```json
{
  "relayUrl": "https://SEU-SERVICO.onrender.com",
  "relayToken": "COLE_SOMENTE_AQUI_O_SEGREDO_GERADO_PELA_RENDER"
}
```

6. Abra outro PowerShell na pasta principal da instalação e execute:

```powershell
node relay/agent.mjs
```

Para um diretório de estado personalizado, use o mesmo diretório da Ponte:

```powershell
node relay/agent.mjs --state-dir "C:\Pasta\Do\Estado"
```

O agente lê somente `relay-client.json` e a porta de `config.json`. Não lê nem
utiliza `secrets.json`, o token de administração ou o token de API da Ponte.

**Resultado esperado:** `Agente conectado ao relay.` O agente confirma antes que
a API local anuncia o mesmo emissor OAuth que a origem Render configurada.
Uma porta de painel, origem diferente ou segredo incorreto impedem a conexão.

7. No chat, cadastre o endpoint `https://SEU-SERVICO.onrender.com/mcp` usando
   OAuth. Compare o código com a solicitação no painel local antes de autorizar.
8. Faça uma chamada real de `bridge_status`. Verifique projetos e MCPs do PC.
   Um HTTP 200 em `/healthz` confirma somente o relay, não este teste completo.

## Uso diário e reconexão

Mantenha a Ponte **e** o agente em execução. Depois de reiniciar o PC, inicie a
Ponte primeiro e o agente em seguida. Conserve `.ponte` inteira, a URL pública
e o segredo do relay. Não é necessário criar um novo plugin só porque o IP da
internet mudou. Expiração, revogação OAuth e troca de domínio continuam podendo
exigir nova autenticação.

O agente reconecta um canal que foi interrompido, inclusive após reinício do
relay. Se falhar antes de sua primeira conexão, confira a mensagem e inicie-o
novamente após corrigir a configuração ou disponibilidade. O módulo não instala
um serviço do Windows, não agenda tarefas e não altera a inicialização do PC.

Não execute dois agentes para o mesmo relay. Um segundo processo é recusado
até o anterior desligar ou sua presença expirar. Há uma tolerância de até 45 s
para detectar uma interrupção sem aviso do agente.

## Como funciona

Os clientes chamam o endereço público. O PC mantém conexões HTTPS de saída com
o relay e recebe as requisições pendentes por **long polling**: uma consulta
fica aberta por até 20 segundos, em vez de consultar continuamente sem pausa.
São quatro canais de execução e uma verificação de presença a cada 10 segundos.
Isso é o transporte da Ponte, não um agendador de ChatGPT/Claude nem um watcher.

O agente repassa cada solicitação uma vez à API `127.0.0.1`, preservando o token
OAuth ou Bearer do cliente. O núcleo continua validando autenticação, projetos,
aprovações e hashes. O relay não ganha uma chave administrativa da Ponte.

O fluxo atual é HTTP stateless/JSON. GET/DELETE em `/mcp` são encaminhados para
o núcleo responder conforme seu contrato; o relay não inventa suporte a SSE.

## Limites conhecidos

| Item | Limite / comportamento |
|---|---|
| PCs por relay | 1; não é uma plataforma multiusuário |
| Chamadas locais paralelas | 4 |
| Requisições pendentes na nuvem | 16 |
| Corpo da chamada | 1 MiB |
| Corpo da resposta | 8 MiB; excesso gera erro, não truncamento silencioso |
| Espera do transporte público | Até 65 segundos |
| Chamada local | Até 55 segundos |
| Watcher nativo | Continua com 25 s padrão / 45 s máximo por chamada |
| Filas e respostas na nuvem | Temporárias; não persistem após reinício |
| PC desligado | Ferramentas indisponíveis; não existe execução na Render |
| Notificação com conversa encerrada | Não é adicionada por este relay |

Em erro de comunicação após despacho, o estado é `unknown`: a tarefa pode ter
executado. Recupere o mesmo `jobId` ou `watcherId` e confira o executor. Não
reenvie a demanda. O relay não reencaminha operações que ficaram sem resposta.
Um erro `not_sent` significa que aquela requisição não foi encaminhada ao PC.

O agente pode repetir **a entrega de um resultado**, nunca a execução que o
produziu. Se o cliente desconectar ou o relay reiniciar, resultados tardios
são descartados pelo transporte; o estado recuperável continua sendo o do núcleo.
A retenção de jobs e watchers é a que a versão local da Ponte oferece.

## Segurança

O segredo do relay identifica o agente; não substitui OAuth e não permite
aprovar solicitações no painel. Entretanto, quem obtiver esse segredo pode
personificar um agente e interceptar chamadas: proteja-o e rotacione-o na Render
e em `relay-client.json` quando necessário.

O relay limita as rotas expostas à API, descoberta OAuth, páginas de consentimento
e callbacks de watcher. `/admin`, arquivos arbitrários e destinos escolhidos por
uma requisição são bloqueados. O agente também confere as rotas e encaminha
somente ao loopback; redirects são devolvidos ao cliente, não seguidos pelo PC.

**TLS termina na Render.** O relay processa chamadas, resultados e credenciais
OAuth em trânsito. Não é criptografia ponta a ponta que esconda os dados do
operador da hospedagem. Use um serviço sob sua conta, proteja o acesso à Render
e não o trate como adequado a dados sensíveis sem sua própria avaliação.
A aplicação não registra corpos, URLs de requisições nem tokens nos logs. As
políticas de observabilidade da plataforma de hospedagem são separadas.

## Custo e disponibilidade

O Blueprint seleciona Free, mas o consumo está sujeito aos limites da conta.
Serviços gratuitos podem suspender por inatividade e reiniciar; um endereço
estável não garante disponibilidade contínua. Não use este preparo como prova
de produção 24 horas. Nenhum plano pago ou banco é criado por este Blueprint.

## Testes

Na pasta principal do repositório:

```powershell
node --test relay/tests/relay.test.mjs
```

Ou dentro de `relay`:

```powershell
npm.cmd run check
npm.cmd test
```

Os testes usam HTTP real em loopback e um simulador controlado da API local.
Eles não autenticam uma conta real de ChatGPT, Claude, Gemini ou Grok, não usam
Roblox/Blender reais e não substituem o teste de implantação na Render.

## Diagnóstico

- `pc_offline`: inicie Ponte e agente; confira o segredo e a origem pública.
- `another_agent_connected`: pare o agente anterior ou aguarde a expiração da
  presença; não tente usar duas instalações no mesmo serviço.
- Origem OAuth diferente: confira **Conectar IA**; não configure `/mcp` nesse campo.
- `unknown`: não repita a execução; consulte seu identificador na Ponte.
- `relay_busy`: há 16 solicitações pendentes; reduza o paralelismo do cliente.
- Não aparece o repositório na Render: conceda acesso à integração GitHub da
  Render somente ao repositório necessário.
- `/healthz` online, ferramentas falhando: `pcOnline` representa a presença do
  agente; confira separadamente a API local e uma chamada autenticada ao MCP.

## Voltar ao túnel anterior

Pare apenas o agente com Ctrl+C, mantenha a Ponte e sua pasta de estado e
restaure a origem anterior no painel. Reautorize o cliente para aquele emissor.
Não exclua `.ponte`, watchers, backups ou credenciais durante essa troca.

## Referências oficiais

- [Web Services e domínio onrender.com](https://render.com/docs/web-services)
- [Limites de serviços gratuitos](https://render.com/docs/free)
- [Blueprints](https://render.com/docs/blueprint-spec)
- [Deploy to Render e repositórios privados](https://render.com/docs/deploy-to-render)
- [Versão do Node](https://render.com/docs/node-version)
