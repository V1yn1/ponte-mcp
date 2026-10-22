export function makeOpenApi(baseUrl: string) {
  const jsonResponse = (description: string, schema: unknown = { type: 'object', additionalProperties: true }) => ({ description, content: { 'application/json': { schema } } });
  const jobParameter = { name: 'jobId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'ID do trabalho devolvido por createJob.' };
  const jobSchema = { type: 'object', properties: { id: { type: 'string' }, tool: { type: 'string' }, status: { type: 'string', enum: ['pending_approval', 'queued', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired'] }, result: { type: 'object', additionalProperties: true }, error: { type: 'string' } }, additionalProperties: true };
  return {
    openapi: '3.1.0',
    info: { title: 'Ponte MCP', version: '0.5.0', description: 'Ferramentas locais e MCPs conectados. A aprovação segue a política selecionada no painel do computador. Não altera cotas de IA. Descubra o schema usando listTools; envie argumentsJson com JSON válido. Consulte getJob até estado final; não confunda pending_approval com sucesso.' },
    servers: [{ url: baseUrl.replace(/\/$/, '') }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/v1/status': { get: { operationId: 'getBridgeStatus', summary: 'Ver projetos e conexões', responses: { '200': jsonResponse('Estado do serviço e projetos autorizados.') } } },
      '/v1/tools': { get: { operationId: 'listTools', summary: 'Descobrir ferramentas e seus schemas', parameters: [
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Filtro por nome ou descrição.' },
        { name: 'source', in: 'query', schema: { type: 'string' }, description: 'Origem, por exemplo local ou mcp:roblox.' },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
      ], responses: { '200': jsonResponse('Catálogo paginado. Cada ferramenta inclui inputSchema, risco e origem.') } } },
      '/v1/jobs': { post: { operationId: 'createJob', summary: 'Solicitar uma ferramenta', 'x-openai-isConsequential': true,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          tool: { type: 'string', description: 'Nome exato retornado por listTools.' },
          argumentsJson: { type: 'string', description: 'Objeto de argumentos serializado como JSON conforme inputSchema. Exemplo: {"projectId":"principal","path":"README.md"}' },
          idempotencyKey: { type: 'string', maxLength: 128, description: 'Chave única desta operação. Reutilize apenas ao repetir exatamente a mesma solicitação.' },
        }, required: ['tool', 'argumentsJson', 'idempotencyKey'], additionalProperties: false } } } },
        responses: { '202': jsonResponse('Solicitação registrada. Se pending_approval, peça revisão no painel local. Consulte getJob pelo id.', jobSchema), '400': jsonResponse('Solicitação inválida.'), '401': jsonResponse('Token inválido.') },
      } },
      '/v1/jobs/{jobId}': { get: { operationId: 'getJob', summary: 'Obter estado e resultado de uma execução', parameters: [jobParameter], responses: { '200': jsonResponse('Estado atual, resultado e erro quando houver.', jobSchema) } } },
      '/v1/jobs/{jobId}/cancel': { post: { operationId: 'cancelJob', summary: 'Solicitar cancelamento', description: 'Não desfaz alterações já realizadas. Servidores externos podem concluir operações mesmo após cancelamento.', 'x-openai-isConsequential': true, parameters: [jobParameter], responses: { '200': jsonResponse('Estado do trabalho.', jobSchema) } } },
    },
  };
}
