# Ponte MCP — especificação da versão 0.1

## Objetivo
Permitir que um chat com integração de ferramentas leia e altere projetos locais, execute comandos autorizados e utilize servidores MCP locais ou remotos por uma conexão central. O usuário pediu a construção do projeto. Adotamos Windows como plataforma prioritária, com servidor portátil em Node.js e painel local em português.

## Limites do produto
A ponte não hospeda um modelo, não compra créditos e não remove cotas de chats, agentes ou serviços conectados. Um chat precisa oferecer MCP, Actions ou outra forma explícita de chamar ferramentas. Não vamos simular cliques na interface do chat ou extrair sessões. Roblox usa seu MCP oficial, por stdio, e precisa estar instalado e habilitado no computador do usuário.

## Arquitetura
Um processo local mantém configurações, catálogo de ferramentas, clientes MCP upstream e fila de trabalhos. Porta 4317: painel e administração, somente em 127.0.0.1. Porta 4318: MCP Streamable HTTP e REST para Actions, também em loopback; apenas essa porta pode ser encaminhada por um túnel HTTPS configurado pelo usuário. O modo stdio encaminha para o processo local, mantendo um único painel e fila. Tokens de administração e API são separados.

## Ferramentas locais
Listar projetos e arquivos, ler arquivos com hash SHA-256, pesquisar texto, escrever arquivos completos e substituir trechos exatos. Escritas exigem hash esperado (ou null para criação), exibem diff e fazem cópia de segurança. Caminhos são relativos ao projeto, links simbólicos e travessia são recusados. Diretórios sensíveis e o diretório de configuração não são acessíveis por estas ferramentas. Comandos usam executável e argumentos, sem shell implícito; ficam desabilitados por projeto até ativação local e sempre exigem aprovação. Terminal não é uma sandbox do sistema operacional.

## Agregação MCP
Conectar servidores stdio, Streamable HTTP ou SSE legado. Importar seus schemas e conteúdos sem transformar imagens em texto. Nomes têm namespace derivado do servidor, sem colisões. Ferramentas externas exigem aprovação por padrão; apenas uma lista explícita do administrador permite execução automática de leituras. Anotações do upstream não concedem confiança. Conexões usam timeout, erros visíveis e reconexão manual. Suporte desta versão abrange ferramentas; resources, prompts, sampling, elicitation e OAuth upstream interativo ficam fora do escopo.

## Execução e revisão
Cada chamada vira um trabalho. Leituras locais são automáticas; gravações, terminal e ferramentas externas desconhecidas aguardam confirmação local. A aprovação refere-se a argumentos imutáveis e à versão da ferramenta. A API do chat não aprova seus próprios trabalhos. Idempotency keys impedem duplicação por reenvio. Trabalho pode ser consultado e cancelado. Ao reiniciar, a fila volátil não reexecuta ações antigas; auditoria persiste somente metadados, sem código e tokens.

## Painel
Interface responsiva com visão geral, projetos, conexões, catálogo/testador de ferramentas, fila de aprovações com diffs e histórico. Login por token local. Permitir adicionar projeto, configurar MCP externo, habilitar preset Roblox, reconectar servidor e pausar novas execuções. Mostrar apenas estados reais; exemplos devem ser identificados.

## Conexão com chats
Fornecer configuração stdio, instruções para MCP por túnel privado compatível e OpenAPI para GPT Actions com Bearer token. Não prometer suporte a Bearer estático na interface de MCP do ChatGPT; quando necessário, usar stdio via túnel oficial ou Actions. Documentar acesso dependente do plano e workspace.

## Critérios de aceitação
Build TypeScript passa. Testes executam escritas reais em diretórios temporários e cliente MCP oficial contra servidor local. Verificar traversal, symlink, hash divergente, separação de tokens, aprovação, cancelamento, idempotência, timeout, paginação e proxy de dois servidores com ferramenta de mesmo nome. Smoke de UI usando dados do servidor. Não declarar Roblox ou Windows validados ao vivo sem essas plataformas.
