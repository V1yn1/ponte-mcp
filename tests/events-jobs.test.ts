import test from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from '../src/core/jobs.js';
import { textResult, type Job, type ToolDefinition } from '../src/types.js';

const definition: ToolDefinition = {
  tool: { name: 'write_fixture', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
  source: 'test', risk: 'write', execute: async args => textResult(args.value),
};

test('job origin is private and idempotency keys are scoped to the authenticated principal', async t => {
  const jobs = new JobManager(() => [definition], () => 'all');
  t.after(() => jobs.close());
  const first = await jobs.submit('write_fixture', { value: 'one' }, 'same-key', 'oauth:first');
  const second = await jobs.submit('write_fixture', { value: 'two' }, 'same-key', 'oauth:second');
  assert.notEqual(first.id, second.id);
  assert.equal(jobs.ownerOf(first.id), 'oauth:first');
  assert.equal(jobs.ownerOf(second.id), 'oauth:second');
  assert.equal((await jobs.submit('write_fixture', { value: 'one' }, 'same-key', 'oauth:first')).id, first.id);
  await assert.rejects(jobs.submit('write_fixture', { value: 'changed' }, 'same-key', 'oauth:first'), /idempotência/);
  assert.equal(JSON.stringify(jobs.list()).includes('oauth:'), false);
});

test('terminal observers see complete results once and cannot alter a job or other observers', async t => {
  const jobs = new JobManager(() => [definition], () => 'all');
  t.after(() => jobs.close());
  const observed: Job[] = [];
  jobs.onTerminal(job => { job.status = 'failed'; throw new Error('observer failed'); });
  const detach = jobs.onTerminal(job => { observed.push(job); });
  const first = await jobs.submit('write_fixture', { value: 'done' });
  assert.equal(observed.length, 0);
  jobs.approve(first.id);
  for (let i = 0; i < 50 && !observed.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.status, 'succeeded');
  assert.deepEqual(observed[0]?.result, textResult('done'));
  assert.equal(jobs.get(first.id).status, 'succeeded');
  jobs.cancel(first.id);
  assert.equal(observed.length, 1);
  detach();
  const second = await jobs.submit('write_fixture', { value: 'cancelled' });
  jobs.cancel(second.id);
  assert.equal(observed.length, 1);
});

test('terminal observers receive rejection, expiry and shutdown cancellation without executing tools', async t => {
  let executions = 0;
  const jobs = new JobManager(() => [{ ...definition, execute: async () => { executions++; return textResult('unexpected'); } }], () => 'all');
  t.after(() => jobs.close());
  const observed: Job[] = [];
  jobs.onTerminal(job => { observed.push(job); });
  const rejected = await jobs.submit('write_fixture', { value: 'reject' });
  jobs.reject(rejected.id);
  const expired = await jobs.submit('write_fixture', { value: 'expire' });
  const future = Date.now() + 16 * 60 * 1000;
  const clock = t.mock.method(Date, 'now', () => future);
  assert.equal(jobs.get(expired.id).status, 'expired');
  clock.mock.restore();
  await jobs.submit('write_fixture', { value: 'close' });
  jobs.close();
  assert.deepEqual(observed.map(job => job.status), ['rejected', 'expired', 'cancelled']);
  assert.equal(executions, 0);
});
