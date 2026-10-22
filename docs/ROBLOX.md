# Roblox Studio: integração e teste no computador

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
3. Execute a ferramenta, revise e aprove no painel. Confira o Studio e o place retornados.
4. Use uma ferramenta de inspeção, como `get_studio_state` ou `inspect_instance`, com os argumentos anunciados no schema.
5. Em uma cópia de teste do seu place, peça ao chat uma pequena alteração de script. Confira os argumentos, o Studio selecionado e o resultado dentro do editor.
6. Teste play mode separadamente e confirme o comportamento no jogo.

Múltiplas sessões do Studio exigem atenção ao `studio_id`. Não confunda Edit com Client/Server. Esses campos dependem da ferramenta e são obtidos do schema real.

O catálogo oficial documenta leitura e edição de scripts, inspeção da árvore de objetos, execução Luau, playtests e outras ferramentas. A ponte encaminha o que a versão instalada anunciar. Resultados MCP com imagens são preservados; o cliente precisa conseguir apresentá-los. A API Actions retorna conteúdo JSON e não promete renderização multimodal equivalente à de um cliente MCP.

## Confirmações e confiança

O preset usa `readOnlyTools: []`: todas as ferramentas do Studio aguardam revisão local inicialmente. Depois de verificar ferramentas estritamente de leitura, você pode incluí-las na lista de leitura automática. Execute Luau, geração/inserção de assets e edição de scripts continuam sendo ações com efeitos colaterais.

O diff automático da ponte cobre arquivos de texto locais. Uma ferramenta externa do Studio tem sua solicitação exibida como argumentos; a ponte não inventa um diff do data model. O backup de arquivos locais também não substitui o histórico do place ou o controle de versão do seu projeto Roblox.

## Estado da validação

O contrato stdio e os caminhos acima foram verificados na documentação oficial. O agregador foi testado com servidores MCP de teste reais e o SDK oficial. **Este ambiente não tinha Windows/macOS com Roblox Studio instalado, portanto uma edição real dentro do Studio não foi verificada aqui.**

O antigo repositório [Roblox/studio-rust-mcp-server](https://github.com/Roblox/studio-rust-mcp-server) foi arquivado e recomenda a integração embutida. Não é a dependência padrão desta versão.
