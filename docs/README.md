# Documentação da Ponte MCP

[Voltar ao projeto](../README.md)

Esta é a documentação operacional da **v0.6.0**, revisada em **22 de outubro de 2026**. Os exemplos devem ser adaptados aos caminhos, IDs e à URL pública da sua instalação. O histórico de versões e os testes executados ficam separados das instruções de uso atual.

## Comece pela sua tarefa

| Quero… | Leia |
|---|---|
| Instalar, iniciar, atualizar ou recuperar a configuração | [Operação e configuração](OPERACAO.md) |
| Conectar o ChatGPT e resolver OAuth | [Conectar ao ChatGPT](CHATGPT.md) |
| Conectar Claude, Claude Desktop ou Claude Code | [Conectar ao Claude](CLAUDE.md) |
| Fazer o chat aguardar uma tarefa delegada usando a própria Ponte | [Watchers nativos](WATCHERS.md) |
| Entender avisos por webhook enviados a um cliente compatível | [MCP Events](MCP-EVENTS.md) |
| Escolher entre MCP HTTP, stdio e GPT Actions | [Integrações](INTEGRACOES.md) |
| Consultar nomes de ferramentas, rotas, estados e autenticação | [Referência da API e ferramentas](API.md) |
| Adicionar Playwright no painel | [Playwright MCP](PLAYWRIGHT.md) |
| Conectar uma sessão do Roblox Studio | [Roblox Studio](ROBLOX.md) |
| Entender persistência, execução e componentes | [Arquitetura](ARQUITETURA.md) |
| Entender permissões, tokens e limites de confiança | [Segurança](SEGURANCA.md) |
| Conferir o que foi testado e o que ainda depende da instalação | [Validação](VALIDACAO.md) |
| Consultar o logotipo e as cores do painel | [Identidade visual](IDENTIDADE-VISUAL.md) |

## Três conceitos que não devem ser confundidos

| Conceito | Responsabilidade |
|---|---|
| **Trabalho (`job`)** | Executar uma ferramenta, aplicando aprovação, validação e limite de execução |
| **Acompanhamento (`watcher`)** | Guardar o resultado de um gatilho e permitir consulta ou espera pela própria Ponte |
| **Inscrição de MCP Events** | Entregar o evento de um trabalho ao callback fornecido por um cliente compatível |

O watcher `signal` é indicado quando o trabalho acontece fora da chamada que o delegou. O watcher `job` acompanha apenas o estado da execução identificada. A Ponte não interpreta uma janela ociosa ou o término de um envio de texto como sucesso de uma tarefa.

Os watchers **não usam agendador do ChatGPT/Claude**. Permanecem no serviço quando a conexão cai, mas não abrem por conta própria um novo turno no chat. O guia de [Watchers](WATCHERS.md) descreve esse contrato e o fluxo de retomada pelo mesmo ID.

## Exemplos prontos para adaptar

- [Instruções para o chat](../examples/chat-instructions.txt): descoberta, aprovação, arquivos, execução e acompanhamento nativo.
- [Cliente MCP stdio no Windows](../examples/mcp-client.windows.json): substitua os caminhos pelos da instalação.
- [Upstream MCP HTTP](../examples/upstream-http.json): cadastro com referência a uma variável de ambiente.
- [OpenAPI para GPT Actions](../examples/gpt-actions.openapi.json): exemplo com origem fictícia; prefira exportar da sua instalação com a URL correta.
- [Produtor de sinal de conclusão](../scripts/ponte-watch-notify.mjs): envio autenticado do resultado pelo executor.

## Histórico e desenvolvimento

[CHANGELOG.md](../CHANGELOG.md) apresenta a evolução do produto. [Validação](VALIDACAO.md) registra evidência por versão e diferencia testes controlados de observações manuais em clientes reais. Resultados antigos não são apresentados como uma nova execução da suíte atual.

Os [planos e desenhos históricos](superpowers/README.md) preservam as decisões de cada entrega. Consulte os guias acima e o código da versão instalada para operar a Ponte; uma hipótese de um desenho antigo não altera o comportamento publicado.

As principais fontes de contrato são [configuração](../src/core/config.ts), [rotas HTTP](../src/http.ts), [fachada MCP](../src/mcp/server.ts), [schemas de watchers](../src/watchers/types.ts) e [gerador OpenAPI](../src/openapi.ts). As referências dos fornecedores ficam nos respectivos guias de integração.
