# Validação do Ponte Cloud Relay 0.1.0

Data: 2026-11-08. Ambiente: Linux, Node.js 22.16.0. Módulo independente do núcleo
Ponte 0.10.0, com protocolo de API conferido no commit
`b02274500fb27e1efe14fb5a3125196395f51926` de V1yn1/ponte-mcp.

## Execuções realizadas

- `npm run check` dentro de `relay`: sintaxe dos três módulos aprovada.
- `npm test` dentro de `relay`: **21 testes, 21 aprovados, zero falhas/ignorados**.
- Testes usam sockets HTTP reais no loopback, um relay real e o agente real,
  mas o serviço que representa a API da Ponte é um simulador controlado.
- Cobertura de offline, autenticação do agente, sessão única, rotas proibidas,
  traversal, corpos/concorrência limitados, preservação de headers/tokens,
  resposta OAuth 401, redirects 302 não seguidos, imagem binária e callbacks.
- Sucesso, falha e necessidade de entrada são preservados no corpo do callback;
  o simulador não equivale a uma execução real do Claude/Roblox/Blender.
- Interrupção após despacho, expiração de sessão, reinício de relay e retorno
  tardio não repetem a chamada local. Estado incerto é explicitamente unknown.
- Resultado binário de 8 MiB decodificado integralmente; Base64 inválido ou
  não canônico é recusado, sem regex com estouro de pilha em payloads grandes.
- GET/DELETE de MCP chegam ao núcleo; seu status 405 e header Allow são preservados.

## Revisão

Foi realizada uma autorrevisão separada após os primeiros testes. Não houve
revisor independente. A revisão encontrou e corrigiu o estouro de pilha da
validação Base64, a ausência de métodos de ciclo de vida MCP e uma orientação
de erro que poderia sugerir repetição por chave após perda de estado. Os novos
testes falharam antes das correções e passaram depois delas. O teste de reinício
foi ajustado para tolerar falha transitória da própria sondagem HTTP de saúde,
sem relaxar a exigência de reconexão e sem aceitar chamadas locais duplicadas.

## O que NÃO foi validado

- Criação de serviço ou deploy em uma conta Render real.
- Pareamento com o computador do usuário, Windows e inicialização automática.
- Autorização OAuth com ChatGPT, Claude, Gemini ou Grok reais neste relay.
- Reexecução da suíte completa do núcleo: nenhum arquivo do núcleo foi alterado.
- TLS/cold start/balanceador efetivos da Render.
- Validação automatizada contra o JSON Schema remoto da Render: o ambiente
  de execução não resolveu o domínio para baixar esse arquivo. O YAML foi
  conferido estruturalmente e comparado com a documentação oficial.

O Blueprint escolhe Free, sem banco/disco pago; isso não constitui garantia
financeira ou disponibilidade contínua do plano da conta. O serviço só deve ser
considerado implantado após existir uma URL real e saúde confirmada; a integração
só estará comprovada após uma chamada autenticada alcançar a Ponte do PC.
