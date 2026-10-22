# Acompanhar tarefas externas com a Ponte MCP 0.7.0

[Índice da documentação](README.md) · [ChatGPT](CHATGPT.md) · [Claude](CLAUDE.md) · [MCP Events](MCP-EVENTS.md) · [API e ferramentas](API.md)

Um watcher mantém na Ponte o acompanhamento de uma tarefa e seu resultado. O executor envia um recibo explícito de conclusão, falha ou necessidade de intervenção. Use esse fluxo para uma demanda executada pelo Claude em uma sessão tmux, ou para um processo cujo resultado final você controla. Os nomes de projeto, IDs de execução e caminhos deste guia são exemplos; substitua-os pelos valores da sua demanda.

**Crie o watcher antes de delegar a demanda.** O sucesso de `tmux send-keys` confirma apenas que o comando enviou teclas. O job de SSH/tmux pode acabar enquanto o Claude continua trabalhando. O acompanhamento `signal` só termina quando a Ponte recebe o sinal autenticado para o `runId` correto, quando chega seu prazo, ou quando o acompanhamento é cancelado.

O watcher não observa automaticamente a janela do terminal, texto impresso, estado idle do tmux ou fim de turno do Claude. O critério de conclusão pertence ao executor e deve estar explícito na demanda.

## Watcher e MCP Events

| Aspecto | Watcher `signal` | MCP Events da Ponte |
|---|---|---|
| Direção do callback | Executor → Ponte | Ponte → cliente inscrito |
| Quem fornece URL e credencial | A Ponte, no resultado de `bridge_watch_create` | O cliente, em `events/subscribe` |
| Autenticação do aviso | Bearer exclusivo daquele watcher | Assinatura HMAC do webhook com o segredo da inscrição |
| O que acompanha | Recibo da tarefa identificada por `runId` | Estado terminal de um job identificado por `jobId` |
| Como consultar o resultado | `bridge_watch_get` ou `bridge_watch_wait` | `bridge_job` após o aviso |
| Retomada de um chat encerrado | Não oferece | Depende de suporte, assinatura e processamento pelo cliente |

Não é necessário criar cron, automation ou tarefa no agendador do ChatGPT/Claude para usar watchers. O retorno individual informa **`monitorDurable: true`** e **`canWakeClosedConversation: false`**. A duração do acompanhamento na Ponte é independente da duração do turno do cliente.

Na **0.7.0**, o único evento anunciado é `ponte.job.completed`: não há evento de conclusão de watcher. Assinar o job de criação de um watcher acompanha a criação; assinar um job que envia texto ao tmux acompanha o envio. Para o resultado da tarefa externa, consulte o watcher. O [guia de MCP Events](MCP-EVENTS.md) explica o fluxo separado de inscrição. Não invente um callback do ChatGPT nem reutilize as credenciais de um fluxo no outro.

## Ferramentas e prazos

| Ferramenta MCP | Uso | Passa pela fila de jobs? |
|---|---|---|
| `bridge_watch_create` | Criar um acompanhamento `signal` ou `job`, sujeito à política de aprovação | Sim; risco `write` |
| `bridge_watch_get` | Consultar um `watcherId` da conexão autenticada | Não |
| `bridge_watch_list` | Listar os acompanhamentos dessa conexão, com paginação | Não |
| `bridge_watch_wait` | Aguardar um estado terminal durante esta chamada | Não |
| `bridge_watch_cancel` | Cancelar somente o acompanhamento; o processo externo continua sob responsabilidade do executor | Não |

Mesmo em `approvalMode: "all"`, get, list, wait e cancel são controles diretos, autenticados, sem um novo job de aprovação. `bridge_watch_list` aceita `offset` de 0 a 500 e `limit` de 1 a 500, com padrões 0 e 50; retorna `watchers`, `total`, `offset` e `limit`. Use essa lista para recuperar o ID da mesma conexão depois de uma desconexão.

O prazo do watcher é de **1 hora por padrão**, configurável de **1 segundo a 7 dias** por `timeoutMs`. Há no máximo 100 acompanhamentos ativos e 500 registros retidos; ao atingir a capacidade, a criação remove o terminal mais antigo, nunca um acompanhamento ativo. Há no máximo 200 chamadas em espera, sendo 20 por watcher. O tempo de uma chamada `bridge_watch_wait` é separado: **25 segundos por padrão**, de **0 a 300 segundos** por `waitMs`. `waitMs: 0` consulta sem aguardar.

