import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { publicUrlSchema } from '../src/core/config.js';

type Commands = { claudeHttpCommand(url: string, platform: string): { command: string; shell: string } };
async function commands(): Promise<Commands> {
  const window: { PonteClientCommands?: Commands } = {};
  vm.runInNewContext(await readFile(new URL('../public/client-commands.js', import.meta.url), 'utf8'), { window });
  return window.PonteClientCommands!;
}

test('Claude command keeps a configured URL as one literal POSIX shell argument', async () => {
  const helper = await commands();
  const url = publicUrlSchema.parse('https://example.com;id;echo') + '/mcp';
  const generated = helper.claudeHttpCommand(url, 'linux');
  assert.equal(generated.shell, 'Bash / Zsh');
  if (process.platform !== 'win32') {
    const output = execFileSync('/bin/sh', ['-c', 'claude() { printf "%s\\n" "$@"; }; ' + generated.command], { encoding: 'utf8', timeout: 2000 });
    assert.equal(output, ['mcp', 'add', '--transport', 'http', 'ponte', url, ''].join('\n'));
  }
});

test('Claude POSIX command protects apostrophes, substitutions and backticks', async () => {
  const helper = await commands();
  const url = "https://example.com'$(printf INJECTED)`printf UNEXPECTED`/mcp";
  const generated = helper.claudeHttpCommand(url, 'darwin');
  if (process.platform !== 'win32') {
    const output = execFileSync('/bin/sh', ['-c', 'claude() { printf "%s\\n" "$@"; }; ' + generated.command], { encoding: 'utf8', timeout: 2000 });
    assert.equal(output.split('\n')[5], url);
    assert.equal(output.split('\n').length, 7);
  }
  assert.ok(generated.command.includes("'\\''"));
});

test('Claude Windows command names PowerShell and doubles literal apostrophes', async () => {
  const helper = await commands();
  const url = "https://example.com'$(Write-Output INJECTED);echo/mcp";
  const generated = helper.claudeHttpCommand(url, 'win32');
  assert.equal(generated.shell, 'PowerShell');
  assert.equal(generated.command, "claude mcp add --transport http ponte 'https://example.com''$(Write-Output INJECTED);echo/mcp'");
});

test('Claude command rejects control characters instead of generating another command line', async () => {
  const helper = await commands();
  for (const platform of ['linux', 'win32']) {
    for (const character of ['\n', '\r', '\0']) {
      assert.throws(() => helper.claudeHttpCommand('https://example.com/' + character + 'mcp', platform));
    }
  }
});
