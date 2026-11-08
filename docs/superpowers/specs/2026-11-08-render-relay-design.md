# Ponte Cloud Relay — endereço estável na Render

## Objetivo
Publicar uma entrada HTTPS estável para a Ponte existente, mantendo execução,
OAuth, consentimento, credenciais administrativas, watchers e backups no PC.
A solicitação do usuário escolheu Render em vez de ngrok ou Cloudflare.

## Escopo desta entrega
Um serviço privado por computador, sem cadastro multiusuário, sem banco na nuvem,
sem alteração do núcleo 0.10.0 e sem contratar recursos pagos. Módulo complementar
independente, Node 22.12+, sem dependências novas. O blueprint usa plano Free.

## Abordagem
O PC inicia conexões HTTPS de saída. O relay mantém long polling autenticado para
entregar requisições HTTP ao agente. O agente encaminha uma única vez à API
loopback, nunca ao painel, e devolve o status, cabeçalhos selecionados e bytes.
O endereço do serviço Render torna-se publicUrl e emissor OAuth fixos. A troca
inicial de emissor exige nova autorização; reiniciar com o mesmo estado e URL
não muda o emissor. A validade/revogação normal do OAuth continua existindo.

WebSocket também serviria, mas exigiria uma nova dependência ou implementação do
protocolo. Long polling permite iniciar com Node nativo, preservando os contratos
stateless/JSON atuais. Não é o watcher nem um agendador de chat. Um simples
redirect para ngrok não resolve a mudança de emissor e foi descartado.

## Limites e segurança
Rotas HTTP permitidas explicitamente. Nada de /admin, caminhos arbitrários,
proxy aberto, shell ou upload da pasta .ponte. Segredo exclusivo do agente,
diferente dos tokens admin/API/OAuth. Uma sessão de agente por serviço; 4 workers.
Corpos limitados: 1 MiB de entrada e 8 MiB de resposta; 16 requisições pendentes.
Timeout público 65 s; chamada local 55 s; poll 20 s; heartbeat 10 s; lease 45 s.
Nenhuma requisição de ferramenta é reexecutada por falha de comunicação.
Estado de execução incerto é reportado como unknown. Sem fila durável na nuvem.
Falhas antes do envio são reportadas como not_sent. TLS termina na Render: o
relay e a conta de hospedagem precisam ser confiáveis; não é criptografia ponta
a ponta contra o operador. Não há suporte a SSE infinito nesta primeira versão.

## Aceitação
Testes reais em sockets locais para fluxo, bloqueios, auth, OAuth/redirects,
callbacks, limites, desconexão e não repetição. Teste em Render e no PC somente
será declarado após observar serviço implantado e bridge_status real pelo domínio.
O núcleo e contas reais de clientes não são validados por testes do relay.
