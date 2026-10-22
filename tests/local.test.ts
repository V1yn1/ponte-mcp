import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalTools } from '../src/tools/local.js';
import type { AppConfig, ToolDefinition } from '../src/types.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: TestContext, stateInside = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ponte-local-'));
  const root = path.join(base, 'project');
  const stateDir = stateInside ? path.join(root, 'bridge-data') : path.join(base, 'state');
  await fs.mkdir(root);
  await fs.mkdir(stateDir);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config: AppConfig = {
    version: 1, port: 4317, apiPort: 4318, approvalMode: 'mutations', upstreams: [],
    projects: [{ id: 'demo', name: 'Demo', root, allowWrite: true, allowExec: true }],
  };
  const definitions = createLocalTools(() => config, stateDir);
  const tool = (name: string): ToolDefinition => {
    const found = definitions.find((entry) => entry.tool.name === name);
    assert.ok(found, `Missing local tool ${name}`);
    return found;
  };
  const run = async (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const result = await tool(name).execute(args, { signal });
    const first = result.content[0];
    assert.equal(first?.type, 'text');
    return { result, value: JSON.parse((first as { text: string }).text) };
  };
  return { base, root, stateDir, config, definitions, tool, run };
}

test('local project listing is bounded and reflects permission changes', async (t) => {
  const f = await fixture(t);
  f.config.projects.push({ ...f.config.projects[0]!, id: 'second', name: 'Second' });
  const first = (await f.run('local_projects', { limit: 1 })).value;
  assert.equal(first.projects.length, 1);
  assert.equal(first.projects[0].id, 'demo');
  assert.equal(first.nextOffset, 1);
  const next = (await f.run('local_projects', { limit: 1, offset: first.nextOffset })).value;
  assert.equal(next.projects[0].id, 'second');
  assert.equal(next.nextOffset, null);
  const fingerprint = f.tool('local_write_file').fingerprint;
  f.config.projects[0]!.allowWrite = false;
  assert.notEqual(f.tool('local_write_file').fingerprint, fingerprint);
  assert.equal((await f.run('local_projects', {})).value.projects[0].allowWrite, false);
});

test('directory listings paginate and omit sensitive names', async (t) => {
  const f = await fixture(t);
  await Promise.all(['a.txt', 'b.txt', 'c.txt', '.env.local'].map((name) => fs.writeFile(path.join(f.root, name), name)));
  await fs.mkdir(path.join(f.root, '.git'));
  await fs.mkdir(path.join(f.root, 'nested'));
  const first = (await f.run('local_list_files', { projectId: 'demo', limit: 2 })).value;
  assert.deepEqual(first.entries.map((entry: { path: string }) => entry.path), ['a.txt', 'b.txt']);
  assert.equal(first.nextOffset, 2);
  const second = (await f.run('local_list_files', { projectId: 'demo', limit: 2, offset: 2 })).value;
  assert.deepEqual(second.entries.map((entry: { path: string }) => entry.path), ['c.txt', 'nested']);
  assert.equal(second.nextOffset, null);
});

test('read returns exact UTF-8 content and its SHA-256', async (t) => {
  const f = await fixture(t);
  const content = '\ufeffOlá, projeto!\r\n';
  await fs.writeFile(path.join(f.root, 'hello.txt'), content);
  const { value } = await f.run('local_read_file', { projectId: 'demo', path: 'hello.txt' });
  assert.equal(value.path, 'hello.txt');
  assert.equal(value.content, content);
  assert.equal(value.sha256, sha256(content));
});

test('portable path guard rejects traversal, Windows aliases and sensitive segments', async (t) => {
  const f = await fixture(t);
  const prohibited = [
    '../outside.txt', 'nested/../../outside.txt', '/tmp/secret', 'C:\\secret', 'C:secret',
    '//server/share', '\\\\server\\share', 'nested\\file.txt', 'file:stream', 'NUL.txt',
    'aux', 'COM1', 'LPT9.log', 'report.', 'report ', '.git/config', '.env', '.env.local',
    '.ssh/id_rsa', '.aws/credentials', '.ponte/token', 'node_modules/index.js',
  ];
  for (const candidate of prohibited) {
    await assert.rejects(f.run('local_read_file', { projectId: 'demo', path: candidate }), /path|caminho|sensitive|sensível|reserved|relative|blocked|proibido/i, candidate);
  }
});

