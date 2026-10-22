import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ConfigStore } from '../src/core/config.js';
import { JobManager } from '../src/core/jobs.js';
import { McpHub } from '../src/mcp/hub.js';
import { McpManagement } from '../src/mcp/management.js';
import type { AppConfig, Job, UpstreamConfig } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/upstream.mjs', import.meta.url));
const streams = fileURLToPath(new URL('./fixtures/stdio-streams.mjs', import.meta.url));
const owner = 'api:mcp-management-test';
const serverInput = (id = 'fixture', options: Record<string, unknown> = {}) => ({
  id, name: id, transport: 'stdio', command: process.execPath,
  args: ['--import', streams, fixture, JSON.stringify(options)], timeoutMs: 5_000,
});
const addInput = (id = 'fixture', options: Record<string, unknown> = {}) => ({
  server: serverInput(id, options), reason: 'Conectar o servidor solicitado pelo usuário.',
});
const payload = (job: Job): any => {
  const first = job.result?.content[0];
  assert.equal(first?.type, 'text', JSON.stringify(job));
  return JSON.parse(first!.type === 'text' ? first!.text : 'null');
};
async function until(condition: () => boolean, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail('Expected MCP management state before deadline');
    await delay(10);
  }
}
async function settled(jobs: JobManager, id: string): Promise<Job> {
  await until(() => !['queued', 'running'].includes(jobs.get(id).status));
  return jobs.get(id);
}
async function harness(t: TestContext, mode: AppConfig['approvalMode'] = 'mutations', upstreams: UpstreamConfig[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ponte-mcp-management-'));
  const store = await ConfigStore.open(join(dir, 'state'), { workspace: join(dir, 'project') });
  await store.update(config => ({ ...config, approvalMode: mode, upstreams }));
  const hub = new McpHub(store.config.upstreams);
  const live = new Set([owner]);
  const management = new McpManagement(store, hub, principal => live.has(principal));
  const jobs = new JobManager(() => [...management.definitions(), ...hub.tools()], () => store.config.approvalMode);
  t.after(async () => {
    jobs.close();
    await management.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const submit = (name: string, args: Record<string, unknown>) => jobs.submit(name, args, undefined, owner);
  const list = async () => payload(await settled(jobs, (await submit('bridge_mcp_list', {})).id));
  return { dir, store, hub, live, management, jobs, submit, list };
}

test('MCP registration has an immutable preview and no effects before manual approval', async t => {
  const { store, hub, jobs, submit } = await harness(t);
  const input = { ...addInput(), sourceUrl: 'https://example.com/docs/mcp' };
  const requested = await submit('bridge_mcp_add', input);
  assert.equal(requested.status, 'pending_approval');
  assert.equal(requested.risk, 'execute');
  assert.equal(requested.source, 'bridge:mcps');
  assert.equal((requested.preview as any).kind, 'mcp_add');
  assert.equal((requested.preview as any).reason, input.reason);
  assert.equal((requested.preview as any).sourceUrl, input.sourceUrl);
  assert.equal((requested.preview as any).server.enabled, true);
  assert.deepEqual((requested.preview as any).server.readOnlyTools, []);
  assert.match((requested.preview as any).note, /sandbox/i);
  assert.deepEqual(store.config.upstreams, []);
  assert.deepEqual(hub.statuses(), []);
  (requested.preview as any).server.command = '/tampered';
  input.server.command = '/tampered';
  jobs.approve(requested.id);
  const completed = await settled(jobs, requested.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(completed.approval, 'manual');
  const result = payload(completed);
  assert.equal(result.registered, true);
  assert.equal(result.server.status, 'connected');
  assert.equal(result.server.toolCount, 9);
  assert.equal(result.discoveredTools.length, 9);
  assert.ok(result.discoveredTools.every((tool: any) => tool.risk === 'execute' && tool.source === 'mcp:fixture'));
  assert.deepEqual(result.nextCall, { tool: 'bridge_list_tools', arguments: { source: 'mcp:fixture', limit: 20 } });
  assert.equal(store.config.upstreams[0]?.command, process.execPath);
  assert.deepEqual(store.config.upstreams[0]?.readOnlyTools, []);
});

test('MCP management respects rejection, pause and all-mode approval for its read tool', async t => {
  const { store, hub, jobs, submit } = await harness(t);
  const rejected = await submit('bridge_mcp_add', addInput('rejected'));
  jobs.reject(rejected.id);
  jobs.setPaused(true);
  await assert.rejects(submit('bridge_mcp_add', addInput('paused')), /pausad/i);
  await assert.rejects(submit('bridge_mcp_list', {}), /pausad/i);
  assert.deepEqual(store.config.upstreams, []);
  assert.deepEqual(hub.statuses(), []);
  jobs.setPaused(false);
  await store.update(config => ({ ...config, approvalMode: 'all' }));
  const listJob = await submit('bridge_mcp_list', {});
  assert.equal(listJob.status, 'pending_approval');
  assert.equal(listJob.risk, 'read');
  jobs.approve(listJob.id);
  assert.equal((await settled(jobs, listJob.id)).status, 'succeeded');
});

test('MCP automatic policy registers once and bounds discovered tool examples', async t => {
  const { store, jobs, submit } = await harness(t, 'automatic');
  const job = await submit('bridge_mcp_add', addInput('many', { count: 24, pageSize: 12 }));
  const completed = await settled(jobs, job.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(completed.approval, 'automatic');
  assert.equal(payload(completed).discoveredTools.length, 20);
  assert.equal(payload(completed).hasMore, true);
  assert.equal(payload(completed).server.toolCount, 24);
  assert.equal(store.config.approvalMode, 'automatic');
  assert.deepEqual(store.config.upstreams[0]?.readOnlyTools, []);
});

test('MCP concurrent identical additions are idempotent and conflicting IDs never overwrite', async t => {
  const { store, hub, jobs, submit } = await harness(t, 'automatic');
  const input = addInput('same', { startupDelay: 150 });
  const duplicate = { server: { ...input.server, name: ' same ', env: {}, headers: {} }, reason: 'Repetição segura.' };
  const conflict = { server: { ...input.server, name: 'Replacement' }, reason: 'Tentativa conflitante.' };
  const submitted = await Promise.all([submit('bridge_mcp_add', input), submit('bridge_mcp_add', duplicate), submit('bridge_mcp_add', conflict)]);
  const results = await Promise.all(submitted.map(job => settled(jobs, job.id)));
  assert.equal(results[0]?.status, 'succeeded', JSON.stringify(results));
  assert.equal(results[1]?.status, 'succeeded', JSON.stringify(results));
  assert.equal(payload(results[1]!).alreadyPresent, true);
  assert.equal(results[2]?.status, 'failed');
  assert.match(results[2]?.error ?? '', /existe|conflit|substitu/i);
  assert.equal(store.config.upstreams.length, 1);
  assert.equal(store.config.upstreams[0]?.name, 'same');
  assert.equal(hub.statuses()[0]?.status, 'connected');
  const refresh = hub.tools().find(tool => tool.tool.title === 'refresh')!;
  await refresh.execute({}, { signal: new AbortController().signal });
  await until(() => hub.tools().some(tool => tool.tool.description?.includes('revision 1')));
  const repeated = await settled(jobs, (await submit('bridge_mcp_add', input)).id);
  assert.equal(payload(repeated).alreadyPresent, true);
  assert.ok(hub.tools().every(tool => tool.tool.description?.includes('revision 1')), 'An identical registration must not reconnect the server');
});

test('MCP panel edits and chat additions share one queue without losing distinct servers', async t => {
  const { store, hub, jobs, submit, management } = await harness(t, 'automatic');
  const panel = management.adminUpsert({ ...serverInput('panel', { startupDelay: 180 }), enabled: true });
  await until(() => store.config.upstreams.some(server => server.id === 'panel'));
  const submitted = await Promise.all([submit('bridge_mcp_add', addInput('first')), submit('bridge_mcp_add', addInput('second'))]);
  await panel;
  const results = await Promise.all(submitted.map(job => settled(jobs, job.id)));
  assert.ok(results.every(job => job.status === 'succeeded'), JSON.stringify(results));
  assert.deepEqual(store.config.upstreams.map(server => server.id).sort(), ['first', 'panel', 'second']);
  assert.deepEqual(hub.statuses().map(server => [server.id, server.status]).sort(), [['first', 'connected'], ['panel', 'connected'], ['second', 'connected']]);
});

test('MCP listing only exposes safe fields and keyed opaque configuration revisions', async t => {
  const secret = 'never-expose-this-literal-credential';
  const privateServer: UpstreamConfig = {
    id: 'private', name: 'Private server', transport: 'http', enabled: false,
    url: `https://example.com/mcp?token=${secret}`, headers: { Authorization: `Bearer ${secret}` },
    command: secret, args: [secret], cwd: '/private/' + secret, env: { SECRET: secret },
    allowedTools: [secret], readOnlyTools: [secret],
  };
  const { management, store, jobs, submit, list } = await harness(t, 'mutations', [privateServer]);
  const first = await list();
  assert.equal(first.platform, process.platform);
  assert.equal(first.nodeVersion, process.version);
  assert.equal(first.total, 1);
  assert.equal(first.nextOffset, null);
  assert.equal(JSON.stringify(first).includes(secret), false);
  const entry = first.servers[0];
  assert.deepEqual(Object.keys(entry).sort(), ['enabled', 'id', 'name', 'revision', 'status', 'toolCount', 'transport']);
  assert.match(entry.revision, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(entry.revision, createHash('sha256').update(JSON.stringify(privateServer)).digest('base64url'));
  assert.equal((await list()).servers[0].revision, entry.revision);
  await management.adminUpsert({ id: 'private', headers: { Authorization: 'Bearer changed-secret' } });
  assert.notEqual((await list()).servers[0].revision, entry.revision);
  const paged = await settled(jobs, (await submit('bridge_mcp_list', { offset: 1, limit: 1 })).id);
  assert.deepEqual(payload(paged).servers, []);
  assert.equal(store.config.upstreams[0]?.headers?.Authorization, 'Bearer changed-secret');
});

test('MCP chat rejects inline secrets, unsafe URLs, control characters and policy overrides before a job exists', async t => {
  const { store, hub, jobs, submit } = await harness(t);
  const base = serverInput();
  const invalid = [
    { server: { ...base, env: { TOKEN: 'literal-secret' } }, reason: 'test' },
    { server: { ...base, headers: { Authorization: 'Bearer literal-secret' } }, reason: 'test' },
    { server: { ...base, readOnlyTools: ['echo'] }, reason: 'test' },
    { server: { ...base, enabled: false }, reason: 'test' },
    { server: { ...base, id: 'bridge' }, reason: 'test' },
    { server: { ...base, id: 'local' }, reason: 'test' },
    { server: { ...base, args: ['embedded\0nul'] }, reason: 'test' },
    { server: { ...base, name: 'Fake\npreview' }, reason: 'test' },
    { server: { id: 'http', name: 'HTTP', transport: 'http', url: 'https://user:password@example.com/mcp' }, reason: 'test' },
    { server: { id: 'http', name: 'HTTP', transport: 'http', url: 'https://example.com/mcp?token=secret' }, reason: 'test' },
    { server: base, reason: 'test', sourceUrl: 'http://example.com/docs' },
    { server: base, reason: 'test', sourceUrl: 'https://user:password@example.com/docs' },
    { server: base, reason: 'test', approvalMode: 'automatic' },
  ];
  for (const input of invalid) await assert.rejects(submit('bridge_mcp_add', input));
  assert.deepEqual(jobs.list(), []);
  assert.deepEqual(store.config.upstreams, []);
  assert.deepEqual(hub.statuses(), []);
});

test('MCP previews keep environment references unresolved and never inherit read-only hints', async t => {
  const previous = process.env.PONTE_MCP_MANAGEMENT_SECRET;
  process.env.PONTE_MCP_MANAGEMENT_SECRET = 'resolved-only-in-upstream';
  t.after(() => { if (previous === undefined) delete process.env.PONTE_MCP_MANAGEMENT_SECRET; else process.env.PONTE_MCP_MANAGEMENT_SECRET = previous; });
  const { store, jobs, submit } = await harness(t);
  const reference = '${PONTE_MCP_MANAGEMENT_SECRET}';
  const job = await submit('bridge_mcp_add', { ...addInput(), server: { ...serverInput(), env: { FIXTURE_SECRET: reference } } });
  assert.equal((job.preview as any).server.env.FIXTURE_SECRET, reference);
  assert.equal(JSON.stringify(job.preview).includes('resolved-only-in-upstream'), false);
  jobs.approve(job.id);
  const completed = await settled(jobs, job.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(store.config.upstreams[0]?.env?.FIXTURE_SECRET, reference);
  assert.ok(payload(completed).discoveredTools.every((tool: any) => tool.risk === 'execute'));
  assert.equal(JSON.stringify(completed.result).includes('resolved-only-in-upstream'), false);
});

test('MCP connection errors preserve registration and reconnect succeeds with the unchanged revision', async t => {
  const previous = process.env.PONTE_MCP_MANAGEMENT_EXEC;
  delete process.env.PONTE_MCP_MANAGEMENT_EXEC;
  t.after(() => { if (previous === undefined) delete process.env.PONTE_MCP_MANAGEMENT_EXEC; else process.env.PONTE_MCP_MANAGEMENT_EXEC = previous; });
  const { dir, store, jobs, submit, list } = await harness(t, 'automatic');
  const added = await settled(jobs, (await submit('bridge_mcp_add', { ...addInput(), server: { ...serverInput(), command: '${PONTE_MCP_MANAGEMENT_EXEC}' } })).id);
  assert.equal(added.status, 'failed');
  assert.equal(added.result?.isError, true);
  assert.equal(payload(added).registered, true);
  assert.equal(payload(added).server.status, 'error');
  assert.deepEqual(payload(added).discoveredTools, []);
  assert.match(payload(added).nextStep, /reconect|corrig/i);
  assert.equal(store.config.upstreams.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'state', 'config.json'), 'utf8')).upstreams.length, 1);
  const listed = (await list()).servers[0];
  assert.match(listed.error, /ambiente|conex/i);
  process.env.PONTE_MCP_MANAGEMENT_EXEC = process.execPath;
  const reconnected = await settled(jobs, (await submit('bridge_mcp_reconnect', { serverId: 'fixture', expectedRevision: listed.revision, reason: 'O executável está disponível agora.' })).id);
  assert.equal(reconnected.status, 'succeeded', JSON.stringify(reconnected));
  assert.equal(payload(reconnected).server.status, 'connected');
  assert.equal((await list()).servers[0].revision, listed.revision);
});

test('MCP reconnect approval is bound to the exact configuration revision', async t => {
  const { management, hub, jobs, submit, list } = await harness(t);
  await management.adminUpsert({ ...serverInput(), enabled: true });
  const original = (await list()).servers[0];
  const reconnect = await submit('bridge_mcp_reconnect', { serverId: 'fixture', expectedRevision: original.revision, reason: 'Reconectar este cadastro.' });
  assert.equal(reconnect.status, 'pending_approval');
  assert.deepEqual((reconnect.preview as any).server, { id: 'fixture', name: 'fixture', transport: 'stdio', revision: original.revision });
  await management.adminUpsert({ id: 'fixture', name: 'Edited in panel' });
  const refresh = hub.tools().find(tool => tool.tool.title === 'refresh')!;
  await refresh.execute({}, { signal: new AbortController().signal });
  await until(() => hub.tools().some(tool => tool.tool.description?.includes('revision 1')));
  jobs.approve(reconnect.id);
  const completed = await settled(jobs, reconnect.id);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error ?? '', /revis|alterad|configura/i);
  assert.ok(hub.tools().every(tool => tool.tool.description?.includes('revision 1')), 'Stale approval must not reconnect the edited connection');
});

test('MCP cancelled and revoked jobs waiting behind a connection cannot persist later', async t => {
  for (const action of ['cancel', 'revoke'] as const) await t.test(action, async t => {
    const { management, store, jobs, submit, live } = await harness(t, 'automatic');
    const connecting = management.adminUpsert({ ...serverInput('blocker', { startupDelay: 350 }), enabled: true });
    await until(() => store.config.upstreams.some(server => server.id === 'blocker'));
    const queued = await submit('bridge_mcp_add', addInput('forbidden'));
    assert.equal(queued.status, 'running');
    if (action === 'cancel') jobs.cancel(queued.id);
    else live.delete(owner);
    await connecting;
    const completed = await settled(jobs, queued.id);
    assert.equal(completed.status, action === 'cancel' ? 'cancelled' : 'failed');
    await delay(30);
    assert.deepEqual(store.config.upstreams.map(server => server.id), ['blocker']);
  });
});

test('MCP requires a live principal at execution and closes queued mutations during shutdown', async t => {
  const { management, store, jobs, submit, live } = await harness(t);
  const noOwner = await jobs.submit('bridge_mcp_add', addInput('anonymous'));
  jobs.approve(noOwner.id);
  assert.equal((await settled(jobs, noOwner.id)).status, 'failed');
  const revoked = await submit('bridge_mcp_add', addInput('revoked'));
  live.delete(owner);
  jobs.approve(revoked.id);
  assert.equal((await settled(jobs, revoked.id)).status, 'failed');
  assert.deepEqual(store.config.upstreams, []);
  const committed = management.adminUpsert({ ...serverInput('committed', { startupDelay: 250 }), enabled: true });
  await until(() => store.config.upstreams.some(server => server.id === 'committed'));
  const queued = management.adminUpsert({ ...serverInput('queued'), enabled: true });
  const closing = management.close();
  await assert.rejects(queued, /encerr/i);
  await assert.rejects(management.adminUpsert({ ...serverInput('closed'), enabled: true }), /encerr/i);
  await committed;
  await closing;
  assert.deepEqual(store.config.upstreams.map(server => server.id), ['committed']);
});

test('MCP cancellation after persistence keeps the accepted config and finishes hub synchronization', async t => {
  const { management, store, hub, jobs, submit, list } = await harness(t, 'automatic');
  const started = await submit('bridge_mcp_add', addInput('committed', { startupDelay: 250 }));
  await until(() => store.config.upstreams.some(server => server.id === 'committed'));
  jobs.cancel(started.id);
  await management.adminUpsert({ ...serverInput('following'), enabled: true });
  assert.equal(jobs.get(started.id).status, 'cancelled');
  assert.deepEqual(store.config.upstreams.map(server => server.id).sort(), ['committed', 'following']);
  assert.deepEqual(hub.statuses().map(server => [server.id, server.status]).sort(), [['committed', 'connected'], ['following', 'connected']]);
  assert.equal((await list()).servers.find((server: any) => server.id === 'committed').status, 'connected');
});

test('MCP storage failures leave no hub registration and expose a safe fixed error', async t => {
  const { dir, store, hub, jobs, submit } = await harness(t, 'automatic');
  const destination = join(dir, 'state', 'config.json');
  await rename(destination, destination + '.saved');
  await mkdir(destination);
  const completed = await settled(jobs, (await submit('bridge_mcp_add', addInput())).id);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error ?? '', /salv|grav|persist/i);
  assert.equal((completed.error ?? '').includes(dir), false);
  assert.deepEqual(store.config.upstreams, []);
  assert.deepEqual(hub.statuses(), []);
});

test('MCP panel upserts preserve omission and null semantics and serialize removal/reconnection', async t => {
  const { management, store, hub } = await harness(t);
  await management.adminUpsert({ ...serverInput(), enabled: false, allowedTools: ['echo'], env: { SECRET: 'panel-private-value' } });
  await management.adminUpsert({ id: 'fixture', name: 'Renamed' });
  assert.deepEqual(store.config.upstreams[0]?.allowedTools, ['echo']);
  assert.equal(store.config.upstreams[0]?.env?.SECRET, 'panel-private-value');
  await management.adminUpsert({ id: 'fixture', allowedTools: [] });
  assert.deepEqual(store.config.upstreams[0]?.allowedTools, []);
  await management.adminUpsert({ id: 'fixture', allowedTools: null });
  assert.equal(store.config.upstreams[0]?.allowedTools, undefined);
  await assert.rejects(management.adminUpsert({ id: 'fixture', allowedTools: 1 }));
  await assert.rejects(management.adminUpsert({ id: 'fixture', env: { SECRET: '[REDACTED]' } }), /ocult|refer/i);
  await assert.rejects(management.adminUpsert({ ...serverInput('bridge'), enabled: false }), /reserv/i);
  await management.adminReconnect('fixture');
  assert.equal(hub.statuses()[0]?.status, 'disabled');
  await management.adminRemove('fixture');
  assert.deepEqual(store.config.upstreams, []);
  assert.deepEqual(hub.statuses(), []);
  await assert.rejects(management.adminReconnect('fixture'), /encontrad/i);
});

test('MCP Roblox admin preset keeps an existing registration and the platform guard', async t => {
  const { management, store } = await harness(t);
  await management.adminUpsert({ ...serverInput('roblox'), enabled: false, name: 'Existing Roblox configuration' });
  const before = store.config;
  if (process.platform === 'darwin' || process.platform === 'win32') await management.adminRoblox();
  else await assert.rejects(management.adminRoblox(), /Windows|macOS/i);
  assert.deepEqual(store.config, before);
});
