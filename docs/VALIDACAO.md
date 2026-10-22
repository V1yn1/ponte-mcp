# Validação da entrega — Ponte MCP 0.2.0

Verificação concluída em 22 de outubro de 2026. Ambiente: Linux, Node.js 24.19.0 e npm 11.9.0. Os resultados descrevem testes executados nesta entrega; não presumem acesso ao Windows, ao Roblox Studio ou à conta ChatGPT do usuário.

## Resultado observado

| Verificação | Resultado |
|---|---|
| `npm run verify` | Passou: TypeScript, **72 testes**, zero falhas, zero testes ignorados e build compilado |
| `npm run smoke` | Passou com código em `dist`: OAuth, MCP, leitura, escrita aprovada, backup, renovação e revogação |
| JavaScript do painel e consentimento | `node --check` passou nos dois scripts |
| Navegador Chromium | Autorização, rejeição, revogação e chamada MCP concluídas no ambiente local; sem erros JavaScript ou CSP capturados |
| Layouts | Inspeção visual em 1440 × 1000 e 412 × 915; ausência de overflow horizontal |
| Dependências de produção | `npm audit --omit=dev --json`: zero vulnerabilidades conhecidas na consulta realizada |
| Revisão independente | Problema de esgotamento permanente do registro DCR identificado, corrigido e revisado novamente |

As verificações de rede usaram listeners reais em `127.0.0.1`. Os testes OAuth mantêm identificadores canônicos HTTPS e encaminham as requisições para esses listeners locais. Isso verifica o contrato OAuth e a implementação MCP, mas não comprova TLS, alcance de um túnel externo nem conexão com uma conta real do ChatGPT.

## Os 24 testes de OAuth

São **19 testes do provider** e **5 testes HTTP**, cobrindo:

- Descoberta pública do recurso e do authorization server, emissor exato, PKCE S256, DCR e métodos de autenticação anunciados.
- Cliente oficial do SDK MCP realizando descoberta, registro dinâmico, consentimento, troca de código e chamada de ferramentas.
- Autorização local obrigatória, rejeição, prazo de consentimento e conclusão de uso único.
- Vínculo entre cliente, redirect registrado exato, recurso, scope e desafio PKCE.
- Rejeição de PKCE incorreto, audiência diferente, redirect diferente, scopes indevidos e reutilização de código.
- `iss` e `state` nos redirects de sucesso e erro; nenhuma emissão de código após rejeitar.
- `securitySchemes` e seu espelho em `_meta` no JSON efetivamente transmitido em `tools/list`. O parser do cliente SDK remove extensões desconhecidas no nível superior; por isso a verificação também inspeciona a resposta HTTP original.
- Separação entre tokens OAuth, API legada e administração; nenhum token reutilizável exposto no resumo administrativo.
- Expiração de consentimento, código, access token e refresh/grant, com limites exatos de tempo.
- Rotação de refresh tokens, persistência após reinício, detecção de replay e revogação da família, inclusive sob concorrência.
- Revogação administrativa e pelo endpoint OAuth, preservando o vínculo com o cliente.
- Invalidação permanente ao mudar ou remover a URL pública, inclusive quando ela muda e volta ao valor anterior.
- Estado OAuth persistente privado, rejeição de links/estado malformado e armazenamento de hashes de access/refresh tokens.
- Limite de registros sem bloqueio permanente por clientes anônimos: descarte do mais antigo nunca autorizado, com preservação de clientes já autorizados e fluxos ativos.

## Os 48 testes de regressão

Os testes anteriores continuam passando. Eles cobrem configuração e credenciais separadas; políticas de aprovação; argumentos imutáveis; pausa, cancelamento e idempotência; schemas modernos; alterações reais depois de aprovar; proteção dos caminhos e do estado; leitura UTF-8 com SHA-256; diffs, backups e escrita concorrente; busca limitada; execução de processos com limites; e agregação de MCPs stdio, HTTP e SSE reais.

Os testes da fachada legada com token API continuam passando, incluindo chamada MCP e escrita que só ocorre após aprovação administrativa. Tokens OAuth não passam a dar acesso à API de administração nem às rotas REST legadas.

## Smoke do programa compilado

`scripts/smoke.mjs` importa o código em `dist`, inicia uma instalação temporária em portas livres e usa o cliente oficial do SDK. O roteiro:

1. Descobre OAuth e registra um cliente.
2. Aprova o pedido pelo endpoint administrativo local, recebe o callback e troca o código com PKCE.
3. Negocia MCP usando o token OAuth e lista as ferramentas.
4. Lê um arquivo e verifica seu SHA-256.
5. Solicita uma alteração e comprova que o arquivo permanece intacto enquanto aguarda aprovação.
6. Confere o diff e rejeita a tentativa de aprovação com a credencial da API.
7. Aprova pela administração e verifica o conteúdo final e o backup.
8. Renova com rotação de refresh token, revoga a conexão e comprova a recusa do token revogado.

Para repetir após instalar as dependências:

```sh
npm run verify
npm run smoke
```

No PowerShell, use `npm.cmd` se a política local bloquear o lançador `npm.ps1`. O smoke não usa seu estado existente, limpa os temporários e encerra as conexões ao terminar.

## Verificação do painel e da página de consentimento

O navegador executou login no painel, salvou a URL pública, abriu a página de consentimento e comparou o código mostrado nas duas telas. O botão de autorização ficou desabilitado até marcar a confirmação; a atualização automática preservou a confirmação da solicitação revisada e o texto ainda não salvo no campo de URL.

Depois da autorização, o teste capturou localmente o redirect HTTP que seria enviado ao callback do ChatGPT, verificou `state`, `iss` e código, concluiu a troca de tokens e chamou `bridge_status`. Nenhuma conta real do ChatGPT foi conectada. O teste também revogou o acesso pelo painel e confirmou HTTP 401; um segundo pedido foi recusado e retornou `access_denied` sem código.

A página de consentimento e a tela de conexão foram inspecionadas em desktop e celular. Não houve overflow horizontal nem erros JavaScript/CSP capturados. Uma junção de palavras no título móvel foi corrigida durante a inspeção visual.

## O que precisa ser validado no ambiente do usuário

- Instalação e operação no Windows ou macOS; esta entrega foi testada em Linux.
- Encaminhamento HTTPS público de toda a API, incluindo descoberta e endpoints OAuth, ou configuração de um Secure MCP Tunnel compatível.
- Criação/atualização, instalação e autorização do plugin na conta real do ChatGPT, sujeitas às permissões da conta e do workspace.
- Conexão a uma instalação real do Roblox Studio e ao place escolhido, seguindo `ROBLOX.md`.
- Credenciais e efeitos dos MCPs de terceiros que o usuário adicionar.

Não há garantia de acesso independente das políticas do ChatGPT ou da disponibilidade da rede. O resultado de `npm audit` é uma consulta de vulnerabilidades conhecidas das dependências; não substitui uma auditoria de segurança do produto. Terminal e programas MCP aprovados continuam usando os privilégios da conta local, conforme `SEGURANCA.md`.