test('application state directory is inaccessible even with an ordinary name', async (t) => {
  const f = await fixture(t, true);
  await fs.writeFile(path.join(f.stateDir, 'tokens.json'), 'secret');
  await assert.rejects(f.run('local_read_file', { projectId: 'demo', path: 'bridge-data/tokens.json' }), /state|configuration|protected|blocked/i);
  const { value } = await f.run('local_list_files', { projectId: 'demo' });
  assert.equal(value.entries.some((entry: { path: string }) => entry.path === 'bridge-data'), false);
});

test('symlink files and directories cannot escape the project', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(f.root, 'link.txt'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows symlink permission unavailable'); return; }
    throw error;
  }
  for (const candidate of ['linked/secret.txt', 'link.txt']) {
    await assert.rejects(f.run('local_read_file', { projectId: 'demo', path: candidate }), /symlink|symbolic/i);
    await assert.rejects(f.tool('local_write_file').preview!({ projectId: 'demo', path: candidate, content: 'changed', expectedHash: sha256('outside') }), /symlink|symbolic/i);
  }
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  assert.deepEqual((await f.run('local_list_files', { projectId: 'demo' })).value.entries, []);
});

test('write previews display a diff without modifying files or creating backups', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'note.txt'), 'before\n');
  const preview = await f.tool('local_write_file').preview!({ projectId: 'demo', path: 'note.txt', content: 'after\n', expectedHash: sha256('before\n') }) as Record<string, unknown>;
  assert.equal(preview.beforeHash, sha256('before\n'));
  assert.equal(preview.afterHash, sha256('after\n'));
  assert.equal(preview.created, false);
  assert.match(preview.diff as string, /-before\n\+after/);
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'before\n');
  assert.deepEqual(await fs.readdir(f.stateDir), []);
});

test('overly complex diffs are refused before any mutation', async (t) => {
  const f = await fixture(t);
  const before = Array.from({ length: 1200 }, (_, index) => `before-${index}\n`).join('');
  const after = Array.from({ length: 1200 }, (_, index) => `after-${index}\n`).join('');
  await fs.writeFile(path.join(f.root, 'large-change.txt'), before);
  await assert.rejects(f.tool('local_write_file').preview!({ projectId: 'demo', path: 'large-change.txt', content: after, expectedHash: sha256(before) }), /diff.*limit|diff.*complex|review/i);
  assert.equal(await fs.readFile(path.join(f.root, 'large-change.txt'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.stateDir), []);
});

test('writes create complete files and retain a private backup before replacement', async (t) => {
  const f = await fixture(t);
  const created = (await f.run('local_write_file', { projectId: 'demo', path: 'note.txt', content: 'original\n', expectedHash: null })).value;
  assert.equal(created.created, true);
  assert.equal(created.backupId, null);
  const replaced = (await f.run('local_write_file', { projectId: 'demo', path: 'note.txt', content: 'new\n', expectedHash: created.afterHash })).value;
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'new\n');
  assert.match(replaced.backupId, /^[a-f0-9-]{36}$/);
  assert.equal(await fs.readFile(path.join(f.stateDir, 'backups', `${replaced.backupId}.bak`), 'utf8'), 'original\n');
  assert.equal(Object.hasOwn(replaced, 'backupPath'), false);
  assert.deepEqual(await fs.readdir(f.root), ['note.txt']);
});

test('missing and stale expected hashes never clobber an existing file', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'note.txt'), 'original');
  for (const extra of [{}, { expectedHash: null }, { expectedHash: sha256('stale') }]) {
    await assert.rejects(f.run('local_write_file', { projectId: 'demo', path: 'note.txt', content: 'bad', ...extra }), /expectedHash|hash|conflict|exists/i);
  }
  await assert.rejects(f.run('local_write_file', { projectId: 'demo', path: 'missing.txt', content: 'bad', expectedHash: sha256('stale') }), /hash|conflict|exist/i);
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'original');
});

