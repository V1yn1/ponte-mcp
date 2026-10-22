import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, parseConfig } from '../src/core/config.js';
import type { AppConfig } from '../src/types.js';

function legacyConfig(root: string): AppConfig {
  return {
    version: 1, port: 4317, apiPort: 4318, publicUrl: 'https://ponte.example.com', approvalMode: 'all',
    projects: [{ id: 'principal', name: 'Projeto principal', root, allowWrite: true, allowExec: false }],
    upstreams: [{ id: 'fixture', name: 'Fixture', transport: 'stdio', enabled: false, command: process.execPath, allowedTools: ['echo'] }],
  };
}

test('MCP catalog exposure defaults to full for legacy configuration and accepts only supported profiles', () => {
  const legacy = legacyConfig(path.join(tmpdir(), 'ponte-dot-project'));
  assert.deepEqual(parseConfig(legacy), { ...legacy, mcpToolExposure: 'full' });
  for (const mcpToolExposure of ['full', 'compact'] as const) {
    assert.deepEqual(parseConfig({ ...legacy, mcpToolExposure }), { ...legacy, mcpToolExposure });
  }
  for (const mcpToolExposure of ['', 'dots', 'unknown', null, false, 1]) {
    assert.throws(() => parseConfig({ ...legacy, mcpToolExposure }));
  }
});

test('MCP catalog profile persists without replacing legacy state, permissions, or credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ponte-dot-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  await mkdir(stateDir);
  const configPath = path.join(stateDir, 'config.json');
  const legacy = legacyConfig(path.join(dir, 'project'));
  await writeFile(configPath, JSON.stringify(legacy), { mode: 0o600 });

  const store = await ConfigStore.open(stateDir);
  const secrets = store.secrets;
  assert.equal(store.config.mcpToolExposure, 'full');
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), legacy);

  for (const mcpToolExposure of ['compact', 'full'] as const) {
    const expected = { ...legacy, mcpToolExposure };
    await store.update(config => ({ ...config, mcpToolExposure }));
    assert.deepEqual(store.config, expected);
    assert.deepEqual(store.publicConfig(), expected);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), expected);
    const reopened = await ConfigStore.open(stateDir);
    assert.deepEqual(reopened.config, expected);
    assert.deepEqual(reopened.secrets, secrets);
  }

  const saved = await readFile(configPath, 'utf8');
  await assert.rejects(store.update(config => ({ ...config, mcpToolExposure: 'invalid' as AppConfig['mcpToolExposure'] })));
  assert.deepEqual(store.config, { ...legacy, mcpToolExposure: 'full' });
  assert.equal(await readFile(configPath, 'utf8'), saved);
});
