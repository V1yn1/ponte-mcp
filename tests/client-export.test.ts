import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from '../src/core/config.js';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ponte-client-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'estado com espaços');
  const store = await ConfigStore.open(stateDir, { workspace: path.join(root, 'project') });
  const run = (...args: string[]) => execute(process.execPath, [
    '--import', 'tsx', path.join(projectRoot, 'src', 'cli.ts'),
    'export-client', ...args, '--state-dir', stateDir,
  ], { cwd: projectRoot, encoding: 'utf8', timeout: 20000 });
  return { root, stateDir, store, run };
}

test('client export works offline with the actual state directory and never includes credentials', async t => {
  const { stateDir, store, run } = await fixture(t);
  const before = await readFile(path.join(stateDir, 'config.json'), 'utf8');
  const result = await run('gemini-cli-stdio');
  const config = JSON.parse(result.stdout);
  assert.equal(config.mcpServers.ponte.command, process.execPath);
  assert.deepEqual(config.mcpServers.ponte.args, [path.join(projectRoot, 'dist', 'cli.js'), 'stdio', '--state-dir', stateDir]);
  assert.equal(config.mcpServers.ponte.trust, false);
  assert.ok(config.mcpServers.ponte.timeout > 45000);
  assert.ok(!result.stdout.includes(store.secrets.apiToken));
  assert.ok(!result.stdout.includes(store.secrets.adminToken));
  assert.equal(await readFile(path.join(stateDir, 'config.json'), 'utf8'), before);
});

test('remote client export accepts an explicit origin without saving it and refuses to overwrite an existing file', async t => {
  const { root, stateDir, run } = await fixture(t);
  const before = await readFile(path.join(stateDir, 'config.json'), 'utf8');
  const output = path.join(root, 'gemini.json');
  const result = await run('gemini-cli-http', '--url', 'https://ponte.example.com', '--output', output);
  assert.equal(result.stdout, '');
  const config = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(config.mcpServers.ponte.httpUrl, 'https://ponte.example.com/mcp');
  assert.equal(config.mcpServers.ponte.url, undefined, 'Gemini url would incorrectly select SSE');
  await writeFile(output, 'existing client configuration');
  await assert.rejects(run('grok-build-http', '--url', 'https://ponte.example.com', '--output', output));
  assert.equal(await readFile(output, 'utf8'), 'existing client configuration');
  assert.equal(await readFile(path.join(stateDir, 'config.json'), 'utf8'), before);
});

test('unavailable or unknown client profiles fail before creating an output artifact', async t => {
  const { root, run } = await fixture(t);
  const output = path.join(root, 'missing.json');
  await assert.rejects(run('gemini-cli-http', '--output', output), /HTTPS|pública|publicUrl/i);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  await assert.rejects(run('unknown-provider', '--url', 'https://ponte.example.com', '--output', output), /perfil|cliente/i);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  await assert.rejects(run('gemini-api', '--url', 'http://localhost:4318', '--output', output));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
