# Limites de confiança da Ponte MCP 0.6.0

[Índice da documentação](README.md) · [Arquitetura](ARQUITETURA.md) · [Operação e backups](OPERACAO.md)

Este documento explica o que os controles do aplicativo fazem. Eles não substituem permissões do sistema operacional, isolamento de processos ou revisão do código que será executado.

## Separação de interfaces

- O painel e suas rotas `/admin/*` escutam em `127.0.0.1:4317`, por padrão.
- A API, OAuth, MCP e os callbacks de watchers escutam em `127.0.0.1:4318`, por padrão. As portas são configuráveis; o vínculo a loopback permanece.
- Administração e API REST usam tokens distintos, gerados aleatoriamente com 32 bytes. `/mcp` também aceita access tokens OAuth.
- Tokens API e OAuth não mudam a política de aprovação, não aprovam manualmente trabalhos, não alteram projetos e não configuram servidores. A criação de watchers segue a política de ferramentas; seus controles diretos verificam autorização e propriedade.
- O callback `/hooks/watchers/:watcherId/signal` exige uma credencial exclusiva daquele acompanhamento. Ele não usa os tokens administrativo/API nem o access token OAuth.
- O painel mantém o token administrativo apenas em `sessionStorage` da aba. Credenciais administrativas, tokens API, access/refresh tokens e tokens de sinal são enviados nos campos de autenticação adequados, sem inclusão na URL.
- Host é validado nas duas interfaces. Origin é restrito no painel, no consentimento e em `/mcp`; os endpoints do protocolo OAuth permitem acesso entre origens para interoperabilidade. A origem pública é configurada explicitamente; respostas do painel usam CSP e proíbem enquadramento por outros sites.

Um túnel deve encaminhar exclusivamente a porta da API, incluindo os endpoints OAuth e de descoberta. Inclua `/hooks/watchers/*` nesse encaminhamento quando o executor estiver em outro computador. A porta administrativa nunca deve ser publicada. O provedor OAuth depende de uma origem HTTPS estável em `publicUrl`; não usa headers encaminhados por qualquer proxy como fonte de identidade do emissor.

A autenticação Bearer administrativa e a autenticação com token API têm limites próprios de 600 requisições válidas por minuto; REST e MCP com o mesmo token API compartilham seu contador. Chamadas MCP com OAuth têm outro contador de 600 requisições válidas por minuto, compartilhado entre grants. Os contadores são locais ao processo, não cotas individuais do provedor. Corpos JSON comuns são limitados a 1 MiB; os sinais têm limite menor de 32 KiB. A implementação está em [src/http.ts](../src/http.ts) e [src/auth/http.ts](../src/auth/http.ts).

## Consentimento OAuth e identidade

Cada conexão começa com registro de cliente e authorization code com PKCE `S256`. O servidor valida o cliente, o redirect registrado, o recurso e o scope antes de criar a solicitação. A página pública de consentimento mostra um código de oito caracteres; o proprietário compara esse código com o pedido no painel local e aprova ou rejeita.

**A página pública não recebe o token de administração.** Saber o código de verificação não permite aprovar a conexão; ele serve para relacionar as telas. O cliente registrado e seu nome também não constituem autorização. A decisão precisa ocorrer na interface administrativa autenticada, inclusive quando a aprovação automática de ferramentas está ativa.

Os pedidos pendentes expiram após 10 minutos. Após aprovar, o retorno ao cliente emite um código OAuth de uso único, válido por 2 minutos. O redirect de autorização inclui `state` quando fornecido e o `iss` exato anunciado na descoberta. O código de autorização pode aparecer nesse redirect, conforme o protocolo; ele não é um access token e sua troca exige os vínculos da autorização e a comprovação PKCE.

O access token vale por até 1 hora, sem ultrapassar a validade da autorização, e está vinculado ao cliente, ao recurso `/mcp` e ao scope `ponte:tools`. O refresh token é rotacionado a cada renovação. A autorização renovável tem validade absoluta de 30 dias; renovar não prolonga esse prazo. Se o cliente não tiver registrado o grant `refresh_token`, a autorização vale por até 1 hora. A reutilização de um refresh token já consumido revoga sua família de tokens.

