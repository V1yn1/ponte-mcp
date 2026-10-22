import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLIENT_PROFILE_IDS, createClientProfiles, exportClientProfile, buildApiRequest, apiTokenCommand, type ClientProfileContext, type ClientProfileId } from '../src/clients/profiles.js';

const context: ClientProfileContext = Object.freeze({ platform: 'linux', nodePath: '/usr/bin/node', cliPath: '/opt/Ponte MCP/dist/cli.js', stateDir: '/opt/Ponte MCP/.ponte', publicUrl: 'https://ponte.example.com' });
const apiOptions = Object.freeze({ model: 'test-model', prompt: 'Confira o estado da Ponte.', mcpUrl: 'https://ponte.example.com/mcp', mcpToken: 'opaque-test-token' });

function profile(id: ClientProfileId, input = context) {
  const value = exportClientProfile(id, input);
  assert.equal(value.available, true);
  return value;
}

function tomlEntry(content: string) {
  const lines = content.trimEnd().split('\n');
  assert.equal(lines.shift(), '[mcp_servers.ponte]');
  const result: Record<string, unknown> = {};
  for (const line of lines) {
    const match = /^([a-z_]+) = (.+)$/.exec(line);
    assert.ok(match, 'Each generated TOML field must remain on its own line.');
    result[match[1]!] = JSON.parse(match[2]!);
  }
  return result;
}

function executeCommand(command: string, executable: 'gemini' | 'grok') {
  const stub = `${executable}() { printf '%s\\0' "$@"; }; `;
  return execFileSync('/bin/sh', ['-c', stub + command], { encoding: 'utf8', timeout: 2000 }).split('\0').slice(0, -1);
}

test('profiles generate separate native client formats without mutating configuration or exposing extra secrets', () => {
  const input = Object.freeze({ ...context, adminToken: 'never-export-admin', apiToken: 'never-export-api' });
  const profiles = createClientProfiles(input);
  assert.equal(profiles.length, 6);
  assert.deepEqual(profiles.map(item => item.id), [...CLIENT_PROFILE_IDS]);
  assert.ok(profiles.every(item => item.available && item.content.endsWith('\n')));
  assert.ok(!JSON.stringify(profiles).includes('never-export'));
  assert.deepEqual(context, { platform: 'linux', nodePath: '/usr/bin/node', cliPath: '/opt/Ponte MCP/dist/cli.js', stateDir: '/opt/Ponte MCP/.ponte', publicUrl: 'https://ponte.example.com' });
});