O cliente pode encerrar a chamada antes desse prazo. Desconectar ou parar uma espera libera somente aquele aguardador: o watcher `signal` continua no serviço e sobrevive ao reinício da Ponte. Um novo `bridge_watch_wait` ou `bridge_watch_get` recupera seu estado. A conexão precisa continuar autorizada. Revogar o acesso cancela os acompanhamentos ainda em `waiting`; os resultados existentes deixam de ser acessíveis por essa autorização. Uma nova autorização OAuth não herda os registros da anterior. Clientes stdio que compartilham o token API usam a mesma identidade local.

## 1. Criar o acompanhamento antes de enviar a demanda

Escolha um `runId` exclusivo para essa demanda, de 1–128 caracteres, sem caracteres de controle e não composto só de espaços, e um nome descritivo. Chame `bridge_watch_create` com:

```json
{
  "name": "meu-projeto: validar demanda de revisão",
  "trigger": {
    "type": "signal",
    "source": "claude-code",
    "runId": "meu-projeto-demanda-20261022-001"
  },
  "timeoutMs": 3600000,
  "idempotencyKey": "meu-projeto-demanda-20261022-001"
}
```

Se houver `pending_approval`, aprove no painel e consulte o **mesmo `jobId`** com `bridge_job` até recuperar o resultado da criação. Não delegue antes de ter o `watcherId` e as credenciais. `jobId` identifica essa criação; `watcherId` identifica o acompanhamento que será usado por get, wait e cancel.

Repetir a criação com a mesma `idempotencyKey`, os mesmos argumentos e a mesma identidade autenticada recupera o watcher e seu token enquanto o registro estiver retido, inclusive após reinício. Reutilizar a chave com conteúdo diferente é conflito. O prazo original não é renovado, nem um watcher terminal é reaberto. Essa chave é um argumento de `bridge_watch_create`; se usar `bridge_call`, mantenha-a dentro de `arguments`. A chave opcional no nível de `bridge_call` identifica o job de invocação e tem um ciclo de vida separado.

O conteúdo de resultado da criação contém o watcher público e, para `signal`, `callback`. Recorte ilustrativo, sem o envelope MCP e os metadados do job:

```json
{
  "watcherId": "ID_RETORNADO_PELA_PONTE",
  "status": "waiting",
  "callback": {
    "url": "https://sua-ponte.exemplo.com/hooks/watchers/ID_RETORNADO_PELA_PONTE/signal",
    "token": "TOKEN_EXCLUSIVO_RETORNADO_NA_CRIACAO",
    "method": "POST",
    "body": {
      "eventId": "UUID_DO_EVENTO",
      "runId": "meu-projeto-demanda-20261022-001",
      "status": "succeeded",
      "summary": "Resumo explícito do resultado"
    }
  }
}
```

Use a URL retornada, acessível a partir do executor. Para um executor remoto, configure a origem HTTPS pública da API antes da criação e encaminhe `/hooks/watchers/.../signal`. Sem origem pública, a URL retornada usa o endereço local da API, que serve apenas a um executor no mesmo computador.

O token só autoriza sinalizar esse watcher; não substitua por tokens de administração, da API ou de OAuth. Listas, consultas ao watcher e o painel não retornam esse segredo. Ele fica no resultado de criação disponível ao proprietário do job enquanto esse job estiver em memória. Cópias arquivadas por Events removem o token; para recuperá-lo, reutilize a criação idempotente com os mesmos argumentos.

## 2. Preparar o produtor no ambiente do executor

O produtor é [scripts/ponte-watch-notify.mjs](../scripts/ponte-watch-notify.mjs), independente da instalação da Ponte: requer **Node >=22.12.0** e usa somente módulos internos. Disponibilize esse arquivo no ambiente autorizado onde o Claude executa suas ferramentas. Os comandos abaixo são exemplos de configuração manual; não instalam nada nem criam hooks globais.

Ele lê três variáveis de ambiente:

| Variável | Valor |
|---|---|
| `PONTE_WATCH_URL` | `callback.url` retornado pela criação. |
| `PONTE_WATCH_TOKEN` | `callback.token`, exclusivo desse watcher. |
| `PONTE_WATCH_RUN_ID` | O mesmo `trigger.runId` usado na criação. |