O registro DCR suporta `none` e `client_secret_post`. Clientes e segredos são persistidos sem expiração automática do segredo. Há um limite de 100 cadastros; ao atingi-lo, o cadastro mais antigo que nunca foi autorizado e não tem fluxo ativo pode ser descartado. Clientes já autorizados são preservados, inclusive após revogar sua autorização. A expiração de access/refresh tokens e a revogação da autorização são controles separados da existência do cliente registrado.

Esta é uma ponte de **um único proprietário**. Todas as conexões aprovadas compartilham os mesmos projetos e regras locais. Revogar uma conexão limita aquele acesso, mas OAuth não acrescenta isolamento por projeto, conta ou organização. O scope `ponte:tools` permite solicitar as ferramentas expostas; permissões de projeto, aprovação de trabalhos e lista de ferramentas permitidas continuam sendo aplicadas.

Trabalhos, watchers e assinaturas de Events têm um vínculo adicional com a identidade que os criou. Consultas por `bridge_job`, consultas REST, cancelamentos e recuperação de resultados arquivados exigem a mesma autorização OAuth ou identidade do token API. A identidade se mantém na renovação de tokens daquela autorização; um novo consentimento é um vínculo diferente. Clientes que usam o mesmo token API compartilham a identidade. Consultas, listagens, esperas e cancelamentos de watchers também exigem o proprietário autorizado. O administrador local mantém acesso aos registros pelo painel. Esse controle não impede que conexões autorizadas solicitem novas operações sobre os projetos compartilhados, conforme suas permissões.

## Revogar e preservar credenciais

Para encerrar uma autorização OAuth, use **Conectar IA → Clientes conectados → Revogar acesso**. O endpoint OAuth `/revoke` permite ao cliente correspondente revogar a autorização inteira vinculada ao access ou refresh token apresentado, incluindo os demais tokens desse grant. A revogação impede novos acessos, renovações, sinais de watchers e entregas de Events dessa autorização. Watchers em `waiting` passam a `cancelled` na atualização do serviço. Jobs já aceitos não são cancelados automaticamente, e efeitos externos não são desfeitos; quando necessário, trate esses jobs separadamente no painel.

Watchers e Events verificam a validade do grant, incluindo prazo, recurso, scope e emissor. O vencimento de um access token isolado não encerra um acompanhamento cujo grant renovável ainda é válido. Trocar `publicUrl` invalida grants, tokens, pedidos pendentes e códigos do emissor anterior, preservando os cadastros de clientes. As regras estão em [src/auth/provider.ts](../src/auth/provider.ts).

**Preserve `secrets.json` durante atualizações e restaurações.** Além de autenticar clientes, o token API é a chave estável usada para derivar credenciais de sinais. O serviço confere os hashes de todos os watchers `signal` persistidos ao abrir o estado, inclusive registros terminais. Recriar o token API mantendo o `watchers.json` antigo faz essa verificação falhar e pode impedir a inicialização.

A versão 0.6.0 não oferece um comando de rotação que migre coordenadamente essas chaves e identidades. Por isso, apagar `secrets.json` e executar `init` não é um procedimento de atualização nem de recuperação de watchers. Uma rotação planejada precisa considerar os acompanhamentos, as identidades API de jobs/Events e a reconfiguração de clientes. Trocar tokens legados também não revoga, por si só, os grants de `oauth.json`. Em caso de credencial comprometida, interrompa o acesso afetado e trate cada autorização antes de restaurar o serviço; não publique arquivos de estado para pedir diagnóstico.

Ao atualizar ou mover a instalação, preserve o diretório de estado e passe `--state-dir` com seu caminho absoluto. Perder `oauth.json` interrompe a reutilização dos clientes e tokens registrados. Backups desse arquivo contêm estado de autorização sensível e devem receber a mesma proteção do original.

## Arquivos

As ferramentas de arquivos aceitam caminhos relativos e verificam a raiz cadastrada, segmentos, links simbólicos, hard links e diretórios protegidos. Rejeitam travessia, caminhos UNC/absolutos, nomes de dispositivos Windows, alternate data streams, `.env*`, `.git`, `.ssh`, `.aws`, diretório interno da ponte e outros caminhos sensíveis.

