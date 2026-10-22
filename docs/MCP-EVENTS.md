# MCP Events na Ponte MCP 0.4.0

MCP Events permite que a Ponte avise uma conversa inscrita quando um trabalho termina. O ChatGPT pode então consultar o resultado e continuar o pedido do usuário. A Ponte implementa o evento **`ponte.job.completed`**, com um `jobId` obrigatório por assinatura, usando webhooks verificados e assinados.

O cliente precisa oferecer Events e criar a inscrição. Instalar a Ponte, autorizar OAuth ou ativar a aprovação automática não cria uma assinatura e não habilita a retomada em qualquer conversa. A disponibilidade documentada pela OpenAI é **Work no navegador** e **Work com Cloud selecionado no aplicativo desktop**, sujeita às permissões da conta e do workspace. Fonte: [MCP Events da OpenAI](https://developers.openai.com/plugins/build/mcp-events), consultada em 22/10/2026.

## Começar pelo ChatGPT

1. Atualize a Ponte para **0.4.0**, preserve seu diretório de estado e reinicie o serviço. Os comandos estão no [README](../README.md#atualizar-uma-instalação-existente).
2. Mantenha a API em execução, com a origem HTTPS correta em **Conectar ChatGPT → URL pública da API**. Preserve uma conexão OAuth já concluída quando a origem continuar a mesma.
3. No plugin da Ponte, use **Atualizar ferramentas** e atualize a descoberta de eventos disponível na interface. Confirme que **`ponte.job.completed`** aparece na página do plugin.
4. Abra uma conversa Work compatível, com Cloud selecionado se estiver no desktop, e selecione a Ponte com `@`.
5. Peça uma tarefa em um projeto autorizado. Quando uma chamada retornar um `jobId` pendente de aprovação ou de execução, peça para acompanhar aquele ID e continuar quando ele terminar.

Exemplo de pedido, substituindo `JOB_ID` pelo ID realmente retornado:

```text
Acompanhe o trabalho JOB_ID com ponte.job.completed da Ponte.
Quando o aviso chegar, consulte bridge_job com esse mesmo ID, confira
o resultado e continue a tarefa que eu pedi. Não reenvie a operação
que criou o trabalho. Se falhar, for recusado ou cancelado, explique
o estado antes de propor outra ação.
```

O cliente envia `events/subscribe` com `arguments.jobId` e fornece a URL de callback e o segredo de assinatura. A Ponte verifica esse destino antes de aceitar a inscrição. Esses dados não precisam ser copiados pelo usuário e não devem aparecer na conversa.

Para um primeiro teste, use uma alteração pequena em um projeto de teste com a política de revisão ativa: a chamada fica em `pending_approval`, permitindo confirmar a inscrição antes de aprovar em **Execuções**. Não é necessário mudar sua política para usar Events. Se o trabalho concluir antes de terminar a inscrição, a Ponte também envia o estado final atual, desde que o trabalho ainda esteja disponível para aquela conexão.

## Conferir no painel

Abra **Conectar ChatGPT → Avisos de conclusão**. Cada item corresponde a uma assinatura de um trabalho, com validade, situação, número de tentativas e eventual erro de entrega.

| Estado | Significado |
|---|---|
| Aguardando conclusão | Assinatura aceita; o trabalho ainda não atingiu estado final |
| Aviso na fila | O trabalho terminou e a entrega está enfileirada |
| Tentando novamente | Uma tentativa foi iniciada ou há nova tentativa prevista |
| Aviso recebido | O callback respondeu com HTTP 2xx |
| Falha na entrega | A entrega foi encerrada sem confirmação de sucesso |

**Aviso recebido** confirma o recebimento pelo cliente. A prova de continuidade é observar a conversa consultar `bridge_job` e responder a partir do resultado, ou executar a próxima etapa já autorizada. O protocolo não permite à Ponte confirmar que o modelo concluiu essa continuação.

Use **Encerrar aviso** para cancelar a inscrição. Isso não cancela a execução, não desfaz um evento já recebido e não apaga imediatamente o resultado retido. O encerramento também pode ser solicitado pelo mecanismo de Events do próprio cliente. O painel nunca exibe a URL do callback ou o segredo de assinatura.

## Aprovação, espera e aviso são controles diferentes

| Mecanismo | Efeito |
|---|---|
| Política `automatic` | Libera ferramentas válidas conforme as permissões locais |
| `bridge_job` com `waitMs` | Espera até 25 segundos pelo mesmo trabalho durante uma chamada ativa |
| Assinatura de `ponte.job.completed` | Entrega um aviso depois que um trabalho específico chega ao estado final |

Uma conversa pode usar os três mecanismos. Uma assinatura também pode acompanhar um trabalho que exige aprovação manual; o aviso chega depois da execução, recusa, cancelamento ou expiração, e não apenas porque a aprovação foi concedida. Cada novo trabalho que precise de acompanhamento exige seu próprio `jobId` na assinatura. Consultas de acompanhamento não devem gerar uma cadeia de novas assinaturas.

Events não fornece um modelo de IA dentro da Ponte, não remove cotas e não acrescenta autorização para novas tarefas. A continuação depende das instruções da conversa e das decisões do cliente. Actions e o adaptador stdio mantêm seus fluxos anteriores; este recurso está implementado na entrada HTTP moderna de MCP.

## Contrato do endpoint MCP

A API continua na porta 4318 e usa o mesmo endpoint **POST `/mcp`** autenticado por OAuth ou pelo token API legado. O painel permanece local na porta 4317. O callback é um destino de saída fornecido pelo cliente; não existe nova porta de entrada que o usuário precise abrir para Events.

O adaptador de `src/mcp/modern.ts` atende o protocolo **`2026-07-28`**. Ele implementa este conjunto de métodos:

| Método | Finalidade |
|---|---|
| `server/discover` | Descobrir versões e capacidades `tools`/`events` |
| `tools/list` | Listar o catálogo, com paginação de até 100 ferramentas |
| `tools/call` | Chamar ferramentas pelo fluxo existente de validação e trabalhos |
| `events/list` | Descobrir o evento e seus schemas |
| `events/subscribe` | Criar ou renovar a inscrição de um trabalho |
| `events/unsubscribe` | Encerrar a inscrição de forma idempotente |

O SDK `@modelcontextprotocol/sdk` 1.32.1 continua atendendo as versões legadas e as conexões upstream. O adaptador não anuncia resources, prompts, sampling, tarefas do protocolo ou outros recursos não implementados. A atualização não é uma migração completa para o SDK v2.

### Requisição moderna

As requisições usam JSON-RPC 2.0 com `id`, `method` e `params`. Os metadados abaixo são obrigatórios em cada chamada; não se usa o fluxo `initialize` do MCP legado nesta versão:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "meu-cliente",
        "version": "1.0.0"
      }
    }
  }
}
```

`clientInfo` é opcional. O cliente pode declarar suas capacidades reais em `clientCapabilities`. Os cabeçalhos devem corresponder ao corpo:

```http
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: server/discover
Authorization: Bearer CREDENCIAL_DO_CLIENTE
```

`Mcp-Method` muda conforme o método. Em `tools/call`, o cabeçalho `Mcp-Name` deve corresponder a `params.name`. Schemas que usam `x-mcp-header` também exigem o espelho `Mcp-Param-*` dos argumentos anotados. A Ponte valida os espelhos antes de executar e não expõe pelo adaptador moderno uma definição de ferramenta com anotações de cabeçalho inválidas.

As respostas de sucesso incluem `resultType: "complete"` e `_meta["io.modelcontextprotocol/serverInfo"]` com nome e versão da Ponte. A descoberta e o catálogo usam `ttlMs: 0` e `cacheScope: "private"`. GET autenticado em `/mcp` retorna 405; a entrega de Events não usa um canal SSE aberto. A presença de `text/event-stream` em `Accept` faz parte do contrato HTTP do cliente, mesmo quando o servidor escolhe responder JSON.

Referências normativas: [metadados](https://modelcontextprotocol.io/specification/2026-07-28/basic/index), [transporte HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [descoberta](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) e [ferramentas](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

### Descobrir o evento

`events/list` recebe apenas os metadados de transporte. Não há uma segunda página do catálogo de eventos. O resultado contém:

```json
{
  "events": [
    {
      "name": "ponte.job.completed",
      "description": "Avisa quando um trabalho específico chega ao estado final.",
      "delivery": ["webhook"],
      "inputSchema": {
        "type": "object",
        "properties": {
          "jobId": { "type": "string", "format": "uuid" }
        },
        "required": ["jobId"],
        "additionalProperties": false
      },
      "payloadSchema": {
        "type": "object",
        "properties": {
          "jobId": { "type": "string", "format": "uuid" },
          "tool": { "type": "string" },
          "status": {
            "type": "string",
            "enum": ["succeeded", "failed", "rejected", "cancelled", "expired"]
          },
          "createdAt": { "type": "string", "format": "date-time" },
          "updatedAt": { "type": "string", "format": "date-time" }
        },
        "required": ["jobId", "tool", "status", "createdAt", "updatedAt"],
        "additionalProperties": false
      }
    }
  ],
  "resultType": "complete",
  "_meta": {
    "io.modelcontextprotocol/serverInfo": {
      "name": "ponte-mcp",
      "version": "0.4.0"
    }
  }
}
```

A descrição está abreviada no exemplo; a resposta real orienta o cliente a consultar `bridge_job`. `payloadSchema` descreve o objeto `data` de cada evento, e não todo o envelope de entrega.

### Criar ou renovar uma assinatura

Exemplo do corpo de `events/subscribe`. O UUID deve ser um trabalho real criado pela mesma conexão, e os campos de entrega devem ser fornecidos pelo cliente. A URL e o segredo abaixo são marcadores de exemplo, não credenciais utilizáveis.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "events/subscribe",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    },
    "name": "ponte.job.completed",
    "arguments": {
      "jobId": "f94d3b6b-73b6-4af1-a1f7-bf20b31822c1"
    },
    "delivery": {
      "mode": "webhook",
      "url": "https://cliente.exemplo.com/callback-fornecido-pelo-cliente",
      "secret": "whsec_SEGREDO_BASE64_FORNECIDO_PELO_CLIENTE"
    },
    "cursor": null,
    "ttlMs": 3600000
  }
}
```