test('exact edits reject missing and overlapping ambiguous matches', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'note.txt'), 'aaa');
  const base = { projectId: 'demo', path: 'note.txt', newText: 'b', expectedHash: sha256('aaa') };
  await assert.rejects(f.run('local_edit_file', { ...base, oldText: 'aa' }), /ambiguous|multiple|exactly one/i);
  await assert.rejects(f.run('local_edit_file', { ...base, oldText: 'absent' }), /not found|no match/i);
  await assert.rejects(f.run('local_edit_file', { ...base, oldText: '' }), /empty|oldText/i);
  const edited = (await f.run('local_edit_file', { ...base, oldText: 'aaa', newText: 'unique\n' })).value;
  assert.equal(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8'), 'unique\n');
  assert.equal(edited.afterHash, sha256('unique\n'));
});

test('concurrent writes with the same expected hash allow exactly one replacement', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'note.txt'), 'original');
  const outcomes = await Promise.allSettled(['one', 'two'].map((content) => f.run('local_write_file', { projectId: 'demo', path: 'note.txt', content, expectedHash: sha256('original') })));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.ok(['one', 'two'].includes(await fs.readFile(path.join(f.root, 'note.txt'), 'utf8')));
});

test('write and command permissions are rechecked after preview', async (t) => {
  const f = await fixture(t);
  const args = { projectId: 'demo', path: 'new.txt', content: 'value', expectedHash: null };
  await f.tool('local_write_file').preview!(args);
  f.config.projects[0]!.allowWrite = false;
  f.config.projects[0]!.allowExec = false;
  await assert.rejects(f.run('local_write_file', args), /write|permission|disabled/i);
  await assert.rejects(f.tool('local_write_file').preview!(args), /write|permission|disabled/i);
  await assert.rejects(f.run('local_exec', { projectId: 'demo', executable: process.execPath }), /execution|permission|disabled/i);
});

test('directory creation previews nested parents without side effects and is idempotent', async (t) => {
  const f = await fixture(t);
  const args = { projectId: 'demo', path: 'src/features/new-module' };
  const preview = await f.tool('local_create_directory').preview!(args) as { directoriesToCreate: string[] };
  assert.deepEqual(preview.directoriesToCreate, ['src', 'src/features', 'src/features/new-module']);
  assert.deepEqual(await fs.readdir(f.root), []);
  const created = (await f.run('local_create_directory', args)).value;
  assert.equal(created.created, true);
  assert.equal((await fs.stat(path.join(f.root, 'src', 'features', 'new-module'))).isDirectory(), true);
  assert.equal((await f.run('local_create_directory', args)).value.created, false);
  await assert.rejects(f.run('local_create_directory', { projectId: 'demo', path: 'missing/child', recursive: false }), /ENOENT|parent|exist/i);
});

test('directory creation rejects escapes, protected paths, symlinks and disabled writes', async (t) => {
  const f = await fixture(t, true);
  for (const candidate of ['../outside', '.git/hooks', '.env/child', 'bridge-data/private']) {
    await assert.rejects(f.run('local_create_directory', { projectId: 'demo', path: candidate }), /path|protected|blocked|sensitive/i);
  }
  await fs.symlink(f.base, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.run('local_create_directory', { projectId: 'demo', path: 'linked/outside' }), /symlink|symbolic/i);
  f.config.projects[0]!.allowWrite = false;
  await assert.rejects(f.run('local_create_directory', { projectId: 'demo', path: 'new' }), /write|permission|disabled/i);
});

test('literal search limits matches and skips sensitive and binary files', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'code.txt'), 'a.b\naxb\na.b\na.b\n');
  await fs.writeFile(path.join(f.root, '.env'), 'a.b');
  await fs.writeFile(path.join(f.root, 'binary.dat'), Buffer.from([0, 97, 46, 98]));
  const { value } = await f.run('local_search', { projectId: 'demo', query: 'a.b', maxResults: 2 });
  assert.equal(value.matches.length, 2);
  assert.deepEqual(value.matches.map((match: { line: number }) => match.line), [1, 3]);
  assert.equal(value.matches.every((match: { path: string }) => match.path === 'code.txt'), true);
  assert.equal(value.truncated, true);
});