Se você vai iniciar uma nova sessão Claude, exporte as variáveis no shell que iniciará o processo. Um Claude já aberto dentro do tmux não recebe exports feitos em outro shell. Para essa sessão existente, você pode preparar um arquivo privado e instruir suas chamadas Bash a carregá-lo antes do envio. Exemplo **Bash**, executado no ambiente do produtor, com o token digitado sem eco e sem colocá-lo na linha de comando:

```bash
install -d -m 700 "$HOME/.config/ponte-watch"
(
  set +x
  umask 077
  read -r -p 'callback.url: ' PONTE_WATCH_URL
  read -r -s -p 'callback.token: ' PONTE_WATCH_TOKEN
  printf '\n'
  read -r -p 'runId: ' PONTE_WATCH_RUN_ID
  printf 'export PONTE_WATCH_URL=%q\nexport PONTE_WATCH_TOKEN=%q\nexport PONTE_WATCH_RUN_ID=%q\n' \
    "$PONTE_WATCH_URL" "$PONTE_WATCH_TOKEN" "$PONTE_WATCH_RUN_ID" \
    > "$HOME/.config/ponte-watch/meu-projeto-demanda-20261022-001.env"
)
```

O arquivo deve permanecer privado, fora do repositório. Não o imprima em transcrições ou logs. Ele contém comandos Bash produzidos por `%q`; carregue somente o arquivo criado por você. Cada demanda deve ter seu próprio arquivo/ambiente para não trocar o `runId` nem o token de tarefas simultâneas.

## 3. Delegar com um critério explícito de conclusão

Envie a demanda ao Claude da sessão **meu-projeto** pelo mecanismo já autorizado, incluindo seus critérios de aceite e os caminhos reais do script e do arquivo privado. Exemplo de instrução para essa sessão:

```text
Execute a demanda meu-projeto-demanda-20261022-001 e valide os critérios
de aceite descritos acima. Ao terminar a demanda inteira, envie o recibo
à Ponte com o script /CAMINHO/ponte-watch-notify.mjs. Carregue primeiro
o arquivo privado ~/.config/ponte-watch/meu-projeto-demanda-20261022-001.env
na mesma chamada Bash. Não mostre o token nem o conteúdo do arquivo.

Use succeeded somente após validar os critérios de aceite e descreva
o que foi verificado no resumo. Use failed se o trabalho falhou, com
um resumo factual; use needs_input se depender de uma decisão humana.
Não envie sucesso ao apenas receber o prompt ou encerrar um turno.
```

Na conclusão validada, a chamada Bash do executor pode ser:

```bash
set +x
source "$HOME/.config/ponte-watch/meu-projeto-demanda-20261022-001.env"
node /CAMINHO/ponte-watch-notify.mjs \
  --status succeeded \
  --summary 'Demanda concluída; critérios de aceite conferidos e testes relevantes aprovados.' \
  --exit-code 0
```

Para uma pendência humana, use `--status needs_input --summary 'É necessário escolher entre as alternativas descritas no resultado.'`. Esse é um estado terminal do acompanhamento: depois da decisão, crie um novo watcher para a próxima etapa. Não converta uma pendência em sucesso por ausência de atividade.