Leituras aceitam apenas texto UTF-8 limitado. Escritas exigem `expectedHash`, calculado sobre o conteúdo anterior. O arquivo é preparado temporariamente e substituído após novas verificações; alterações concorrentes da própria ponte são serializadas por caminho. O conteúdo anterior é preservado em backup. Para criar um arquivo inexistente com `local_write_file`, envie `expectedHash: null`; para editar ou substituir, use o SHA-256 retornado pela leitura.

Arquivos têm limite de 1 MiB. A prévia recusa diffs maiores que 512 KiB, com mais de 2.000 linhas alteradas ou que excedam 250 ms de cálculo. Uma alteração que não possa ser revisada nesses limites é recusada antes de qualquer escrita; divida mudanças muito grandes. A busca tem orçamento de 2.000 arquivos e 16 MiB, incluindo arquivos binários descartados, e retorna até 200 correspondências.

Isso reduz acidentes e acessos indevidos pela API. APIs portáteis do Node.js não tornam todas as verificações de ancestral imunes a trocas concorrentes feitas por outro processo local. Não considere esse mecanismo uma fronteira contra software malicioso já executando com a mesma conta do usuário. As verificações e limites estão em [src/tools/local.ts](../src/tools/local.ts).

## Terminal e MCPs externos

O terminal fica desativado por projeto até habilitação local. Usa `spawn` sem shell implícito, argumentos separados, diretório verificado, saída e tempo limitados. O ambiente herdado é reduzido e a ferramenta não aceita overrides de ambiente. O timeout padrão é 30 segundos, configurável entre 100 ms e 120 segundos; a saída combinada tem padrão de 128 KiB e máximo de 1 MiB. Cancelamento tenta encerrar a árvore de processos.

**Um comando aprovado executa com os privilégios da conta que iniciou a ponte.** Ele pode acessar arquivos fora da pasta por caminhos absolutos, usar rede e chamar outros programas. A validação do diretório de trabalho não o confina. Não há container, AppContainer, VM ou sandbox de sistema operacional nesta versão.