test('binary files consume the search byte budget instead of permitting unbounded reads', async (t) => {
  const f = await fixture(t);
  const binary = Buffer.alloc(1024 * 1024, 0);
  for (let index = 0; index < 17; index++) await fs.writeFile(path.join(f.root, `binary-${String(index).padStart(2, '0')}.dat`), binary);
  await fs.writeFile(path.join(f.root, 'z.txt'), 'needle');
  const { value } = await f.run('local_search', { projectId: 'demo', query: 'needle' });
  assert.equal(value.truncated, true);
  assert.equal(value.matches.length, 0);
  assert.ok(value.bytesSearched <= 16 * 1024 * 1024);
});

test('binary, oversized and multiply linked files are refused', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'binary.dat'), Buffer.from([0xff, 0xfe, 0]));
  await fs.writeFile(path.join(f.root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
  await fs.writeFile(path.join(f.root, 'original.txt'), 'linked');
  await fs.link(path.join(f.root, 'original.txt'), path.join(f.root, 'hardlink.txt'));
  await assert.rejects(f.run('local_read_file', { projectId: 'demo', path: 'binary.dat' }), /UTF-8|binary|text/i);
  await assert.rejects(f.run('local_read_file', { projectId: 'demo', path: 'large.txt' }), /large|limit|MiB/i);
  await assert.rejects(f.run('local_read_file', { projectId: 'demo', path: 'hardlink.txt' }), /hard.link|multiple.*link/i);
});

test('execution uses separate arguments, a validated working directory and a minimal environment', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'nested'));
  const previous = process.env.PONTE_ADMIN_TOKEN;
  process.env.PONTE_ADMIN_TOKEN = 'must-not-reach-child';
  t.after(() => { if (previous === undefined) delete process.env.PONTE_ADMIN_TOKEN; else process.env.PONTE_ADMIN_TOKEN = previous; });
  const literal = '$(echo should-not-execute); & |';
  const { result, value } = await f.run('local_exec', {
    projectId: 'demo', executable: process.execPath, cwd: 'nested',
    args: ['-e', 'require("node:fs").writeSync(1,JSON.stringify({argument:process.argv[1],cwd:process.cwd(),secret:process.env.PONTE_ADMIN_TOKEN ?? null}))', literal],
  });
  assert.notEqual(result.isError, true);
  assert.equal(value.exitCode, 0);
  const output = JSON.parse(value.stdout.trim());
  assert.equal(output.argument, literal);
  assert.equal(output.cwd, path.join(f.root, 'nested'));
  assert.equal(output.secret, null);
  await assert.rejects(f.run('local_exec', { projectId: 'demo', executable: process.execPath, cwd: '..' }), /path|relative/i);
});

test('execution times out and returns its bounded partial output', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const { result, value } = await f.run('local_exec', { projectId: 'demo', executable: process.execPath, args: ['-e', 'require("node:fs").writeSync(1,"started"); setInterval(()=>{},1000)'], timeoutMs: 150 });
  assert.equal(result.isError, true);
  assert.equal(value.timedOut, true);
  assert.equal(value.reason, 'timeout');
});

test('execution stops at the combined output byte cap', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const { result, value } = await f.run('local_exec', { projectId: 'demo', executable: process.execPath, args: ['-e', 'require("node:fs").writeSync(1,"x".repeat(100000)); require("node:fs").writeSync(2,"y".repeat(100000)); setInterval(()=>{},1000)'], maxOutputBytes: 1024 });
  assert.equal(result.isError, true);
  assert.equal(value.truncated, true);
  assert.equal(value.reason, 'output_limit');
  assert.ok(Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) <= 1024);
});

test('cancellation rejects and stops a running process tree', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'ticks.txt');
  const grandchild = `const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = f.run('local_exec', { projectId: 'demo', executable: process.execPath, args: ['-e', script], timeoutMs: 5000 }, controller.signal);
  const rejected = assert.rejects(running, /abort|cancel/i);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fs.stat(marker).then(() => true, () => false)) break;
    await delay(20);
  }
  assert.ok(await fs.stat(marker).then(() => true, () => false), 'Grandchild should run before cancellation');
  controller.abort();
  await rejected;
  const stoppedAt = await fs.readFile(marker, 'utf8');
  await delay(100);
  assert.equal(await fs.readFile(marker, 'utf8'), stoppedAt);
});