O resultado, além de `resultType` e metadados do servidor, traz:

```json
{
  "id": "sub_ID_OPACO_DERIVADO_DA_ASSINATURA",
  "refreshBefore": "2026-10-22T13:00:00.000Z",
  "cursor": null,
  "truncated": false
}
```

O ID é determinístico para a identidade autenticada, a URL exata de callback, o nome do evento e os argumentos canônicos. O cliente deve tratá-lo como opaco. Repetir a inscrição com os mesmos valores renova a validade e pode rotacionar o segredo; não cria outra inscrição ativa para essa combinação. A identidade OAuth é a autorização específica; um novo consentimento gera um vínculo separado. Quem usa o mesmo token API compartilha a identidade desse token.

A Ponte prepara uma inscrição ou renovação por vez. Solicitações concorrentes excedentes recebem HTTP **429**, código **`-32025`** e `data.reason: "subscription_busy"`, sem formar uma fila de verificações. O cliente pode repetir a inscrição depois que a chamada em andamento terminar; não deve reenviar a operação original da ferramenta. Uma verificação lenta ainda pode atrasar o registro e o cancelamento de avisos pelo prazo de rede de uma chamada, de até dez segundos.

Esse vínculo também protege a consulta e o cancelamento do trabalho enquanto ele está em memória, além da recuperação de resultados arquivados. Saber o `jobId` de outra conexão não concede acesso ao trabalho. A administração local mantém acesso a todas as execuções. Catálogo, projetos e política de aprovação continuam compartilhados pelo único proprietário da Ponte.

