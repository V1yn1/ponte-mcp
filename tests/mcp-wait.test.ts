import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { JobManager } from '../src/core/jobs.js';
import { callGateway, publicTools } from '../src/mcp/server.js';
import { textResult, type AppConfig, type Job, type ToolDefinition } from '../src/types.js';

function fixture(t: TestContext, risk: ToolDefinition['risk'], execute: ToolDefinition['execute'], mode: AppConfig['approvalMode'] = 'mutations') {
  const definition: ToolDefinition = {
    tool: { name: 'test_wait', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    source: 'test', risk, execute,
  };
  const jobs = new JobManager(() => [definition], () => mode);
  t.after(() => jobs.close());
  return { jobs, getTools: () => [definition], publicStatus: () => ({ ok: true }) };
}

function state(result: CallToolResult): { jobId: string; status: Job['status']; approval?: Job['approval'] } {
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return JSON.parse(content.text);
}

test('direct calls and bridge_call return results from work lasting longer than 750 ms', async t => {
  for (const name of ['test_wait', 'bridge_call']) {
    await t.test(name, async t => {
      let executions = 0;
      const gateway = fixture(t, 'read', async () => {
        executions++;
        await delay(1_000);
        return textResult('completed after the original wait window');
      });
      const args = name === 'bridge_call' ? { tool: 'test_wait', arguments: {}, idempotencyKey: 'wait-once' } : {};
      const result = await callGateway(gateway, name, args);
      assert.equal(state(result).status, 'succeeded');
      assert.equal(result.content[1]?.type, 'text');
      assert.equal(result.content[1]?.text, 'completed after the original wait window');
      assert.equal(executions, 1);
      if (name === 'bridge_call') {
        assert.equal(state(await callGateway(gateway, name, args)).jobId, state(result).jobId);
        assert.equal(executions, 1);
      }
    });
  }
});

test('an initial call returns pending approval immediately and bridge_job can wait for approval and the result', async t => {
  let executions = 0;
  const gateway = fixture(t, 'write', async () => {
    executions++;
    await delay(20);
    return textResult('manually approved result');
  });
  const pending = state(await callGateway(gateway, 'test_wait', {}));
  assert.equal(pending.status, 'pending_approval');
  assert.equal(executions, 0);
  const approve = setTimeout(() => gateway.jobs.approve(pending.jobId), 30);
  t.after(() => clearTimeout(approve));
  const result = await callGateway(gateway, 'bridge_job', { jobId: pending.jobId, waitMs: 500 });
  assert.equal(state(result).status, 'succeeded');
  assert.equal(state(result).approval, 'manual');
  assert.equal(result.content[1]?.text, 'manually approved result');
  assert.equal(executions, 1);
});

test('bridge_job returns the same pending job at its deadline without executing or resubmitting it', async t => {
  let executions = 0;
  const gateway = fixture(t, 'write', async () => { executions++; return textResult('done once'); });
  const pending = await gateway.jobs.submit('test_wait', {});
  const started = performance.now();
  const result = await callGateway(gateway, 'bridge_job', { jobId: pending.id, waitMs: 40 });
  assert.equal(state(result).jobId, pending.id);
  assert.equal(state(result).status, 'pending_approval');
  assert.ok(performance.now() - started >= 30, 'the query must wait for its requested window');
  assert.equal(executions, 0);
  assert.equal(gateway.jobs.list().length, 1);
  gateway.jobs.approve(pending.id);
  assert.equal(state(await callGateway(gateway, 'bridge_job', { jobId: pending.id, waitMs: 500 })).status, 'succeeded');
  assert.equal(state(await callGateway(gateway, 'bridge_job', { jobId: pending.id })).status, 'succeeded');
  assert.equal(executions, 1);
});

test('bridge_job stops waiting when approval is rejected or the job is cancelled', async t => {
  for (const action of ['reject', 'cancel'] as const) {
    await t.test(action, async t => {
      let executions = 0;
      const gateway = fixture(t, 'write', async () => { executions++; return textResult('unexpected'); });
      const pending = await gateway.jobs.submit('test_wait', {});
      const finish = setTimeout(() => gateway.jobs[action](pending.id), 30);
      t.after(() => clearTimeout(finish));
      const result = await callGateway(gateway, 'bridge_job', { jobId: pending.id, waitMs: 500 });
      assert.equal(state(result).status, action === 'reject' ? 'rejected' : 'cancelled');
      assert.equal(result.isError, true);
      assert.equal(executions, 0);
    });
  }
});

test('bridge_job validates waitMs and leaves cancellation arguments unchanged', async t => {
  const gateway = fixture(t, 'write', async () => textResult('unexpected'));
  const pending = await gateway.jobs.submit('test_wait', {});
  for (const waitMs of [-1, 25_001, 0.5, '10', null, NaN, Infinity]) {
    const result = await callGateway(gateway, 'bridge_job', { jobId: pending.id, waitMs });
    assert.equal(result.isError, true, `waitMs=${String(waitMs)} must be rejected`);
    assert.equal(gateway.jobs.get(pending.id).status, 'pending_approval');
  }
  for (const args of [{ jobId: pending.id }, { jobId: pending.id, waitMs: 0 }]) {
    const result = await callGateway(gateway, 'bridge_job', args);
    assert.equal(result.isError, false);
    assert.equal(state(result).status, 'pending_approval');
  }
  assert.equal((await callGateway(gateway, 'bridge_cancel', { jobId: pending.id, waitMs: 0 })).isError, true);
  assert.equal(gateway.jobs.get(pending.id).status, 'pending_approval');
  assert.equal(state(await callGateway(gateway, 'bridge_cancel', { jobId: pending.id })).status, 'cancelled');
  assert.equal(state(await callGateway(gateway, 'bridge_job', { jobId: pending.id, waitMs: 25_000 })).status, 'cancelled');
  const tools = publicTools(gateway);
  assert.ok(tools.find(tool => tool.name === 'bridge_job')?.inputSchema.properties?.waitMs);
  assert.equal(tools.find(tool => tool.name === 'bridge_cancel')?.inputSchema.properties?.waitMs, undefined);
});

test('instant reads return their result without an artificial timer delay', async t => {
  const gateway = fixture(t, 'read', async () => textResult('instant'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let result: CallToolResult | undefined;
  void callGateway(gateway, 'test_wait', {}).then(value => { result = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(result, 'an already completed read must not wait for a timer');
  assert.equal(state(result).status, 'succeeded');
  assert.equal(result.content[1]?.text, 'instant');
});

test('the initial execution wait has a 25 second deadline and leaves the running job available', async t => {
  let executions = 0;
  const gateway = fixture(t, 'read', async (_args, { signal }) => {
    executions++;
    return new Promise<CallToolResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  let result: CallToolResult | undefined;
  void callGateway(gateway, 'test_wait', {}).then(value => { result = value; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(24_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result, undefined, 'the execution wait should still be active before its deadline');
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(result, 'the execution wait must return at its deadline');
  assert.equal(state(result).status, 'running');
  assert.equal(gateway.jobs.get(state(result).jobId).status, 'running');
  assert.equal(executions, 1);
});

test('MCP results identify automatic approval when that policy executed the job', async t => {
  const gateway = fixture(t, 'write', async () => textResult('automatic result'), 'automatic');
  const result = await callGateway(gateway, 'test_wait', {});
  assert.equal(state(result).status, 'succeeded');
  assert.equal(state(result).approval, 'automatic');
});
