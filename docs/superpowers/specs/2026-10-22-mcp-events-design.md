# MCP Events na Ponte — desenho da versão 0.4.0

## Objetivo e escopo autorizado

O usuário pediu implementar a retomada de uma conversa inscrita no ChatGPT quando uma execução da Ponte terminar. A entrega adiciona o perfil webhook de MCP Events, mantém o MCP anterior e a aprovação automática, e entrega código, testes, documentação e atualização no repositório existente. O cliente precisa oferecer Events e criar uma assinatura; o servidor não inventa um endereço de retorno nem uma identidade de conversa.

## Protocolo e fluxo

O endpoint autenticado `/mcp` aceita o protocolo `2026-07-28` com metadados e cabeçalhos MCP 2.0. Um adaptador separado implementa descoberta, ferramentas e Events; solicitações antigas continuam no SDK 1.32.1. Não se anunciam recursos, prompts, streaming de eventos ou outras capacidades ausentes. Resultados finais modernos incluem `resultType: complete`.

O evento `ponte.job.completed` exige um `jobId` específico. Seus dados contêm apenas ID, ferramenta, estado terminal e horários. O resultado completo continua em `bridge_job`. Uma assinatura é identificada por principal autenticado, URL exata, nome do evento e argumentos canônicos. O principal OAuth usa o grant, permanece estável na renovação de tokens e é revalidado antes de cada envio. Trabalhos registram seu principal de origem internamente; assinaturas, consultas e cancelamentos pelo cliente só alcançam trabalhos desse principal. A administração mantém acesso a todos os trabalhos. O token API tem uma identidade derivada sem expor o token.

Criar uma assinatura verifica um desafio no callback antes de guardar a assinatura ativa. Se o trabalho já terminou, seu evento é enfileirado no mesmo fluxo, evitando perder a conclusão entre a chamada e a assinatura. O envio é deduplicado por assinatura e trabalho; consultas de acompanhamento não geram novos eventos.

Uma inscrição ou renovação é admitida por vez, antes da fila de alterações. Excedentes recebem `-32025`/HTTP 429 e podem tentar novamente; não se acumula uma fila de callbacks lentos. Uma única verificação ainda pode atrasar alterações de Events pelo prazo de rede de até dez segundos.

## Entrega e persistência

Assinaturas, fila de entregas e resultados de trabalhos observados ficam em estado privado, gravado atomicamente e validado ao abrir. Não se persistem solicitações executáveis para repetição automática. Um trabalho interrompido no reinício recebe um resultado explícito de interrupção; efeitos externos incertos não são repetidos.

Prazo padrão e máximo de assinatura: 24 horas. Pedidos de prazo menor são respeitados; `ttlMs: null` recebe um prazo finito. Retenção de resultados observados é limitada por prazo e tamanho, com erro explícito se não houver espaço. Até 100 assinaturas e 64 MiB de estado; não se eliminam entregas ativas silenciosamente para liberar espaço. Resultados arquivados mantêm o principal e podem ser consultados após reinício dentro da retenção concedida.

Os webhooks usam HMAC-SHA256 de Standard Webhooks, os bytes exatos do corpo e IDs estáveis. Limite do corpo: 262144 bytes. Segredos `whsec_` decodificam 24–64 bytes. Rotação aceita duas assinaturas durante cinco minutos. A verificação bem-sucedida tem cache limitado de dez minutos por principal, URL e chave. Erros de callback usam `-32015`, conforme o perfil publicado da OpenAI.

Há até seis tentativas por evento, com espera crescente e limitada. Respostas 2xx confirmam recebimento; 410 e 413 encerram a entrega. A recusa, expiração ou revogação de uma assinatura interrompe novas tentativas. Falhas não alteram o resultado do trabalho nem são descritas como sucesso do ChatGPT.

O transporte só aceita HTTPS público. Resolve e valida endereços em cada conexão, conecta ao IP validado preservando verificação TLS e nome original, rejeita endereços privados/especiais e não segue redirecionamentos. Prazo de rede de dez segundos e resposta limitada. Não existe opção de produção para permitir callbacks privados. Testes injetam transporte controlado.

## Painel e uso

O painel mostra assinaturas, trabalho observado, validade e estado de entrega, com botão para encerrar uma assinatura. Não exibe segredos ou URLs completas. Estado público informa suporte a Events sem revelar assinaturas de outros clientes. Instruções do MCP orientam a inscrição no trabalho pendente e consulta após o evento quando o cliente suporta esse fluxo. O modo de aprovação e a autorização de novas conexões continuam independentes.

## Evidência de aceitação

Testes verificam contrato MCP 2.0 e regressão MCP antigo; desafio e assinatura; isolamento entre grants; conclusão antes/depois da assinatura; persistência, renovação, rotação, expiração, cancelamento, revogação, retentativas e restauração do resultado; URLs/DNS/redirecionamentos; ausência de segredos nos diagnósticos. O teste de integração usa as rotas reais com receptor controlado. A entrega distingue esse resultado de uma assinatura real no ChatGPT, que depende da atualização da instalação do usuário e da disponibilidade de Events no cliente.

## Referências consultadas em 22/10/2026

- https://developers.openai.com/plugins/build/mcp-events
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools

O perfil da OpenAI prevalece sobre diferenças provisórias no rascunho de Events, como o código de erro de callback. Não é uma migração de todos os clientes upstream para MCP 2.0.
