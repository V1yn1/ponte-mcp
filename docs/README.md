# Documentação da Ponte MCP

[Voltar ao projeto](../README.md)

Documentação da **Ponte MCP 0.10.0**.

> [!TIP]
> **Nunca instalou a Ponte?** Comece por [Guia para iniciantes — instalar e usar a Ponte MCP](GUIA-INICIANTE.md). Ele foi escrito para quem não conhece Node.js, terminal, MCP ou OAuth.

## Escolha pelo seu nível

### 1. Iniciante — quero instalar e ver funcionando

Leia nesta ordem:

1. [Guia para iniciantes](GUIA-INICIANTE.md) — instalação Windows passo a passo, primeiro teste e conexão ao ChatGPT.
2. [Operação e configuração](OPERACAO.md) — atualização, diretório de estado, CLI, portas e diagnóstico.
3. O guia do chat que você pretende usar.

### 2. Já instalei — quero conectar um cliente

| Cliente | Guia |
|---|---|
| ChatGPT | [Conectar ao ChatGPT](CHATGPT.md) |
| Dot do ChatGPT | [Usar a Ponte com dots](DOTS.md) |
| Claude / Claude Desktop / Claude Code | [Conectar ao Claude](CLAUDE.md) |
| Gemini Apps / Gemini CLI / Gemini API | [Conectar ao Gemini](GEMINI.md) |
| Grok / Grok Build / xAI API | [Conectar ao Grok](GROK.md) |

### 3. Quero adicionar ferramentas

| Objetivo | Guia |
|---|---|
| Roblox Studio | [Roblox Studio](ROBLOX.md) |
| Navegador com Playwright | [Playwright MCP](PLAYWRIGHT.md) |
| Cadastrar outro MCP pelo chat | [MCPs pelo chat](MCPS-PELO-CHAT.md) |
| Entender stdio, HTTP, SSE e Actions | [Integrações](INTEGRACOES.md) |

### 4. Quero entender os recursos avançados

| Tema | Guia |
|---|---|
| Nomes de ferramentas, rotas e contratos | [API e ferramentas](API.md) |
| Acompanhar tarefa externa até o resultado | [Watchers](WATCHERS.md) |
| Avisos por webhook | [MCP Events](MCP-EVENTS.md) |
| Permissões, tokens e limites de confiança | [Segurança](SEGURANCA.md) |
| Persistência, processos e componentes | [Arquitetura](ARQUITETURA.md) |
| O que realmente foi testado | [Validação](VALIDACAO.md) |
| Identidade visual | [Identidade visual](IDENTIDADE-VISUAL.md) |

## Caminho rápido por objetivo

**“Só quero instalar.”**  
→ [Guia para iniciantes](GUIA-INICIANTE.md)

**“Instalei, mas o painel não abre.”**  
→ [Operação — URL pública e diagnóstico](OPERACAO.md#url-pública-e-diagnóstico)

**“O painel abre; quero conectar o ChatGPT.”**  
→ [ChatGPT](CHATGPT.md)

**“Quero usar Roblox Studio.”**  
→ [Roblox Studio](ROBLOX.md)

**“Quero controlar navegador.”**  
→ [Playwright MCP](PLAYWRIGHT.md)

**“Quero que o chat instale/conecte outro MCP.”**  
→ [MCPs pelo chat](MCPS-PELO-CHAT.md)

**“Quero deixar tudo automático.”**  
→ Antes, leia [Segurança](SEGURANCA.md) e a seção de política de aprovação em [Operação](OPERACAO.md).

## Como a documentação está organizada

A documentação separa três coisas que costumam ser confundidas:

- **instalação** — colocar a Ponte para funcionar no computador;
- **conexão** — permitir que um cliente de IA alcance a Ponte;
- **execução** — usar as ferramentas e acompanhar seus resultados.

Se algo falhar, descubra primeiro em qual dessas três etapas o problema está.

O teste recomendado para separar as camadas é:

1. abrir o painel em <http://127.0.0.1:4317>;
2. executar `local_projects` pelo painel;
3. só depois testar túnel/OAuth/chat.

Se os passos 1 e 2 funcionam, a instalação local está funcionando.

## Exemplos prontos

- [Instruções para o chat](../examples/chat-instructions.txt)
- [Gemini Interactions API](../examples/gemini-api.mjs)
- [xAI Responses API](../examples/grok-api.mjs)
- [Upstream MCP HTTP](../examples/upstream-http.json)
- [OpenAPI para GPT Actions](../examples/gpt-actions.openapi.json)
- [Produtor de sinal de watcher](../scripts/ponte-watch-notify.mjs)

## Desenvolvimento e histórico

- [CHANGELOG](../CHANGELOG.md)
- [Validação](VALIDACAO.md)
- [Planos e desenhos históricos](superpowers/README.md)

Para operar a Ponte, prefira os guias atuais acima. Documentos históricos registram decisões antigas e não substituem o comportamento da versão instalada.