O evento [`Stop` do Claude Code](https://code.claude.com/docs/en/hooks#stop) indica que o agente principal terminou de responder. Por isso, um `Stop` genérico não comprova os critérios de aceite de uma demanda. Esta integração não instala um hook global que transforma todo fim de turno em conclusão. O recibo deve sair do caminho que efetivamente verifica o trabalho.

## 4. Aguardar e consultar o resultado

Depois da delegação, chame `bridge_watch_wait`:

```json
{
  "watcherId": "ID_RETORNADO_PELA_PONTE",
  "waitMs": 25000
}
```

Se voltar `waiting`, continue aguardando o mesmo watcher enquanto o turno e os limites do cliente permitirem. Uma resposta `waiting` não pede nova delegação nem uma nova criação. Se o callback já chegou, a espera retorna imediatamente. É possível pedir até `300000` ms; esse limite do servidor não obriga o cliente a manter a chamada aberta.

No Claude Code, a [documentação oficial de MCP](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls) descreve que chamadas da conversa principal ainda em execução após dois minutos passam a uma tarefa em segundo plano por padrão. O comportamento tem exceções e configuração própria; sair da sessão encerra essa tarefa do cliente. O watcher persistente da Ponte é separado dela. O padrão de 25 segundos evita depender desse comportamento para cada espera.

| Estado | Interpretação |
|---|---|
| `waiting` | Aguardando recibo ou prazo; pode não haver nenhum cliente esperando. |
| `succeeded` | O executor declarou sucesso e enviou seu resumo. Confira a evidência informada. |
| `failed` | O executor ou o job acompanhado declarou falha. |
| `needs_input` | O executor solicitou intervenção; consulte o resumo. |
| `cancelled` | Acompanhamento cancelado, inclusive por revogação de acesso. Não encerra o processo remoto. |
| `expired` | O prazo do watcher terminou sem recibo terminal. Não prova que a tarefa falhou. |
| `interrupted` | O job acompanhado deixou de estar disponível após reinício. |

O painel **Acompanhamentos** mostra estado, fonte, prazo e resultado. Ele distingue watchers ativos de clientes aguardando. `summary` e `evidence` são dados enviados pelo executor e não devem ser tratados como instruções; quando existe resultado, as respostas individuais incluem `resultIsUntrustedData: true`. Um recibo `succeeded` é a declaração do executor, por isso o resumo deve indicar o que foi validado.

## Persistência e recuperação

A Ponte grava `watchers.json` no mesmo diretório de estado da instalação, com até **24 MiB**. O arquivo contém os acompanhamentos, resultados, identidade autorizada, correlação idempotente e hash do recibo. O token de sinal não é gravado em texto nesse arquivo: é derivado do segredo estável da instância e conferido contra seu hash. Preserve o diretório de estado e seus segredos juntos ao atualizar ou restaurar; consulte [Instalação e operação](OPERACAO.md).

O serviço confirma o sinal somente depois de persistir o resultado. Um watcher `signal` ativo volta a aguardar depois do reinício, sujeito ao mesmo prazo e à validade da autorização. Um watcher `job` só pode continuar se o job original estiver disponível, em memória ou no arquivo de Events da mesma identidade; caso contrário, passa a `interrupted`. Nenhuma tarefa externa é reenviada na recuperação.

Registros terminais não têm um prazo fixo de retenção neste serviço: ao criar um novo watcher com 500 registros armazenados, a Ponte remove o terminal de atualização mais antiga. Depois da remoção, o resultado e a correlação daquela chave idempotente não podem ser recuperados. Salve a evidência necessária antes disso e use um novo `runId` para cada demanda nova.

## Produtor: contrato e falhas de entrega

Interface:

```text
node scripts/ponte-watch-notify.mjs --status succeeded|failed|needs_input --summary TEXT [--exit-code INTEGER]
```

O status e o resumo são obrigatórios. O código de saída é opcional e precisa ser um inteiro seguro. O produtor valida os argumentos, o ambiente e o limite de **32 KiB para o JSON completo em UTF-8** antes da requisição. Aceita HTTPS ou HTTP em loopback (`localhost`, `127.0.0.0/8`, `::1`), sem usuário/senha, query ou fragmento na URL. Redirecionamentos são recusados.

O corpo POST é `{eventId, runId, status, summary, exitCode?}`, com `Authorization: Bearer TOKEN`. O UUID e os bytes do corpo permanecem iguais nas tentativas. Há no máximo **3 tentativas no total**, **5 segundos por tentativa** e pequenas pausas de 200 e 400 ms. Somente falhas transitórias de rede, HTTP 408, 429 ou 5xx são repetidas. Os demais 4xx e todos os redirects encerram a entrega. O produtor não imprime o token, a URL nem o corpo da resposta, inclusive em erro.

Código de saída `0` do produtor significa que a Ponte confirmou o recebimento HTTP. Código `1` significa que o produtor não obteve essa confirmação. Um erro de rede depois do envio pode acontecer mesmo que o serviço tenha persistido o resultado; consulte o watcher antes de tomar outra ação. Uma nova execução do script gera outro `eventId`; as repetições idempotentes automáticas pertencem à mesma execução. Com a autorização ainda válida, reenviar o mesmo `eventId` e conteúdo retorna o resultado já persistido. Um novo sinal para um watcher terminal recebe conflito, inclusive se tiver outro `eventId` com resumo idêntico; o resultado existente não é sobrescrito.

O endpoint também aceita `evidence` como objeto JSON limitado no corpo, para produtores próprios; essa CLI pequena envia somente os campos listados acima. Nem resumo nem evidência devem incluir credenciais ou dados sensíveis desnecessários. O limite é de 60 sinais autenticados por watcher por minuto; credenciais inválidas não consomem o orçamento de entrega dos acompanhamentos. Falha temporária de persistência retorna HTTP 503, sem confirmar o resultado, para permitir retry com o mesmo evento.

### Wrapper de um processo com verificação final

Se um processo representa **toda** a demanda e só retorna `0` depois de suas verificações finais, um wrapper Bash pode emitir o recibo. Não envolva apenas `tmux send-keys`, SSH que inicia trabalho em segundo plano ou um comando que retorna antes do trabalho real.

```bash
#!/usr/bin/env bash
set -u
set +x
source "$HOME/.config/ponte-watch/meu-projeto-demanda-20261022-001.env"

if bash /CAMINHO/executar-e-validar-demanda.sh; then
  task_code=0
  status=succeeded
  summary='Processo completo terminou com sucesso após suas verificações finais.'
else
  task_code=$?
  status=failed
  summary='Processo completo falhou; consulte os registros autorizados da execução.'
fi

node /CAMINHO/ponte-watch-notify.mjs \
  --status "$status" --summary "$summary" --exit-code "$task_code"
notify_code=$?
if [ "$notify_code" -ne 0 ]; then
  printf '%s\n' 'Recibo não confirmado; consulte o watcher na Ponte.' >&2
fi
# Preserve a falha da tarefa e exponha falha de entrega após tarefa bem-sucedida.
if [ "$task_code" -ne 0 ]; then exit "$task_code"; fi
exit "$notify_code"
```

Para acompanhar um job da própria Ponte, crie `trigger: {"type":"job","jobId":"JOB_ID"}`. Esse watcher segue o estado terminal do job e não precisa de callback. Se o job apenas envia uma demanda ao tmux, seu sucesso continua significando somente a conclusão desse envio; use o fluxo `signal` para a demanda executada pelo Claude.

## Diagnóstico

| Sintoma | Próximo passo |
|---|---|
| `waiting` após `tmux send-keys` bem-sucedido | Verifique se o executor recebeu o critério de conclusão e consegue emitir o recibo. |
| O cliente encerrou a espera | Consulte ou aguarde o mesmo `watcherId`; não reenvie a demanda. |
| Produtor informa HTTP 401 | Confira token, watcher e autorização original; o endpoint não distingue credencial inválida de acompanhamento inacessível. |
| Produtor informa HTTP 404 | Confira a URL e o encaminhamento do caminho `/hooks/watchers/.../signal`. |
| Produtor informa conflito HTTP 409 | Consulte o estado: o watcher pode já ter recebido um evento terminal diferente. |
| Produtor informa HTTP 413 ou limite local | Reduza o resumo/evidência; o JSON completo deve caber em 32 KiB. |
| Produtor recusa a URL | Use HTTPS remoto ou HTTP loopback, sem query, fragmento, usuário ou senha. |
| Callback remoto não chega | Confira alcance da API pública e encaminhamento de `/hooks/watchers/.../signal`. |
| Chat encerrado não recebeu nova mensagem | A persistência do watcher não cria um transporte de retomada do cliente. Consulte o resultado ao retornar. |
| Criação retorna conflito de idempotência | Use os mesmos argumentos para recuperar a demanda original; para uma demanda diferente, escolha novo `runId` e nova chave. |
| Criação ficou pendente e ainda não há `watcherId` | Resolva o job de criação com `bridge_job`; ainda não delegue a tarefa externa. |
| Produtor não tem as variáveis no Claude aberto | Exports em outro shell não mudam um processo existente; carregue o arquivo privado na mesma chamada Bash que executa o produtor. |

## Validação e referências

Teste local do produtor: `node --import tsx --test tests/watchers-notify.test.ts`. Os testes usam listeners HTTP temporários e verificam recibo, autorização, repetição do mesmo evento, erro permanente, redirect e ausência de segredo no stderr. Não fazem chamadas a uma VPS, tmux real ou contas dos clientes. O [histórico de validação](VALIDACAO.md) registra o que foi efetivamente executado; esta revisão documental não enviou demandas nem instalou hooks.

O contrato é definido por [src/watchers/types.ts](../src/watchers/types.ts), [src/watchers/tools.ts](../src/watchers/tools.ts), [src/watchers/service.ts](../src/watchers/service.ts) e pelo [endpoint HTTP](../src/http.ts). As referências externas consultadas em **22/10/2026** foram:

- [Claude Code — MCP e chamadas longas](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls).
- [Claude Code — significado do hook Stop](https://code.claude.com/docs/en/hooks#stop).
- [OpenAI — MCP Events e callback fornecido pelo cliente](https://developers.openai.com/plugins/build/mcp-events).
