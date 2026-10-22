# Roblox Studio com Ponte MCP 0.4.0: integração e teste

A ponte conecta-se ao **servidor integrado ao Roblox Studio**. Não instala um plugin Lua próprio, não usa uma porta HTTP suposta do Studio e não depende do servidor Rust antigo.

Fonte: [Connect to the Roblox Studio MCP server](https://create.roblox.com/docs/studio/mcp), documentação oficial consultada em 21/10/2026.

## Windows

No Studio atualizado, habilite **Assistant → … → Manage MCP Servers → Enable Studio as MCP server** e mantenha o place aberto.

O preset executa `cmd.exe` com os argumentos oficiais:

```json
["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]
```

Se a conexão falhar, confira se `%LOCALAPPDATA%\Roblox\mcp.bat` existe no seu perfil e se o Studio foi atualizado. Não substitua por um caminho de versão adivinhado. Uma atualização pode trocar diretórios internos; o ponto de entrada documentado evita essa dependência.

## macOS

O ponto de entrada oficial é:

```text
/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
```

## Teste progressivo

1. Adicione o preset em Conexões MCP e confirme o estado conectado.
2. Abra o catálogo e identifique a ferramenta original `list_roblox_studios`. O nome exportado tem prefixo e hash; copie o nome real do catálogo.
3. Execute a ferramenta e, se a política exigir, revise e aprove no painel. Confira o Studio e o place retornados.
4. Use uma ferramenta de inspeção, como `get_studio_state` ou `inspect_instance`, com os argumentos anunciados no schema.
5. Em uma cópia de teste do seu place, peça ao chat uma pequena alteração de script. Confira os argumentos, o Studio selecionado e o resultado dentro do editor.
6. Teste play mode separadamente e confirme o comportamento no jogo.

Múltiplas sessões do Studio exigem atenção ao `studio_id`. Não confunda Edit com Client/Server. Esses campos dependem da ferramenta e são obtidos do schema real.

O catálogo oficial documenta leitura e edição de scripts, inspeção da árvore de objetos, execução Luau, playtests e outras ferramentas. A ponte encaminha o que a versão instalada anunciar. Resultados MCP com imagens são preservados; o cliente precisa conseguir apresentá-los. A API Actions retorna conteúdo JSON e não promete renderização multimodal equivalente à de um cliente MCP.

## Confirmações e confiança

O preset usa `readOnlyTools: []`. Com a política padrão `mutations`, todas as ferramentas do Studio aguardam revisão local. Ferramentas verificadas como estritamente de leitura podem entrar em `readOnlyTools` para dispensar essa revisão. O modo `all` exige revisão inclusive das leituras. Execução Luau, geração/inserção de assets e edição de scripts continuam sendo ações com efeitos colaterais.

Para liberar as chamadas automaticamente, escolha **Visão geral → Você no controle → Política de aprovação → Aprovar automaticamente todas**. O modo `automatic` libera pendentes válidos e futuras chamadas MCP, incluindo o Studio, para todos os clientes autorizados. A escolha persiste após reiniciar e mantém as listas de ferramentas permitidas e a pausa. Novas conexões OAuth continuam exigindo aprovação local. Ao sair do modo, trabalhos automáticos ainda na fila voltam à revisão conforme a política; os que já começaram continuam.

Uma chamada MCP aguarda até 25 segundos quando está na fila ou em execução. Se retornar um `jobId`, consulte `bridge_job` com `waitMs: 25000` para aguardar esse mesmo trabalho durante o turno ativo. `waitMs` aceita de 0 a 25000, padrão 0; também pode aguardar uma aprovação pendente. A chamada inicial em `pending_approval` retorna imediatamente. Essa espera não reabre uma conversa encerrada.

Para receber um aviso depois, um cliente compatível pode assinar `ponte.job.completed` com o `jobId` daquela execução do Studio. No ChatGPT, use Work no navegador ou Work com Cloud no desktop e peça que, ao receber o evento, consulte `bridge_job`, confira o resultado e continue a tarefa. A inscrição aparece em **Conectar IA → Avisos de conclusão**. O evento informa somente ID, ferramenta, status e horários; o resultado, inclusive conteúdo multimodal quando disponível, é recuperado pela ferramenta de consulta. A inscrição não repete a chamada Luau nem modifica a política de aprovação. Veja [MCP-EVENTS.md](MCP-EVENTS.md).

Ao atualizar a Ponte pelo GitHub, siga os comandos de [atualização](../README.md#atualizar-uma-instalação-existente), preserve `.ponte` e atualize as ferramentas e os eventos do plugin. Conexões OAuth já concluídas podem ser mantidas.

O diff automático da ponte cobre arquivos de texto locais. Uma ferramenta externa do Studio tem sua solicitação exibida como argumentos; a ponte não inventa um diff do data model. O backup de arquivos locais também não substitui o histórico do place ou o controle de versão do seu projeto Roblox.

## Estado da validação

Os caminhos do preset seguem a documentação oficial. Os testes registrados para esta entrega ficam em [VALIDACAO.md](VALIDACAO.md). Uma edição real dentro do Studio e a instalação da 0.4.0 no computador do usuário precisam ser verificadas nesse ambiente.

O antigo repositório [Roblox/studio-rust-mcp-server](https://github.com/Roblox/studio-rust-mcp-server) foi arquivado e recomenda a integração embutida. Não é a dependência padrão desta versão.
