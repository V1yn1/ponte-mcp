import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApplication, type Application } from '../src/app.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-automatic-http-'));
  const options = { stateDir: path.join(root, 'state'), workspace: path.join(root, 'project'), adminPort: 0, apiPort: 0 };
  const runtime = await startApplication(options);
  const runtimes = [runtime];
  t.after(async () => {
    await Promise.all(runtimes.map(app => app.close()));
    await rm(root, { recursive: true, force: true });
  });
  const adminHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.adminToken, 'Content-Type': 'application/json' };
  const apiHeaders = { Authorization: 'Bearer ' + runtime.store.secrets.apiToken, 'Content-Type': 'application/json' };
  const setting = (approvalMode: unknown, headers = adminHeaders) => fetch(runtime.adminUrl + '/admin/settings', {
    method: 'PATCH', headers, body: JSON.stringify({ approvalMode }),
  });
  return { root, options, runtime, runtimes, adminHeaders, apiHeaders, setting };
}

async function settled(runtime: Application, id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const job = runtime.jobs.get(id);
    if (['succeeded', 'failed', 'rejected', 'cancelled', 'expired'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('O trabalho não terminou dentro do prazo de teste.');
}

test('admin automatic mode releases pending writes and applies to subsequent API calls', async t => {
  const f = await fixture(t);
  const args = { projectId: 'principal', path: 'pending.txt', content: 'aprovado automaticamente', expectedHash: null };
  const pending = await f.runtime.jobs.submit('local_write_file', args);
  assert.equal(pending.status, 'pending_approval');
  await assert.rejects(readFile(path.join(f.root, 'project', 'pending.txt')));

  const response = await f.setting('automatic');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, approvalMode: 'automatic', approvals: { approved: 1, rejected: 0, returnedToPending: 0 },
  });
  assert.equal((await settled(f.runtime, pending.id)).approval, 'automatic');
  assert.equal(await readFile(path.join(f.root, 'project', 'pending.txt'), 'utf8'), args.content);
  const status = await fetch(f.runtime.apiUrl + '/v1/status', { headers: f.apiHeaders }).then(r => r.json());
  assert.equal(status.approvalMode, 'automatic');

  const next = await fetch(f.runtime.apiUrl + '/v1/jobs', {
    method: 'POST', headers: f.apiHeaders,
    body: JSON.stringify({ tool: 'local_write_file', arguments: { ...args, path: 'next.txt' } }),
  });
  assert.equal(next.status, 202);
  const nextJob = await next.json();
  assert.notEqual(nextJob.status, 'pending_approval');
  assert.equal((await settled(f.runtime, nextJob.id)).status, 'succeeded');
  assert.equal(await readFile(path.join(f.root, 'project', 'next.txt'), 'utf8'), args.content);

  assert.equal((await f.setting('mutations')).status, 200);
  const reviewed = await f.runtime.jobs.submit('local_write_file', { ...args, path: 'reviewed.txt' });
  assert.equal(reviewed.status, 'pending_approval');
  await assert.rejects(readFile(path.join(f.root, 'project', 'reviewed.txt')));
});

test('automatic mode remains admin-only and enforces pause and project permissions', async t => {
  const f = await fixture(t);
  assert.equal((await f.setting('automatic', f.apiHeaders)).status, 401);
  assert.equal((await f.setting('automatic', { Authorization: '', 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await fetch(f.runtime.apiUrl + '/admin/settings', {
    method: 'PATCH', headers: f.apiHeaders, body: JSON.stringify({ approvalMode: 'automatic' }),
  })).status, 404);
  assert.equal((await f.setting('invalid')).status, 400);
  assert.equal(f.runtime.store.config.approvalMode, 'mutations');
  assert.equal((await f.setting('automatic')).status, 200);

  await assert.rejects(f.runtime.jobs.submit('local_exec', {
    projectId: 'principal', executable: process.execPath, args: ['-e', 'process.exit(0)'],
  }), /exec|habilit|allowExec/i);
  await f.runtime.store.update(config => ({ ...config, projects: config.projects.map(p => ({ ...p, allowWrite: false })) }));
  await assert.rejects(f.runtime.jobs.submit('local_write_file', {
    projectId: 'principal', path: 'forbidden.txt', content: 'no', expectedHash: null,
  }), /escrit|writ|allowWrite|read.only/i);
  f.runtime.jobs.setPaused(true);
  await assert.rejects(f.runtime.jobs.submit('local_projects', {}), /paus/i);
});

test('automatic policy persists across a server restart while manual all still reviews reads', async t => {
  const f = await fixture(t);
  assert.equal((await f.setting('all')).status, 200);
  assert.equal((await f.runtime.jobs.submit('local_projects', {})).status, 'pending_approval');
  assert.equal((await f.setting('automatic')).status, 200);
  await f.runtime.close();
  const reopened = await startApplication(f.options);
  f.runtimes.push(reopened);
  assert.equal(reopened.store.config.approvalMode, 'automatic');
  assert.equal(reopened.publicStatus().approvalMode, 'automatic');
  const read = await reopened.jobs.submit('local_projects', {});
  assert.equal((await settled(reopened, read.id)).status, 'succeeded');
});
