import assert from 'node:assert/strict';
import test from 'node:test';
import { callGateway, SERVER_INSTRUCTIONS } from '../src/mcp/server.js';
import { WatchError, type WatchService } from '../src/watchers/service.js';
import { watcherControlTools, watcherResult, WATCH_DEFAULT_WAIT_MS, WATCH_MAX_WAIT_MS } from '../src/watchers/tools.js';
import type { Watcher } from '../src/watchers/types.js';

const watcherId = '66267440-c208-4214-99cb-72ae188b7c5c';
const waiting: Watcher = { watcherId, name: 'Contrato de espera', trigger: { type: 'signal', source: 'test', runId: 'one-task' }, status: 'waiting', createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', expiresAt: '2026-10-22T01:00:00.000Z' };
const payload = (result: Awaited<ReturnType<typeof callGateway>>) => {
  const first = result.content[0]; assert.equal(first?.type, 'text');
  return JSON.parse(first!.type === 'text' ? first!.text : '{}');
};

function gateway(wait: WatchService['wait']) {
  return { watchers: { wait } as WatchService, jobs: { submit() { assert.fail('Watcher controls must not submit a task.'); } }, getTools: () => [], publicStatus: () => ({}) } as unknown as Parameters<typeof callGateway>[0];
}

test('watcher catalog bounds each call to 45 seconds with a 25-second default', () => {
  const tool = watcherControlTools.find(item => item.name === 'bridge_watch_wait')!;
  assert.equal(WATCH_DEFAULT_WAIT_MS, 25000); assert.equal(WATCH_MAX_WAIT_MS, 45000);
  assert.deepEqual(tool.inputSchema.properties?.waitMs, { type: 'integer', minimum: 0, maximum: 45000, default: 25000, description: 'Prazo desta chamada; não altera timeoutMs nem expiresAt do acompanhamento. O cliente pode interromper antes.' });
});

test('oversized direct and wrapped waits return the same ID without registering a wait or submitting work', async () => {
  let calls = 0;
  const bridge = gateway(async () => { calls++; return waiting; });
  for (const waitMs of [45001, 300000]) for (const wrapped of [false, true]) {
    const args = { watcherId, waitMs };
    const result = await callGateway(bridge, wrapped ? 'bridge_call' : 'bridge_watch_wait', wrapped ? { tool: 'bridge_watch_wait', arguments: args } : args, 'owner');
    assert.equal(result.isError, true);
    const error = payload(result);
    assert.equal(error.watcherId, watcherId); assert.equal(error.status, undefined);
    assert.equal(error.recovery.reason, 'wait_limit_exceeded'); assert.equal(error.recovery.maxWaitMs, 45000);
    assert.deepEqual(error.nextCall, { tool: 'bridge_watch_get', arguments: { watcherId } });
    assert.equal(error.canWakeClosedConversation, false); assert.match(error.nextStep, /não (?:reenvie|crie)/i);
  }
  assert.equal(calls, 0);
});

test('a cancelled wait returns recovery metadata without calling the task failed', async () => {
  const bridge = gateway(async () => { throw new WatchError('Espera interrompida.', -32000, { reason: 'aborted' }); });
  const result = await callGateway(bridge, 'bridge_watch_wait', { watcherId }, 'owner');
  assert.equal(result.isError, true);
  const error = payload(result);
  assert.equal(error.status, undefined); assert.equal(error.watcherId, watcherId);
  assert.equal(error.recovery.reason, 'wait_interrupted');
  assert.deepEqual(error.nextCall, { tool: 'bridge_watch_get', arguments: { watcherId } });
});

test('authorization and missing watchers do not request blind recovery retries', async () => {
  for (const reason of ['authorization_required', 'not_found']) {
    const result = await callGateway(gateway(async () => { throw new WatchError('Indisponível.', -32000, { reason }); }), 'bridge_watch_wait', { watcherId }, 'owner');
    assert.equal(result.isError, true); assert.equal(payload(result).nextCall, undefined); assert.equal(payload(result).recovery, undefined);
  }
});

test('waiting keeps the active turn on the same watcher and treats Events as optional unproven continuation', () => {
  const result = watcherResult(waiting);
  assert.deepEqual(result.nextCall, { tool: 'bridge_watch_wait', arguments: { watcherId, waitMs: 25000 } });
  assert.match(result.nextStep, /não encerre o turno/i); assert.match(result.nextStep, /limite concreto/i);
  assert.deepEqual(result.continuation, { event: 'ponte.watcher.completed', arguments: { watcherId }, requiresClientSubscription: true, deliveryDoesNotProveContinuation: true });
  assert.equal(result.canWakeClosedConversation, false); assert.equal(result.expiresAt, waiting.expiresAt);
  assert.match(SERVER_INSTRUCTIONS, /waitMs.*(?:timeoutMs|expiresAt)/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /até 300000|até 300 s/);
});

test('terminal guidance presents success, failure and input separately without another wait', () => {
  const guidance: Record<string, RegExp> = { succeeded: /apresente.*usuário/i, failed: /(?:executor|tarefa).*falha|falha.*(?:executor|tarefa)/i, needs_input: /terminal.*(?:informação|decisão)|(?:informação|decisão).*terminal/i, expired: /não (?:prova|comprova).*falh/i };
  for (const status of ['succeeded', 'failed', 'needs_input', 'expired'] as const) {
    const result = watcherResult({ ...waiting, status, ...(status === 'expired' ? { error: 'Prazo encerrado.' } : { result: { summary: 'Resultado real.', exitCode: status === 'failed' ? 1 : 0 } }) });
    assert.match(result.nextStep, guidance[status]!); assert.equal(result.nextCall, undefined); assert.equal(result.continuation, undefined);
    assert.equal(result.canWakeClosedConversation, false);
  }
});
