# Correção de compatibilidade nativa com ChatGPT — 0.2.0

## Objetivo autorizado

Atualizar a versão existente da Ponte para que o ChatGPT consiga cadastrar e
autenticar o endpoint MCP pelo fluxo OAuth documentado pela OpenAI. O token API
fixo permanece disponível para Actions e clientes locais existentes.

## Decisões

- Manter a API em `127.0.0.1:4318` e a administração em `127.0.0.1:4317`.
- Encaminhar a origem HTTPS inteira da API pelo túnel, incluindo descoberta,
  registro, autorização, token, revogação e MCP.
- Implementar authorization code com PKCE S256 e DCR, usando os handlers do SDK
  MCP já instalado. Anunciar somente métodos realmente implementados.
- Usar a origem pública configurada como emissor e `/mcp` como audiência.
  Acrescentar `iss` em respostas de autorização de sucesso e erro.
- Autenticar o proprietário pela aprovação no painel local, comparando o código
  mostrado na página de consentimento. O token administrativo não sai do painel.
- Persistir clientes OAuth, concessões e hashes de tokens. Códigos e solicitações
  pendentes são temporários. Renovar com rotação e detectar reutilização.
- Declarar OAuth nos descritores de ferramentas e conservar as aprovações locais
  de alterações, as restrições de projeto e a agregação de MCPs.

## Execução

1. Reproduzir a incompatibilidade com testes de descoberta e cliente OAuth real.
2. Implementar provider, rotas HTTP e integração com o ciclo de vida da aplicação.
3. Adicionar consentimento público e gestão de conexões no painel.
4. Atualizar instruções de instalação, conexão e migração sem apagar configurações.
5. Validar descoberta, DCR, PKCE, recursos, replay, revogação, persistência e
   chamadas MCP; executar regressões, build e verificação visual.
6. Entregar pacote atualizado com código, build, testes e documentação.

## Critério e limite da evidência

Os testes usam clientes oficiais do SDK contra listeners locais reais. A
simulação de origem HTTPS nos testes não comprova o túnel externo nem a conexão
na conta do usuário. A entrega deve distinguir implementação verificada de
instalação/autorizações que ainda precisam ocorrer no Windows e no ChatGPT.

Referências oficiais: <https://developers.openai.com/plugins/build/auth> e
<https://developers.openai.com/api/docs/guides/custom-mcp-server>.
