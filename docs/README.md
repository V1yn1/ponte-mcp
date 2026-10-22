# Documentação da Ponte MCP

[Voltar ao projeto](../README.md)

Esta é a documentação operacional da **v0.10.0**, revisada em **22 de outubro de 2026**. Os exemplos devem ser adaptados aos caminhos, IDs e à URL pública da sua instalação. O histórico de versões e os testes executados ficam separados das instruções de uso atual.

## Comece pela sua tarefa

| Quero… | Leia |
|---|---|
| Instalar, iniciar, atualizar ou recuperar a configuração | [Operação e configuração](OPERACAO.md) |
| Conectar o ChatGPT e resolver OAuth | [Conectar ao ChatGPT](CHATGPT.md) |
| Usar as ferramentas da Ponte em um dot | [Dots: catálogo, execução e teste no cliente](DOTS.md) |
| Conectar Claude, Claude Desktop ou Claude Code | [Conectar ao Claude](CLAUDE.md) |
| Conectar Gemini Apps, Gemini CLI ou Gemini API | [Conectar ao Gemini](GEMINI.md) |
| Conectar Grok, Grok Build ou xAI API | [Conectar ao Grok](GROK.md) |
| Exportar configuração JSON/TOML sem alterar o cliente | [Perfis de Gemini e Grok](OPERACAO.md#exportar-configurações-para-gemini-e-grok) |
| Fazer o chat aguardar uma tarefa delegada usando a própria Ponte | [Watchers nativos](WATCHERS.md) |
| Entender avisos por webhook enviados a um cliente compatível | [MCP Events](MCP-EVENTS.md) |
| Escolher entre MCP HTTP, stdio, APIs de modelos e GPT Actions | [Integrações](INTEGRACOES.md) |
| Consultar nomes de ferramentas, rotas, estados e autenticação | [Referência da API e ferramentas](API.md) |
| Permitir que o chat cadastre e reconecte MCPs | [MCPs pelo chat](MCPS-PELO-CHAT.md) |
| Adicionar Playwright pelo chat ou pelo painel | [Playwright MCP](PLAYWRIGHT.md) |
| Conectar uma sessão do Roblox Studio | [Roblox Studio](ROBLOX.md) |
| Entender persistência, execução e componentes | [Arquitetura](ARQUITETURA.md) |
| Entender permissões, tokens e limites de confiança | [Segurança](SEGURANCA.md) |
| Conferir o que foi testado e o que ainda depende da instalação | [Validação](VALIDACAO.md) |
| Consultar o logotipo e as cores do painel | [Identidade visual](IDENTIDADE-VISUAL.md) |

## Gemini e Grok na 0.10.0

**Conectar IA** oferece as abas ChatGPT, Claude, Gemini e Grok. Os novos guias distinguem apps com OAuth, CLIs locais/remotos e APIs de modelos com token API da Ponte. `export-client` gera seis perfis: JSON para Gemini CLI, TOML para Grok Build e modelos JSON de requisição para Gemini/xAI. O exportador utiliza os caminhos e o estado reais da instalação, não incorpora tokens e recusa sobrescrever arquivos existentes.

Os exemplos de API começam permitindo somente `bridge_status`; `--tools` habilita as 12 ferramentas centrais. Gemini CLI recebe timeout de 60 segundos no perfil; Grok Build recebe 30 segundos para inicialização e 60 para ferramentas no TOML. O comando curto `grok mcp add` não configura esses prazos: mescle o TOML exportado. Consulte [Operação](OPERACAO.md#exportar-configurações-para-gemini-e-grok) antes de copiar uma configuração.

O [Gemini Apps](GEMINI.md) documenta apps personalizados somente para contas pessoais elegíveis, com 18 anos ou mais nos EUA, interface em inglês e Keep Activity ativado; o recurso não está confirmado para o Brasil. Os caminhos CLI/API têm requisitos próprios. Os perfis e contratos foram verificados em testes controlados; a conexão em contas reais Gemini/Grok ainda não foi validada. [Validação](VALIDACAO.md) registra essa distinção.

## Catálogo e execução

O perfil `full` continua sendo o padrão. O perfil opcional `compact`, em **Conectar IA → Catálogo MCP**, anuncia 12 ferramentas e mantém o catálogo real acessível por `bridge_list_tools`. Use `includeSchemas: false` para pesquisar, `bridge_tool_schema` para obter o contrato e `bridge_read` ou `bridge_invoke` com `argumentsJson` para executar. `bridge_call` preserva argumentos como objeto, e nomes diretos já conhecidos continuam chamáveis.

A Ponte executa os alvos no seu próprio host, com as mesmas permissões e aprovação. `bridge_status.directExecution` informa essa capacidade e deixa explícito que o servidor não observa a disponibilidade das ferramentas no cliente. O [guia de dots](DOTS.md) separa configuração, descoberta e teste real no dot; a entrega da 0.9.0 não incluiu comprovação de execução nesse dot. Consulte [Operação](OPERACAO.md#estado-de-events-e-retorno-a-uma-versão-anterior) antes de um downgrade: versões anteriores à 0.9.0 não aceitam `mcpToolExposure` persistido.

## Três conceitos que não devem ser confundidos

| Conceito | Responsabilidade |
|---|---|
| **Trabalho (`job`)** | Executar uma ferramenta, aplicando aprovação, validação e limite de execução |
| **Acompanhamento (`watcher`)** | Guardar o resultado de um gatilho e permitir consulta ou espera pela própria Ponte |
| **Inscrição de MCP Events** | Entregar `ponte.job.completed` ou `ponte.watcher.completed` ao callback fornecido por um cliente compatível |

O watcher `signal` é indicado quando o trabalho acontece fora da chamada que o delegou. O watcher `job` acompanha apenas o estado da execução identificada. A Ponte não interpreta uma janela ociosa ou o término de um envio de texto como sucesso de uma tarefa.

Os watchers **não usam agendador do cliente**. Cada espera usa 25 segundos por padrão e no máximo 45 segundos; ela não renova o prazo total do acompanhamento. Enquanto `waiting`, o chat mantém o turno ativo com novas esperas pelo mesmo ID até terminal ou limite concreto. Após falha de comunicação, consulta esse ID antes de continuar. `needs_input` é terminal e pede intervenção.

O acompanhamento permanece no serviço quando a conexão cai. O contrato mantém `monitorDurable: true` e `canWakeClosedConversation: false`, inclusive após recebimento HTTP de um evento. O guia de [Watchers](WATCHERS.md) descreve a recuperação, e [Validação](VALIDACAO.md#recuperação-de-esperas-e-eventos-de-watchers--080) distingue o caso externo relatado da retomada de conversa ainda não comprovada.

## Exemplos prontos para adaptar

- [Instruções para o chat](../examples/chat-instructions.txt): preferência por execução na Ponte, catálogo compacto, schemas reais, aprovação, arquivos, upstreams e acompanhamento nativo.
- [Cliente MCP stdio no Windows](../examples/mcp-client.windows.json): substitua os caminhos pelos da instalação.
- [Gemini Interactions API](../examples/gemini-api.mjs): consulta de estado por padrão; credenciais e modelo fornecidos pelo ambiente.
- [xAI Responses API](../examples/grok-api.mjs): consulta de estado por padrão; `--tools` habilita o gateway da Ponte para uma tarefa autorizada.
- [Upstream MCP HTTP](../examples/upstream-http.json): cadastro com referência a uma variável de ambiente.
- [OpenAPI para GPT Actions](../examples/gpt-actions.openapi.json): exemplo com origem fictícia; prefira exportar da sua instalação com a URL correta.
- [Produtor de sinal de conclusão](../scripts/ponte-watch-notify.mjs): envio autenticado do resultado pelo executor.

## Histórico e desenvolvimento

[CHANGELOG.md](../CHANGELOG.md) apresenta a evolução do produto. [Validação](VALIDACAO.md) registra evidência por versão e diferencia testes controlados de observações manuais em clientes reais. Resultados antigos não são apresentados como uma nova execução da suíte atual.

Os [planos e desenhos históricos](superpowers/README.md) preservam as decisões de cada entrega. Consulte os guias acima e o código da versão instalada para operar a Ponte; uma hipótese de um desenho antigo não altera o comportamento publicado.

As principais fontes de contrato são [configuração](../src/core/config.ts), [rotas HTTP](../src/http.ts), [fachada MCP](../src/mcp/server.ts), [perfis de clientes](../src/clients/profiles.ts), [gerenciamento de MCPs](../src/mcp/management.ts), [schemas de watchers](../src/watchers/types.ts) e [gerador OpenAPI](../src/openapi.ts). As referências dos fornecedores ficam nos respectivos guias de integração.