`ttlMs` aceita inteiro não negativo, `null` ou omissão. O padrão e o máximo são 24 horas; valores maiores são limitados, e zero recebe validade mínima de 1 ms, portanto não é útil para acompanhamento. O valor efetivo é informado em `refreshBefore`. O cliente deve renovar antes desse horário se ainda precisar acompanhar o trabalho.

Esta implementação não oferece reprodução histórica. `cursor` deve ser omitido ou `null`; outro valor é rejeitado com `-32026` e `data.feature: "replay"`. `maxAgeMs` pode ser enviado como inteiro não negativo, mas não ativa replay nem filtra o estado final atual do trabalho. Assinar um trabalho já concluído enfileira uma fotografia de seu estado atual, enquanto ele estiver disponível para a mesma identidade.

### Encerrar uma assinatura

`events/unsubscribe` identifica a inscrição pelos mesmos nome, argumentos e URL. O segredo não é enviado:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "events/unsubscribe",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    },
    "name": "ponte.job.completed",
    "arguments": {
      "jobId": "f94d3b6b-73b6-4af1-a1f7-bf20b31822c1"
    },
    "delivery": {
      "mode": "webhook",
      "url": "https://cliente.exemplo.com/callback-fornecido-pelo-cliente"
    }
  }
}
```

Encerrar uma inscrição ausente também tem sucesso. O resultado contém somente o marcador de conclusão e os metadados do servidor. O cancelamento pelo painel produz o mesmo efeito sobre novas entregas.

## Verificação e entrega do webhook

Antes de ativar uma inscrição, a Ponte envia ao callback um POST assinado com um desafio novo:

```json
{
  "type": "verification",
  "challenge": "VALOR_ALEATORIO_GERADO_PELA_PONTE"
}
```

O destino deve responder HTTP 2xx e um objeto JSON cujo campo `challenge` seja exatamente o valor recebido. A comparação é feita em tempo constante. Uma verificação bem-sucedida pode ser reaproveitada por até dez minutos para a mesma identidade, URL e segredo; a cache é limitada. Trocar o segredo exige verificação correspondente. Redirecionamentos não são seguidos.

O corpo de um evento normal usa este envelope; ele não tem o campo `type` da verificação:

```json
{
  "eventId": "67cc9e88-8a03-4915-9410-2ec7c595adce",
  "name": "ponte.job.completed",
  "timestamp": "2026-10-22T12:00:01.000Z",
  "data": {
    "jobId": "f94d3b6b-73b6-4af1-a1f7-bf20b31822c1",
    "tool": "local_write_file",
    "status": "succeeded",
    "createdAt": "2026-10-22T12:00:00.000Z",
    "updatedAt": "2026-10-22T12:00:01.000Z"
  },
  "cursor": null
}
```

O cliente recebe somente metadados de conclusão. Para obter o resultado da ferramenta e a mensagem de erro do trabalho, use a consulta autenticada a `bridge_job` dentro do prazo de retenção. O aviso não inclui argumentos, código ou conteúdo de arquivos, e a cópia arquivada remove os argumentos de entrada.

Os cabeçalhos de entrega são:

```http
Content-Type: application/json
webhook-id: ID_DO_EVENTO
webhook-timestamp: SEGUNDOS_UNIX
webhook-signature: v1,ASSINATURA_BASE64
X-MCP-Subscription-Id: ID_DA_ASSINATURA
```

A chave de assinatura tem formato `whsec_` seguido de Base64 de 24 a 64 bytes. O HMAC-SHA256 usa a chave decodificada e a mensagem UTF-8 formada por `webhook-id`, ponto, `webhook-timestamp`, ponto e o **corpo JSON exato**. Resserializar o corpo antes de verificar pode alterar a assinatura. Na rotação há sobreposição de cinco minutos; o cabeçalho pode conter duas assinaturas `v1,...` separadas por espaço. A verificação usa um ID de mensagem próprio, começando por `msg_verification_`.

O `eventId` e o corpo de um evento permanecem estáveis nas novas tentativas. O horário do cabeçalho e a assinatura são calculados para cada envio. Um destinatário deve conferir a assinatura e a atualidade do cabeçalho, deduplicar pelo ID e só então tratar o conteúdo. Reinícios ou uma confirmação perdida podem produzir uma entrega duplicada; o recurso não promete entrega exatamente uma vez.

### Prazos e respostas

- Um 2xx registra a entrega como recebida.
- Falha de rede ou resposta sem sucesso permite novas tentativas com atraso exponencial, até **seis tentativas no total**, enquanto a assinatura e a autorização permanecerem válidas.
- HTTP **410** e **413** encerram a entrega daquele evento sem nova tentativa; isso não equivale a cancelar toda a assinatura.
- Redirecionamentos são recusados. Cada envio tem prazo total de até **dez segundos**, corpo de até **256 KiB** e resposta de até **64 KiB**.
- Expiração, cancelamento ou autorização invalidada impede novas entregas. Uma mensagem já aceita pelo destinatário não pode ser retirada pela Ponte.

O destino deve usar HTTPS público. A cada conexão, a Ponte valida os endereços DNS e conecta o socket a um endereço permitido, preservando o domínio para Host e TLS/SNI. Endereços locais, privados e reservados, credenciais na URL e fragmentos são recusados. Não há opção de callback de loopback para testes por essa interface de produção; os testes internos injetam um transporte controlado.

O perfil da OpenAI especifica **`-32015` (`CallbackEndpointError`)** para falhas de callback. A Ponte segue esse código e retorna uma razão sanitizada em `error.data.reason`, como `invalid_url`, `blocked_address`, `invalid_secret`, `timeout` ou `challenge_failed`. O rascunho experimental de Events utiliza um código provisório diferente; para interoperabilidade com o ChatGPT, prevalece aqui o perfil publicado pela OpenAI.

## Persistência, capacidade e reinício

O arquivo privado `events.json` no diretório de estado guarda assinaturas, URLs e chaves de callback, fila de entrega e cópias dos trabalhos acompanhados. O estado é gravado antes de iniciar a entrega. Não inclua esse arquivo em um repositório público ou pacote de distribuição. Ele não é cifrado em repouso e pode conter o resultado completo de ferramentas; os argumentos de entrada são removidos da cópia arquivada.

| Limite | Política da Ponte |
|---|---|
| Assinaturas | Até 100 ativas, sujeitas também ao orçamento de armazenamento |
| Criação ou renovação simultânea | Uma em andamento; excedentes recebem 429 e podem tentar novamente |
| Validade | Padrão e máximo de 24 horas por inscrição ou renovação |
| Estado de Events | Até 64 MiB, contando estado atual e reserva para resultados pendentes |
| Resultado de um trabalho | Até 4 MiB, mais espaço reservado para metadados |
| Conteúdo enviado por evento | Somente metadados de um trabalho, dentro do limite de 256 KiB |
| Reenvios | Até seis tentativas por evento, incluindo a primeira |
| Sobreposição de chaves | Até cinco minutos após a rotação |

Cada trabalho pendente acompanhado reserva espaço para seu possível resultado antes de aceitar a assinatura. Assim, a capacidade pode se esgotar antes de chegar a 100 inscrições. O erro é devolvido ao cliente; a Ponte não aceita um aviso que já sabe não poder reter. Há também limite interno de cópias arquivadas, para que a renovação e o cancelamento de assinaturas não criem crescimento ilimitado.

A cópia de um trabalho permanece até a maior validade já concedida para aquela identidade e `jobId`, inclusive depois de `events/unsubscribe` ou **Encerrar aviso**. Renovar pode estender esse prazo. Ao expirar, a cópia é removida mesmo se não houver outras assinaturas ativas. Invalidar a autorização bloqueia o acesso e as entregas vinculadas a ela.

Depois de reiniciar, assinaturas e entregas ainda válidas voltam do disco. `bridge_job` pode recuperar o resultado retido para a mesma conexão quando o trabalho já não está na memória. Se um trabalho acompanhado estava pendente ou em execução e não existe no processo restaurado, a Ponte registra `cancelled` com uma mensagem de interrupção e de possível efeito externo. **Ela não reenvia a operação.** O cliente deve conferir o destino antes de propor uma nova execução.

Trabalhos sem assinatura mantêm a retenção em memória da Ponte. O arquivo de auditoria contém metadados e não substitui um resultado completo. A persistência de Events também não recupera a janela de idempotência de uma operação após reiniciar; use o resultado consultável, sem submeter novamente o trabalho.

## Diagnóstico

| Sintoma | Conferência útil |
|---|---|
| O plugin não lista `ponte.job.completed` | Confirme a 0.4.0, a mesma origem HTTPS e a atualização das ferramentas/eventos; o cliente precisa descobrir o protocolo `2026-07-28` |
| Ferramentas funcionam, mas Events não aparece | Confirme Work no navegador ou Work com Cloud no desktop, além das permissões da conta/workspace |
| O painel mostra zero avisos | Ainda não há assinatura ativa; aprovação automática e autorização OAuth não criam uma inscrição |
| Assinatura recusada por trabalho indisponível | Use o `jobId` retornado pela mesma autorização que está assinando; um trabalho de outra conexão ou já expurgado não pode ser acompanhado |
| Erro `-32015` | Leia `data.reason`; a Ponte exige callback HTTPS público válido, segredo válido e resposta correta ao desafio |
| Erro `-32025` com `subscription_busy` | Aguarde a inscrição ou renovação em andamento e tente inscrever novamente; não repita a ferramenta que criou o trabalho |
| Aviso permanece aguardando conclusão | Confira o trabalho em **Execuções**, a política de aprovação e a pausa da fila |
| Aviso falhou após tentativas | Confira o erro sanitizado e a conectividade de saída; consulte `bridge_job` para o resultado, sem repetir a operação |
| Aviso recebido, sem nova resposta do chat | A entrega foi aceita; confira as instruções da conversa e o suporte do cliente à retomada |
| Mudança de URL, revogação ou novo consentimento | A autorização anterior não acompanha a nova identidade; refaça a conexão e o acompanhamento necessário |
| Limite de armazenamento ou de assinaturas | Encerre avisos desnecessários e aguarde a expiração das cópias retidas; cancelar um aviso não apaga seu resultado imediatamente |
| Trabalho cancelado após reinício | Consulte a mensagem de interrupção e confira o estado externo antes de qualquer repetição |

Para um teste completo no ChatGPT, observe quatro evidências: evento descoberto no plugin, assinatura visível no painel, aviso recebido e consulta ao mesmo `jobId` pela conversa. Testes locais de protocolo e transporte não comprovam disponibilidade de Events em uma conta específica. Os resultados efetivamente executados nesta entrega ficam em [VALIDACAO.md](VALIDACAO.md).

## Referências oficiais e perfil adotado

- [OpenAI — MCP Events](https://developers.openai.com/plugins/build/mcp-events): disponibilidade no ChatGPT, descoberta, inscrição, callback e perfil de verificação.
- [OpenAI — Conectar e testar um MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt): instalação e atualização do plugin.
- [MCP — Versionamento `2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning): seleção da versão do protocolo.
- [MCP — Metadados e mensagens](https://modelcontextprotocol.io/specification/2026-07-28/basic/index): envelope e metadados de cliente/servidor.
- [MCP — Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http): cabeçalhos, mídia e espelhos de argumentos.
- [MCP — Descoberta](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) e [ferramentas](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): capacidades e chamadas modernas.
- [MCP — Schema TypeScript da versão](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts): formas normativas de requisições e resultados, incluindo `resultType`.
- [Grupo de trabalho de MCP Events — rascunho experimental](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md): identidade da assinatura e semântica geral de eventos; é um rascunho em evolução.

A Ponte implementa o perfil de webhook e verificação documentado pela OpenAI. Não implementa polling de eventos, streams de eventos, replay por cursor, eventos globais de todos os trabalhos nem mensagens de controle de lacuna/encerramento. Exemplos abreviados da documentação de Events são complementados pelos metadados e pelo `resultType` exigidos pelo protocolo `2026-07-28`.