Conectar um MCP stdio também inicia um programa local. O cadastro no painel é um ato administrativo; a revisão de chamadas não torna o programa em si confiável. Servidores MCP podem fornecer descrições e resultados incorretos ou instruções maliciosas. A ponte não concede execução automática com base apenas nas anotações de um upstream. `readOnlyTools` precisa ser configurado localmente com nomes originais; `allowedTools` limita a exposição. Credenciais de upstream podem usar referências de ambiente, e os transportes HTTP recusam redirecionamentos. Confira [INTEGRACOES.md](INTEGRACOES.md#servidores-upstream) e [src/mcp/hub.ts](../src/mcp/hub.ts).

## Política de aprovação e operações incertas

O padrão `mutations` exige revisão para alterações e comandos; `all` exige revisão também para leituras submetidas como ferramentas ao `JobManager`. `bridge_watch_create` é uma escrita e entra nessa política. Consultas de estado, controles de jobs e `bridge_watch_get/list/wait/cancel` são operações diretas de controle; não geram uma segunda aprovação, mas mantêm as verificações de identidade. Em **Visão geral → Você no controle → Política de aprovação → Aprovar automaticamente todas**, o proprietário escolhe `automatic`. Essa política libera solicitações pendentes válidas e novas chamadas locais e MCP, para todos os clientes autorizados e para o painel. A escolha persiste em `config.json` após reiniciar.

A aprovação automática preserva `allowWrite`, `allowExec`, as listas de ferramentas permitidas, a validação de argumentos, `expectedHash` e os backups. Novas conexões OAuth continuam exigindo consentimento local. O cliente de chat não consegue mudar essa política nem aprovar manualmente seus trabalhos.

A aprovação corresponde aos argumentos armazenados e à assinatura da ferramenta. A ponte revalida essa assinatura antes de aprovar e executar; mudanças relevantes de ferramenta ou configuração invalidam a solicitação. Aprovações pendentes expiram após 15 minutos. Ao desativar `automatic`, trabalhos aprovados automaticamente ainda na fila voltam à revisão quando exigido pela nova política; trabalhos já iniciados continuam.

A pausa bloqueia novas submissões e a partida de trabalhos enfileirados. Ela mantém consultas, cancelamentos de watchers e recebimento de sinais de acompanhamentos existentes. Ela não desfaz operações nem interrompe automaticamente as já iniciadas; para estas, use cancelamento. Uma falha de rede ou timeout em ferramenta externa pode deixar o resultado incerto. Confira o estado do destino antes de reenviar.

`bridge_job` pode esperar até 25 segundos por aprovação e execução do mesmo trabalho. Essa consulta não concede aprovação, não modifica a política e não reabre um turno encerrado.

A idempotência de jobs vale enquanto o trabalho estiver retido no processo atual. Reinício e remoção do histórico encerram essa janela. Watchers têm uma chave adicional e persistente, válida enquanto seu registro permanecer em `watchers.json`. Na criação via `bridge_call` ou REST, a chave externa identifica a submissão do job e a chave dentro dos argumentos identifica o watcher. Clientes não devem reapresentar automaticamente operações de resultado desconhecido após reinício. Fonte: [src/core/jobs.ts](../src/core/jobs.ts).

## Watchers e sinais do executor

O watcher nativo recebe a confirmação do trabalho real de um executor. Seu callback é uma entrada da Ponte: `POST /hooks/watchers/:watcherId/signal`, com `Authorization: Bearer <TOKEN_DO_WATCHER>`. A credencial permite sinalizar somente aquele acompanhamento; não permite listar projetos, executar ferramentas, consultar outros watchers ou administrar o serviço. Um executor remoto precisa usar a URL HTTPS da API. Não coloque a credencial na URL, em uma mensagem de chat, em argumentos expostos de um comando ou em logs.

A posse do token permite ao executor informar um resultado; ela não comprova, por si só, que o trabalho foi feito corretamente. `summary` e `evidence` são **dados não confiáveis**, assim como resultados de MCPs e conteúdo de arquivos. O cliente deve conferir a evidência pertinente e seguir a tarefa autorizada, sem executar instruções embutidas nesses campos.

O sinal precisa incluir UUID `eventId`, `runId` idêntico ao da criação, status `succeeded`, `failed` ou `needs_input`, e `summary`. O corpo completo é limitado a 32 KiB; `evidence` aceita dados JSON e `exitCode` é opcional. A correlação por `runId` impede aceitar por engano o recibo de outra execução. O fim de um comando de delegação, de `tmux send-keys` ou de um turno do executor não autoriza enviar sucesso antecipado.

A resposta de sucesso só é devolvida após persistir o resultado. Uma repetição com o mesmo `eventId` e conteúdo recupera o resultado, inclusive depois de reiniciar; um recibo diferente quando o watcher já terminou retorna conflito. Em falha de persistência, o executor pode tentar novamente o mesmo recibo. Sinais têm limite de 60 requisições autenticadas por minuto por watcher; tokens inválidos não consomem o orçamento de um acompanhamento legítimo. Essa repetição de entrega não repete a tarefa externa.

A criação retorna o token somente à identidade proprietária, no resultado do seu job. `get`, `list`, esperas e inspeções administrativas não revelam o token. Cópias desse job destinadas a Events ou a outro watcher também removem a credencial. Para recuperá-la, a mesma identidade pode repetir `bridge_watch_create` com a mesma chave persistente e os mesmos argumentos, respeitando novamente a política de criação. O estado guarda um hash do token; a credencial é derivada de um HMAC com o token API da instância e não fica em texto claro em `watchers.json`.

Cancelar o watcher encerra somente a observação. Um sinal novo posterior é recusado; o job original ou o executor pode continuar. A pausa global não impede o recibo de um acompanhamento já existente. Revogação ou vencimento do grant impede novos sinais e acesso por aquela identidade, mesmo que alguém ainda possua a credencial de callback.

Watchers `signal` sobrevivem ao reinício quando o estado e o segredo da instância são preservados. Watchers `job` não tornam jobs duráveis: um job indisponível após reiniciar leva a `interrupted`; se houver cópia em Events, o watcher pode refletir o estado recuperado, inclusive `cancelled`. Nenhuma tarefa é reenviada. Uma desconexão encerra apenas a espera corrente, e o cliente recupera o mesmo `watcherId` com `get` ou `list`. O watcher não reabre uma conversa encerrada e não exige agendamento no ChatGPT/Claude.

As regras estão em [src/watchers/service.ts](../src/watchers/service.ts), [src/watchers/tools.ts](../src/watchers/tools.ts) e [src/http.ts](../src/http.ts). O roteiro operacional está em [WATCHERS.md](WATCHERS.md).

## MCP Events e callbacks de saída

Events envia avisos da Ponte para o cliente compatível e usa outro tipo de credencial, separado do sinal recebido de um executor. O cliente precisa solicitar uma assinatura de `ponte.job.completed` com o ID de um trabalho criado pela mesma identidade autenticada. A identidade OAuth é a autorização concedida, e não apenas o nome do cliente registrado; autorizações diferentes não compartilham assinaturas nem acesso aos trabalhos. Events aplica o mesmo vínculo usado na consulta e no cancelamento de execuções. Isso não transforma os projetos e o catálogo compartilhados em uma plataforma multiusuário.

A URL de callback e o segredo vêm do cliente. A Ponte exige HTTPS, certificado válido e destino público; recusa credenciais na URL, fragmentos, loopback, redes privadas e endereços reservados. A resolução DNS é verificada em cada conexão, e o socket é conectado ao endereço validado, preservando Host e SNI do domínio. A implementação recusa redirecionamentos e não encaminha tokens OAuth, token API, token administrativo ou headers de upstream para o callback. Isso reduz o risco de usar uma assinatura como acesso indireto à rede local.

Antes de ativar o aviso, a Ponte envia um desafio de verificação assinado e exige a resposta correspondente. Há reaproveitamento temporário da verificação para a mesma identidade, URL e segredo. Os corpos usam HMAC-SHA256 conforme o perfil de webhooks de MCP Events; a chave é decodificada do formato `whsec_`, e a assinatura inclui ID, horário e os bytes exatos do corpo. Na rotação, as chaves anterior e atual podem assinar o mesmo evento durante cinco minutos. Não copie esses segredos para a conversa.

O evento contém somente `jobId`, nome da ferramenta, status e horários. O resultado da ferramenta e a mensagem de erro do trabalho são recuperados pelo cliente autenticado com `bridge_job`; argumentos de entrada não integram o aviso nem a cópia arquivada. O painel mostra status e tentativas, sem callback, segredo ou identidade OAuth interna. Erros de rede retornados ao painel e ao protocolo são sanitizados para não revelar credenciais do destino.

As entregas têm corpo de até 256 KiB, resposta de até 64 KiB, timeout de 10 segundos por tentativa e no máximo seis tentativas; o ID do evento permanece o mesmo nos reenvios. Respostas 410/413 encerram a entrega daquele evento. O destinatário precisa verificar assinatura, horário e duplicidade. Um 2xx confirma que recebeu a mensagem; não comprova que executou o próximo passo da conversa. Encerrar uma assinatura impede novas entregas dela, mas não desfaz um evento já recebido, não cancela o trabalho e não remove imediatamente a cópia arquivada do resultado.

A aprovação automática não inscreve conversas e não permite que um evento amplie a tarefa autorizada. Ao receber um aviso, o modelo deve consultar o trabalho correspondente e tratar seu conteúdo como dados, seguindo o pedido original. Uma assinatura do job de criação de um watcher só informa que o acompanhamento foi criado; ela não acompanha a tarefa externa. Consulte [MCP-EVENTS.md](MCP-EVENTS.md) para contrato, retenção e limites operacionais, e [src/events/webhook.ts](../src/events/webhook.ts) para as verificações de destinos e assinaturas.

## Retenção e dados

Configuração e backups são privados no filesystem mediante permissões do sistema. Arquivos usam modo `0600` e diretórios internos `0700` quando suportados. No Windows, o efeito de modos POSIX não equivale a uma política completa de ACL; mantenha a pasta em seu perfil e restrinja quem pode acessá-la.

`oauth.json` persiste os clientes registrados, seus segredos e os registros de autorização. Access e refresh tokens são armazenados por hash, não como valores reutilizáveis. O arquivo ainda é sensível: hashes não cifram os demais dados, e segredos de clientes precisam ser protegidos. O arquivo usa modo `0600` quando suportado, com a mesma ressalva de ACL no Windows. Nenhum desses arquivos deve ser incluído em um ZIP de distribuição ou repositório público.

`events.json` persiste callbacks, chaves de assinatura, assinaturas, estado das tentativas e resultados dos trabalhos acompanhados. Esses dados **não são cifrados em repouso**. As gravações usam arquivo temporário privado, sincronização e substituição do estado; a abertura recusa arquivos ligados por symlink/hard link ou pertencentes a outro usuário quando essa informação está disponível. A pasta e os arquivos usam os mesmos modos privados e ressalvas de ACL descritos acima. Uma cópia de segurança de `events.json` também pode conter resultados de ferramentas e credenciais de callback; proteja-a como o original.

`watchers.json` persiste nomes, gatilhos, `runId`, identidade proprietária, estado, resumos/evidências, hashes de credenciais e recibos de deduplicação. Esses conteúdos também **não são cifrados em repouso**. A abertura e as gravações verificam arquivo regular, propriedade quando disponível, links e tamanho; usam modo privado, arquivo temporário sincronizado e substituição do estado. Uma falha de validação não é resolvida apagando o estado sem antes preservar e investigar a cópia original.

A auditoria de jobs armazena ID, ferramenta, origem, risco, horário, status e, quando aplicável, `approval: "manual"` ou `approval: "automatic"`. Não inclui argumentos, resultados ou tokens. Ela gira ao ultrapassar aproximadamente 5 MiB, mantendo uma geração anterior. Ela não contém um histórico completo das chamadas diretas de controle dos watchers. Backups precisam ser gerenciados pelo usuário e podem conter código sensível.

Resultados e argumentos recentes ficam em memória. Limites: até 200 trabalhos retidos, até 4 MiB por resultado, redução do histórico concluído quando a retenção supera 64 MiB, quatro execuções simultâneas e prazo máximo de 120 segundos por job. Esses limites controlam uso de recursos; não são cotas do provedor de IA.

Events tem retenção própria: até 100 assinaturas, validade padrão e máxima de 24 horas por renovação e orçamento de 64 MiB para estado mais reserva dos resultados ainda pendentes. O limite por resultado permanece 4 MiB. As cópias persistidas removem os argumentos de entrada, mas os resultados podem conter os mesmos dados sensíveis da ferramenta original. Elas permanecem até a maior validade concedida para a combinação identidade/trabalho, inclusive após cancelar a assinatura. Autorizações invalidadas não podem recuperar esses resultados nem receber novos eventos. No reinício, a Ponte não executa novamente trabalhos interrompidos.

Watchers têm retenção própria: até 100 em `waiting`, 500 registros, 24 MiB de estado, 32 KiB por resultado, 200 esperas simultâneas e 20 esperas por watcher. O acompanhamento vale por 1 hora por padrão, entre 1 segundo e 7 dias; isso é diferente da espera de uma chamada, cujo padrão é 25 segundos e máximo é 300 segundos. Ao atingir 500 registros, uma nova criação remove o terminal mais antigo. Um resultado terminal não é apagado somente por passar de `expiresAt`; ele pode continuar armazenado até essa remoção por capacidade. A exclusão do registro também encerra sua janela de consulta e idempotência.

Proteja o diretório de estado completo e seus backups. Os segredos e resultados não devem entrar no repositório, em um ZIP de distribuição, em capturas de tela ou na conversa. Consulte [OPERACAO.md](OPERACAO.md) para preservar o conjunto ao atualizar.

Esta é uma aplicação pessoal. Não foi submetida a auditoria externa de segurança nem projetada como plataforma pública multiusuário. Testes de protocolo e segurança locais não comprovam, sozinhos, a integração na conta do usuário; consulte [VALIDACAO.md](VALIDACAO.md) e o [roteiro do ChatGPT](CHATGPT.md).
