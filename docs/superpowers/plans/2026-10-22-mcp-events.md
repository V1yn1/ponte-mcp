# MCP Events Implementation Plan

> **For agentic workers:** Implementar os módulos independentes com testes primeiro; integrar e revisar o conjunto antes da publicação.

**Goal:** Retomar conversas inscritas mediante conclusão de um trabalho da Ponte, pelo perfil oficial de MCP Events.

**Architecture:** Adaptador MCP 2.0 separado do transporte legado, serviço persistente de assinaturas/resultados e transporte HTTPS assinado. A aplicação liga o serviço ao ciclo dos trabalhos e às autorizações OAuth; o painel oferece acompanhamento e encerramento.

**Tech Stack:** TypeScript, Node.js 22.12+, Express, Zod 3, SDK MCP 1.32.1 para compatibilidade anterior, HTTPS e crypto nativos.

**Spec:** `docs/superpowers/specs/2026-10-22-mcp-events-design.md`.

## Global Constraints

- Protocolo moderno `2026-07-28`, evento `ponte.job.completed`, filtro obrigatório `jobId`.
- Manter ferramentas e OAuth anteriores; não enviar eventos reais sem assinatura fornecida pelo cliente.
- Callbacks HTTPS públicos, validação na conexão, sem redirects; assinatura sobre bytes exatos.
- Não incluir segredos, callback completo, argumentos ou resultados no evento ou no resumo administrativo.
- Assinaturas por principal; até 100 assinaturas, 24 horas de validade, 64 MiB de estado.

## Review Focus

- Trabalho termina durante a verificação: exatamente um evento deve ser enfileirado.
- Revogação ou unsubscribe durante tentativa/retry: cessar envios e não ressuscitar assinatura.
- DNS público na inspeção e privado na conexão: o IP deve estar fixado na conexão real.
- Reinício depois do envio e antes do ACK persistido: repetição mantém eventId, resultado permanece consultável.
- Rotação/renovação concorrente: preservar identidade, principal, resultado e atualização mais recente.

## Task 1 — Transporte webhook

Arquivos: `src/events/webhook.ts`, `tests/events-webhook.test.ts`.

Interface: `WebhookPost = (url, body, headers, signal?) => Promise<{status, body}>`; `postWebhook`, validação de URL/chave, assinatura e desafio verificado. A interface exata é compartilhada antes de integrar.

- [x] Escrever e executar testes que falham para assinatura independente, desafio, URL/IP/DNS, redirects e limites.
- [x] Implementar transporte seguro sem acesso a estado da aplicação.
- [x] Executar testes focados e comunicar contratos/exportações.

## Task 2 — Assinaturas e fila persistente

Arquivos: `src/events/service.ts`, `tests/events-service.test.ts`.

Interface: `EventService.open({stateDir,getJob,isAuthorized,post?,now?})`; métodos `list`, `subscribe`, `unsubscribe`, `record`, `snapshot`, `cancel`, `getArchivedJob`, `flush`, `close`. `getJob(principal,jobId)` verifica origem. Métodos remotos recebem principal como primeiro argumento.

- [x] Testes que falham para isolamento, desafio, transição terminal, corrida, deduplicação, reinício, rotação, TTL, retry, cancelamento e limites.
- [x] Implementar estado validado e atômico, fila limitada e restauração de resultados observados.
- [x] Executar testes focados; manter falhas de entrega separadas de falhas de trabalho.

## Task 3 — Adaptador MCP 2.0

Arquivos: `src/mcp/modern.ts`, `tests/mcp-modern.test.ts`.

Interface: `handleModernMcp(req,res,deps): Promise<boolean>` retorna `false` somente para o fluxo legado. Dependências fornecem catálogo, chamada, métodos de Events, principal, versão e instruções.

- [x] Testes que falham para metadados, cabeçalhos, descoberta, ferramentas, Events e códigos de erro.
- [x] Implementar despacho limitado às capacidades anunciadas, com resultados completos e fallback anterior.
- [x] Verificar casos com versão desconhecida, nome codificado e requisição malformada.

## Task 4 — Aplicação, OAuth, trabalhos e painel

Arquivos: `src/app.ts`, `src/auth/provider.ts`, `src/http.ts`, `src/core/jobs.ts`, `src/mcp/server.ts`, `public/*`, testes de integração.

- [x] Testar origem privada de trabalho e observação terminal sem afetar execução.
- [x] Adicionar identidade do grant ao contexto autenticado e consulta de grant ativo.
- [x] Ligar serviço, observador e encerramento; permitir consulta de arquivo de resultados pelo principal.
- [x] Integrar adaptador no endpoint protegido e administração das assinaturas.
- [x] Exibir assinaturas com diagnósticos redigidos e encerramento no painel.
- [x] Executar integração HTTP/OAuth com assinatura, conclusão, entrega e consulta após reinício.

## Task 5 — Entrega

- [x] Atualizar versão para 0.4.0, exemplos e documentação de ativação/limitações.
- [x] Revisão independente; corrigir achados e verificar `npm run verify` e smoke compilado.
Após o gate: gerar commit e pacote completo; publicar no GitHub sem sobrescrever mudanças remotas concorrentes e conferir a árvore publicada.
Na entrega: informar separadamente código verificado, publicação e teste real no ChatGPT; este último depende da atualização local e da inscrição pelo cliente.