test('local profiles preserve absolute Windows paths and use JSON for Gemini and TOML for Grok', () => {
  const input = { ...context, platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\Projetos\\Ponte — ação\\dist\\cli.js', stateDir: 'C:\\Users\\Vinícius\\Ponte MCP\\.ponte' };
  const gemini = profile('gemini-cli-stdio', input);
  const entry = JSON.parse(gemini.content).mcpServers.ponte;
  assert.equal(gemini.format, 'json');
  assert.equal(entry.command, input.nodePath);
  assert.deepEqual(entry.args, [input.cliPath, 'stdio', '--state-dir', input.stateDir]);
  assert.equal(entry.timeout, 60000);
  assert.equal(entry.trust, false);
  const grok = profile('grok-build-stdio', input);
  assert.equal(grok.format, 'toml');
  assert.deepEqual(tomlEntry(grok.content), { command: input.nodePath, args: entry.args, startup_timeout_sec: 30, tool_timeout_sec: 60 });
});

test('remote CLI profiles use Streamable HTTP and leave authentication to each client', () => {
  const gemini = JSON.parse(profile('gemini-cli-http').content).mcpServers.ponte;
  assert.equal(gemini.httpUrl, 'https://ponte.example.com/mcp');
  assert.equal(gemini.url, undefined);
  assert.equal(gemini.trust, false);
  assert.equal(gemini.timeout, 60000);
  assert.equal(gemini.headers, undefined);
  const grok = tomlEntry(profile('grok-build-http').content);
  assert.equal(grok.url, 'https://ponte.example.com/mcp');
  assert.equal(grok.startup_timeout_sec, 30);
  assert.equal(grok.tool_timeout_sec, 60);
  assert.equal(grok.headers, undefined);
});

test('missing public URL disables only remote exports with actionable errors', () => {
  const input = { ...context, publicUrl: undefined };
  const profiles = createClientProfiles(input);
  assert.deepEqual(profiles.filter(item => item.available).map(item => item.id), ['gemini-cli-stdio', 'grok-build-stdio']);
  for (const item of profiles.filter(item => !item.available)) {
    assert.equal(item.requiresPublicUrl, true);
    assert.equal(item.content, '');
    assert.equal(item.command, undefined);
    assert.match(item.reason!, /URL pública HTTPS/);
    assert.throws(() => exportClientProfile(item.id, input), /URL pública HTTPS/);
  }
  assert.throws(() => exportClientProfile('unknown', input), /Perfil de cliente desconhecido/);
});

test('an invalid public origin does not disable valid local profiles', () => {
  for (const publicUrl of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/mcp', 'https://example.com?token=secret', 'https://example.com/#fragment', 'https://localhost', 'https://127.0.0.1']) {
    const profiles = createClientProfiles({ ...context, publicUrl });
    assert.deepEqual(profiles.filter(item => item.available).map(item => item.id), ['gemini-cli-stdio', 'grok-build-stdio'], publicUrl);
    assert.ok(profiles.filter(item => !item.available).every(item => item.content === '' && item.reason));
  }
});

test('unrepresentable local paths disable only the affected local profiles', () => {
  for (const stateDir of ['relative/state', '/tmp/state\n[next.section]', '/tmp/state\0bad', '/tmp/state\ud800']) {
    const profiles = createClientProfiles({ ...context, stateDir });
    assert.deepEqual(profiles.filter(item => !item.available).map(item => item.id), ['gemini-cli-stdio', 'grok-build-stdio']);
    assert.ok(profiles.filter(item => !item.available).every(item => item.reason && item.content === '' && !item.command));
  }
  const expanded = createClientProfiles({ ...context, stateDir: '/tmp/${PONTE_OTHER_STATE}' });
  assert.ok(expanded.filter(item => item.id.endsWith('stdio')).every(item => !item.available && /variáveis/.test(item.reason!)));
  const geminiOnly = createClientProfiles({ ...context, stateDir: '/tmp/$PONTE_OTHER_STATE' });
  assert.equal(geminiOnly.find(item => item.id === 'gemini-cli-stdio')!.available, false);
  assert.equal(geminiOnly.find(item => item.id === 'grok-build-stdio')!.available, true);
});

test('POSIX commands preserve shell syntax in paths as literal child arguments', () => {
  if (process.platform === 'win32') return;
  const input = { ...context, cliPath: "/opt/Ponte '$(printf INJECTED)`printf UNEXPECTED`/cli.js", stateDir: '/opt/Ponte "ação";printf BAD/.ponte' };
  const child = [input.nodePath, input.cliPath, 'stdio', '--state-dir', input.stateDir];
  const grok = profile('grok-build-stdio', input).command!;
  assert.equal(grok.shell, 'Bash / Zsh');
  assert.deepEqual(executeCommand(grok.text, 'grok'), ['mcp', 'add', 'ponte', '--', ...child]);
  const gemini = profile('gemini-cli-stdio', input).command!;
  assert.deepEqual(executeCommand(gemini.text, 'gemini'), ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', '--timeout', '60000', 'ponte', input.nodePath, '--', ...child.slice(1)]);
});

test('HTTP commands keep the public endpoint one argument and request documented transports', () => {
  if (process.platform === 'win32') return;
  const input = { ...context, publicUrl: 'https://bridge-123.example.com' };
  assert.deepEqual(executeCommand(profile('grok-build-http', input).command!.text, 'grok'), ['mcp', 'add', '--transport', 'http', 'ponte', input.publicUrl + '/mcp']);
  assert.deepEqual(executeCommand(profile('gemini-cli-http', input).command!.text, 'gemini'), ['mcp', 'add', '--scope', 'user', '--transport', 'http', '--timeout', '60000', 'ponte', input.publicUrl + '/mcp']);
});

test('remote endpoints reject invalid DNS names and client variable interpolation', () => {
  for (const publicUrl of ['https://bridge.${OTHER_HOST}.example.com', 'https://bridge.$OTHER_HOST.example.com', 'https://example.com;printf', 'https://-invalid.example.com', 'https://bridge..example.com', 'https://%24HOST.example.com']) {
    const profiles = createClientProfiles({ ...context, publicUrl });
    assert.ok(profiles.filter(item => item.requiresPublicUrl).every(item => !item.available && !item.command && item.content === ''), publicUrl);
    assert.ok(profiles.filter(item => !item.requiresPublicUrl).every(item => item.available));
    assert.throws(() => buildApiRequest('grok', { ...apiOptions, mcpUrl: publicUrl + '/mcp' }), /URL MCP/);
  }
});

test('PowerShell commands quote literals and identify their shell', () => {
  const input = { ...context, platform: 'win32', nodePath: 'C:\\Program Files\\node.exe', cliPath: "C:\\Ponte '$(Write-Output BAD)\\cli.js", stateDir: 'C:\\Users\\Vini\\.ponte' };
  for (const id of ['gemini-cli-stdio', 'grok-build-stdio'] as const) {
    const command = profile(id, input).command!;
    assert.equal(command.shell, 'PowerShell');
    assert.ok(command.text.startsWith("& '"));
    assert.ok(command.text.includes("'C:\\Ponte ''$(Write-Output BAD)\\cli.js'"));
    assert.ok(command.text.includes("'--state-dir' 'C:\\Users\\Vini\\.ponte'"));
  }
});

test('token command addresses the actual state directory without letting the shell expand paths', () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(path.join(tmpdir(), 'ponte-client-command-'));
  try {
    const cliPath = path.join(root, "cli '$(printf BAD).mjs");
    writeFileSync(cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const stateDir = path.join(root, '${PRIVATE_STATE} "literal"');
    const command = apiTokenCommand({ ...context, nodePath: process.execPath, cliPath, stateDir });
    const received = JSON.parse(execFileSync('/bin/sh', ['-c', command.text], { encoding: 'utf8', timeout: 2000 }));
    assert.deepEqual(received, ['token', 'api', '--state-dir', stateDir]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('token command rejects malformed paths instead of producing an executable fragment', () => {
  for (const key of ['nodePath', 'cliPath', 'stateDir'] as const) {
    for (const invalid of ['relative/path', '/tmp/state\nnode bad', '/tmp/state\0bad']) assert.throws(() => apiTokenCommand({ ...context, [key]: invalid }), /caminho/i);
  }
});

test('API exports are status-only request templates using placeholders instead of credentials', () => {
  for (const [id, model] of [['gemini-api', '${GEMINI_MODEL}'], ['grok-api', '${XAI_MODEL}']] as const) {
    const request = JSON.parse(profile(id).content);
    assert.equal(request.body.model, model);
    assert.equal(request.body.tools.length, 1);
    assert.equal(request.body.tools[0].headers.Authorization, 'Bearer ${PONTE_API_TOKEN}');
    assert.deepEqual(request.body.tools[0].allowed_tools, ['bridge_status']);
    assert.ok(request.url.startsWith('https://'));
  }
});

test('Gemini API requests use Interactions remote MCP fields without enabling storage', () => {
  const result = buildApiRequest('gemini', apiOptions);
  assert.equal(result.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(result.body.model, apiOptions.model);
  assert.equal(result.body.input, apiOptions.prompt);
  assert.equal(result.body.store, false);
  const [tool] = result.body.tools as Record<string, unknown>[];
  assert.deepEqual(tool, { type: 'mcp_server', name: 'ponte', url: apiOptions.mcpUrl, headers: { Authorization: 'Bearer ' + apiOptions.mcpToken }, allowed_tools: ['bridge_status'] });
});

test('Grok API requests use Responses MCP fields without unsupported approval configuration', () => {
  const result = buildApiRequest('grok', apiOptions);
  assert.equal(result.url, 'https://api.x.ai/v1/responses');
  assert.equal(result.body.model, apiOptions.model);
  assert.deepEqual(result.body.input, [{ role: 'user', content: apiOptions.prompt }]);
  const [tool] = result.body.tools as Record<string, unknown>[];
  assert.deepEqual(tool, { type: 'mcp', server_label: 'ponte', server_url: apiOptions.mcpUrl, headers: { Authorization: 'Bearer ' + apiOptions.mcpToken }, allowed_tools: ['bridge_status'] });
  assert.equal(tool!.require_approval, undefined);
  assert.equal(tool!.connector_id, undefined);
});

test('explicit tools access includes discovery, execution and durable recovery controls independently of later mutation', () => {
  for (const provider of ['gemini', 'grok'] as const) {
    const body = buildApiRequest(provider, { ...apiOptions, access: 'tools' }).body;
    const names = (body.tools as { allowed_tools: string[] }[])[0]!.allowed_tools;
    assert.equal(names.length, 12);
    assert.equal(new Set(names).size, 12);
    for (const name of ['bridge_list_tools', 'bridge_tool_schema', 'bridge_read', 'bridge_invoke', 'bridge_call', 'bridge_job', 'bridge_cancel', 'bridge_watch_get', 'bridge_watch_list', 'bridge_watch_wait', 'bridge_watch_cancel']) assert.ok(names.includes(name));
    names.pop();
    assert.equal(((buildApiRequest(provider, { ...apiOptions, access: 'tools' }).body.tools as { allowed_tools: string[] }[])[0]!).allowed_tools.length, 12);
    assert.deepEqual(((buildApiRequest(provider, apiOptions).body.tools as { allowed_tools: string[] }[])[0]!).allowed_tools, ['bridge_status']);
  }
});

test('API request validation rejects unsafe endpoints and malformed credentials without echoing secrets', () => {
  const urls = ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp#token', 'https://localhost/mcp', 'https://127.1/mcp', 'https://10.0.0.1/mcp', 'https://172.16.0.1/mcp', 'https://192.168.0.1/mcp', 'https://[::1]/mcp', 'https://[::ffff:127.0.0.1]/mcp', 'https://[fd00::1]/mcp', 'https://[fe80::1]/mcp', ' https://example.com/mcp'];
  for (const mcpUrl of urls) assert.throws(() => buildApiRequest('gemini', { ...apiOptions, mcpUrl }), /URL MCP/);
  for (const mcpToken of ['', ' ', 'secret\r\nX-Injected: bad']) {
    assert.throws(() => buildApiRequest('grok', { ...apiOptions, mcpToken }), error => error instanceof Error && /token/i.test(error.message) && !error.message.includes('secret'));
  }
  for (const key of ['model', 'prompt'] as const) assert.throws(() => buildApiRequest('gemini', { ...apiOptions, [key]: ' ' }), /modelo|prompt/);
  assert.throws(() => buildApiRequest('unknown' as 'gemini', apiOptions), /Provedor/);
  assert.throws(() => buildApiRequest('grok', { ...apiOptions, access: 'all' as 'tools' }), /acesso/);
  assert.doesNotThrow(() => buildApiRequest('grok', { ...apiOptions, mcpUrl: 'https://[2606:4700::1111]/mcp' }));
});
