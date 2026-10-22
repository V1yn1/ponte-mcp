import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { createPatch } from 'diff';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { textResult, type AppConfig, type ProjectConfig, type Risk, type ToolContext, type ToolDefinition } from '../types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_LINE = 1_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const sensitiveNames = new Set(['.git', '.ssh', '.aws', '.ponte', 'node_modules', '.gnupg', '.npmrc', '.netrc', '.pypirc', '.docker', '.azure']);
// Shared across catalog refreshes and overlapping project registrations.
const fileLocks = new Map<string, Promise<void>>();

type Arguments = Record<string, unknown>;
interface ResolvedPath { project: ProjectConfig; root: string; absolute: string; relative: string; stat?: Stats; firstMissing?: number }
interface Snapshot { content: string; bytes: Buffer; hash: string; stat: Stats }
interface WritePreview { path: string; projectId: string; diff: string; beforeHash: string | null; afterHash: string; created: boolean; bytes: number }
interface PreparedWrite { resolved: ResolvedPath; before?: Snapshot; content: string; bytes: Buffer; preview: WritePreview }
interface Entry { path: string; type: 'file' | 'directory'; bytes: number }

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sensitive = (name: string) => sensitiveNames.has(name.toLowerCase()) || name.toLowerCase().startsWith('.env');

function containsPath(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Operation cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function stringArg(args: Arguments, key: string, maxLength: number, fallback?: string): string {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${key} must be a string of at most ${maxLength} characters`);
  return value;
}

function integerArg(args: Arguments, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function booleanArg(args: Arguments, key: string, fallback: boolean): boolean {
  const value = args[key] ?? fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

function portableRelative(raw: string): string {
  if (raw === '.') return '.';
  if (!raw || raw.length > 4096 || /[\\\x00-\x1f\x7f]/u.test(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[a-z]:/iu.test(raw)) {
    throw new Error('Path must be a project-relative path using / separators');
  }
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment) || segment.length > 255) throw new Error('Path contains an invalid or traversal segment');
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(segment)) throw new Error('Path contains a reserved Windows device name');
    if (sensitive(segment)) throw new Error('Path contains a blocked sensitive segment');
  }
  return raw;
}

function textBytes(content: string): Buffer {
  if (content.includes('\0')) throw new Error('Only UTF-8 text without NUL bytes is supported');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Text file exceeds the 1 MiB limit');
  return bytes;
}

function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error('Binary files are not supported; use UTF-8 text');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('File is not valid UTF-8 text'); }
}

async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  fileLocks.set(key, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (fileLocks.get(key) === tail) fileLocks.delete(key); }
}

/**
 * These are conservative path checks, not an operating-system sandbox. Node's
 * portable APIs cannot make ancestor-directory replacement by another process
 * race-free. Execute approved commands only in trusted local workspaces.
 */
export function createLocalTools(getConfig: () => AppConfig, stateDir: string): ToolDefinition[] {
  const stateAbsolute = path.resolve(stateDir);

  function projectFor(args: Arguments, permission?: 'write' | 'execute'): ProjectConfig {
    const id = stringArg(args, 'projectId', 128);
    const project = getConfig().projects.find((item) => item.id === id);
    if (!project) throw new Error('Unknown projectId');
    if (permission === 'write' && project.allowWrite !== true) throw new Error('Write permission is disabled for this project');
    if (permission === 'execute' && project.allowExec !== true) throw new Error('Command execution permission is disabled for this project');
    return { ...project };
  }

  async function statePaths(): Promise<string[]> {
    try { return [stateAbsolute, await fs.realpath(stateAbsolute)]; }
    catch (error) { if (errorCode(error) === 'ENOENT') return [stateAbsolute]; throw error; }
  }

  async function resolvePath(args: Arguments, options: { missing?: boolean; missingParents?: boolean; directory?: boolean; permission?: 'write' | 'execute'; key?: string } = {}): Promise<ResolvedPath> {
    const project = projectFor(args, options.permission);
    const relative = portableRelative(stringArg(args, options.key ?? 'path', 4096, options.directory ? '.' : undefined));
    if (!path.isAbsolute(project.root)) throw new Error('Project root must be an absolute path');
    const configuredRoot = path.resolve(project.root);
    if (configuredRoot.split(path.sep).some(sensitive)) throw new Error('Project path contains a blocked sensitive segment');
    const rootStat = await fs.lstat(configuredRoot);
    if (rootStat.isSymbolicLink()) throw new Error('Symbolic links are not allowed as project roots');
    if (!rootStat.isDirectory()) throw new Error('Project root is not a directory');
    const root = await fs.realpath(configuredRoot);
    if (root.split(path.sep).some(sensitive)) throw new Error('Project path contains a blocked sensitive segment');
    const absolute = path.resolve(root, relative);
    if (!containsPath(root, absolute)) throw new Error('Path escapes the project root');
    const protectedPaths = await statePaths();
    if (protectedPaths.some((protectedPath) => containsPath(protectedPath, absolute) || containsPath(protectedPath, path.resolve(configuredRoot, relative)))) throw new Error('Application state and configuration paths are protected');
    let current = root;
    let stat: Stats | undefined = rootStat;
    let firstMissing: number | undefined;
    const segments = relative === '.' ? [] : relative.split('/');
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]!);
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (options.missing && (options.missingParents || index === segments.length - 1) && errorCode(error) === 'ENOENT') { stat = undefined; firstMissing = index; break; }
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in project paths');
      if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('Path parent is not a directory');
      const canonical = await fs.realpath(current);
      if (!containsPath(root, canonical) || !samePath(canonical, current)) throw new Error('Path changed or traverses a symbolic link');
      if (protectedPaths.some((protectedPath) => containsPath(protectedPath, canonical))) throw new Error('Application state paths are protected');
    }
    if (options.directory && (stat ? !stat.isDirectory() : !options.missing)) throw new Error('Path must name a directory');
    if (!options.directory && stat && !stat.isFile()) throw new Error('Path must name a regular file');
    if (stat?.isFile() && stat.nlink > 1) throw new Error('Files with multiple hard links are blocked');
    return { project, root, absolute, relative, stat, firstMissing };
  }

  async function readSnapshot(resolved: ResolvedPath, signal?: AbortSignal, byteLimit = MAX_FILE_BYTES): Promise<Snapshot> {
    abortIfNeeded(signal);
    const handle = await fs.open(resolved.absolute, constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error('Only regular files without multiple hard links are allowed');
      if (stat.size > byteLimit) throw new Error('File is too large for the remaining read limit (at most 1 MiB)');
      const checked = await resolvePath({ projectId: resolved.project.id, path: resolved.relative });
      if (!samePath(checked.absolute, resolved.absolute) || checked.stat?.ino !== stat.ino || checked.stat?.dev !== stat.dev) throw new Error('File path changed while opening; retry');
      const chunks: Buffer[] = [];
      let length = 0;
      while (length < stat.size) {
        abortIfNeeded(signal);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('File changed while being read; retry');
      const bytes = Buffer.concat(chunks, length);
      return { bytes, content: decodeText(bytes), hash: digest(bytes), stat };
    } finally { await handle.close(); }
  }

  function expectedHash(args: Arguments, allowCreate: boolean): string | null {
    const hash = args.expectedHash;
    if (hash === null && allowCreate) return null;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/iu.test(hash)) throw new Error(`expectedHash is required: SHA-256${allowCreate ? ', or null to create a new file' : ''}`);
    return hash.toLowerCase();
  }

  async function prepareWrite(args: Arguments, edit: boolean, signal?: AbortSignal): Promise<PreparedWrite> {
    abortIfNeeded(signal);
    const expected = expectedHash(args, !edit);
    const resolved = await resolvePath(args, { missing: true, permission: 'write' });
    const before = resolved.stat ? await readSnapshot(resolved, signal) : undefined;
    if (before && expected === null) throw new Error('Hash conflict: file already exists; read it and supply expectedHash');
    if (!before && expected !== null) throw new Error('Hash conflict: expected file does not exist');
    if (before && before.hash !== expected) throw new Error('Hash conflict: file changed; read it and review a new diff');
    let content: string;
    if (edit) {
      const oldText = stringArg(args, 'oldText', MAX_FILE_BYTES);
      const newText = stringArg(args, 'newText', MAX_FILE_BYTES);
      if (!oldText) throw new Error('oldText must not be empty');
      const index = before!.content.indexOf(oldText);
      if (index === -1) throw new Error('oldText was not found in the file');
      if (before!.content.indexOf(oldText, index + 1) !== -1) throw new Error('Ambiguous edit: oldText must occur exactly once');
      content = before!.content.slice(0, index) + newText + before!.content.slice(index + oldText.length);
    } else { content = stringArg(args, 'content', MAX_FILE_BYTES); }
    const bytes = textBytes(content);
    const diff = createPatch(resolved.relative, before?.content ?? '', content, 'before', 'after', { context: 3, timeout: 250, maxEditLength: 2000 });
    if (diff === undefined || Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new Error('Diff exceeds the review complexity or size limit; make a smaller focused edit');
    const preview: WritePreview = {
      path: resolved.relative, projectId: resolved.project.id,
      diff,
      beforeHash: before?.hash ?? null, afterHash: digest(bytes), created: !before, bytes: bytes.length,
    };
    return { resolved, before, content, bytes, preview };
  }

  async function backup(bytes: Buffer): Promise<string> {
    await fs.mkdir(stateAbsolute, { recursive: true, mode: 0o700 });
    const canonicalState = await fs.realpath(stateAbsolute);
    const backupDir = path.join(canonicalState, 'backups');
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(backupDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Backup directory must be a real directory');
    const id = randomUUID();
    const handle = await fs.open(path.join(backupDir, `${id}.bak`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    return id;
  }

  async function write(args: Arguments, edit: boolean, { signal }: ToolContext) {
    const initial = await resolvePath(args, { missing: true, permission: 'write' });
    const key = process.platform === 'win32' ? initial.absolute.toLowerCase() : initial.absolute;
    return exclusive(key, async () => {
      const prepared = await prepareWrite(args, edit, signal);
      if (!samePath(initial.absolute, prepared.resolved.absolute)) throw new Error('Project path changed while waiting to write');
      const temporary = path.join(path.dirname(prepared.resolved.absolute), `.ponte-${randomUUID()}.tmp`);
      let temporaryCreated = false;
      try {
        const checked = await resolvePath(args, { missing: true, permission: 'write' });
        if (!samePath(checked.absolute, prepared.resolved.absolute)) throw new Error('Project path changed before writing');
        abortIfNeeded(signal);
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, prepared.before ? prepared.before.stat.mode & 0o777 : 0o600);
        temporaryCreated = true;
        try { await handle.writeFile(prepared.bytes); await handle.sync(); }
        finally { await handle.close(); }
        abortIfNeeded(signal);
        const backupId = prepared.before ? await backup(prepared.before.bytes) : null;
        // Revalidate both permission and content immediately before replacement.
        const final = await prepareWrite(args, edit, signal);
        if (!samePath(final.resolved.absolute, prepared.resolved.absolute) || final.preview.beforeHash !== prepared.preview.beforeHash || final.preview.afterHash !== prepared.preview.afterHash) throw new Error('Hash conflict or project path changed before replacement');
        abortIfNeeded(signal);
        if (prepared.before) {
          await fs.rename(temporary, prepared.resolved.absolute);
          temporaryCreated = false;
        } else {
          // link is atomic and fails if another process created the destination.
          try { await fs.link(temporary, prepared.resolved.absolute); }
          catch (error) { if (errorCode(error) === 'EEXIST') throw new Error('Hash conflict: file was created before replacement'); throw error; }
          await fs.unlink(temporary);
          temporaryCreated = false;
        }
        return textResult({ ...prepared.preview, backupId });
      } finally { if (temporaryCreated) await fs.unlink(temporary).catch(() => undefined); }
    });
  }

  async function prepareDirectory(args: Arguments) {
    const relative = portableRelative(stringArg(args, 'path', 4096));
    const recursive = booleanArg(args, 'recursive', true);
    const resolved = await resolvePath({ ...args, path: relative }, { directory: true, missing: true, missingParents: recursive, permission: 'write' });
    const segments = relative === '.' ? [] : relative.split('/');
    const directoriesToCreate = resolved.firstMissing === undefined ? [] : segments.map((_, index) => segments.slice(0, index + 1).join('/')).slice(resolved.firstMissing);
    return { resolved, preview: { projectId: resolved.project.id, path: relative, recursive, directoriesToCreate } };
  }

  async function createDirectory(args: Arguments, { signal }: ToolContext) {
    abortIfNeeded(signal);
    const initial = await prepareDirectory(args);
    const key = process.platform === 'win32' ? initial.resolved.absolute.toLowerCase() : initial.resolved.absolute;
    return exclusive(key, async () => {
      const prepared = await prepareDirectory(args);
      if (!samePath(prepared.resolved.absolute, initial.resolved.absolute)) throw new Error('Project path changed while waiting to create a directory');
      const createdDirectories: string[] = [];
      for (const relative of prepared.preview.directoriesToCreate) {
        abortIfNeeded(signal);
        const candidate = { projectId: prepared.resolved.project.id, path: relative };
        const checked = await resolvePath(candidate, { directory: true, missing: true, permission: 'write' });
        if (!samePath(checked.root, prepared.resolved.root)) throw new Error('Project root changed before directory creation');
        if (checked.stat) continue;
        try { await fs.mkdir(checked.absolute, { mode: 0o755 }); createdDirectories.push(relative); }
        catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
        // Never trust a racing EEXIST: it may be a file or a symbolic link.
        const after = await resolvePath(candidate, { directory: true, permission: 'write' });
        if (!samePath(after.absolute, checked.absolute)) throw new Error('Project path changed during directory creation');
      }
      return textResult({ projectId: prepared.resolved.project.id, path: prepared.resolved.relative, created: createdDirectories.length > 0, createdDirectories });
    });
  }

  async function walk(args: Arguments, recursive: boolean, signal?: AbortSignal): Promise<{ entries: Entry[]; scanned: number; truncated: boolean }> {
    const root = await resolvePath(args, { directory: true });
    const entries: Entry[] = [];
    let scanned = 0;
    let truncated = false;
    const maxDepth = integerArg(args, 'maxDepth', 8, 1, 16);
    const visit = async (relative: string, depth: number): Promise<void> => {
      abortIfNeeded(signal);
      const directory = await resolvePath({ projectId: root.project.id, path: relative }, { directory: true });
      const handle = await fs.opendir(directory.absolute);
      const children: { name: string; directory: boolean }[] = [];
      for await (const entry of handle) {
        abortIfNeeded(signal);
        scanned++;
        if (scanned > MAX_SCAN_ENTRIES) { truncated = true; break; }
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
        try { portableRelative(entry.name); } catch { continue; }
        children.push({ name: entry.name, directory: entry.isDirectory() });
      }
      children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) {
        abortIfNeeded(signal);
        const childPath = relative === '.' ? child.name : `${relative}/${child.name}`;
        let resolved: ResolvedPath;
        try { resolved = await resolvePath({ projectId: root.project.id, path: childPath }, { directory: child.directory }); }
        catch { continue; } // Restricted entries and files removed during the scan stay hidden.
        entries.push({ path: childPath, type: child.directory ? 'directory' : 'file', bytes: child.directory ? 0 : resolved.stat!.size });
        if (recursive && child.directory) {
          if (depth >= maxDepth) truncated = true;
          else if (scanned < MAX_SCAN_ENTRIES) await visit(childPath, depth + 1);
          else truncated = true;
        }
      }
    };
    await visit(root.relative, 1);
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { entries, scanned: Math.min(scanned, MAX_SCAN_ENTRIES), truncated };
  }

  const projectProperty = { type: 'string', minLength: 1, maxLength: 128, description: 'ID do projeto cadastrado.' };
  const pathProperty = { type: 'string', minLength: 1, maxLength: 4096, description: 'Caminho relativo ao projeto; use /. Links e caminhos sensíveis são bloqueados.' };
  const offsetProperty = { type: 'integer', minimum: 0, maximum: MAX_SCAN_ENTRIES, default: 0 };
  const hashProperty = { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'SHA-256 obtido por local_read_file; obrigatório para impedir sobrescritas concorrentes.' };
  const directoryProperties = { projectId: projectProperty, path: { ...pathProperty, default: '.' } };
  const maxDepthProperty = { type: 'integer', minimum: 1, maximum: 16, default: 8 };
  const schema = (properties: Record<string, object>, required: string[] = []): Tool['inputSchema'] => ({ type: 'object', properties, required, additionalProperties: false });
  const definition = (name: string, description: string, risk: Risk, inputSchema: Tool['inputSchema'], execute: ToolDefinition['execute'], preview?: ToolDefinition['preview']): ToolDefinition => ({
    tool: { name, description, inputSchema, annotations: { readOnlyHint: risk === 'read', destructiveHint: risk !== 'read', openWorldHint: risk === 'execute' } },
    risk, source: 'local',
    get fingerprint() { return digest(JSON.stringify({ version: 1, projects: getConfig().projects.map((project) => ({ id: project.id, name: project.name, root: project.root, allowWrite: project.allowWrite, allowExec: project.allowExec })), stateDir: stateAbsolute })); },
    execute, ...(preview ? { preview } : {}),
  });

  return [
    definition('local_projects', 'Lista os projetos cadastrados e suas permissões, com paginação.', 'read', schema({ offset: offsetProperty, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }), async (args, { signal }) => {
      abortIfNeeded(signal);
      const offset = integerArg(args, 'offset', 0, 0, MAX_SCAN_ENTRIES);
      const limit = integerArg(args, 'limit', 50, 1, 100);
      const projects = getConfig().projects;
      return textResult({ projects: projects.slice(offset, offset + limit).map(({ id, name, allowWrite, allowExec }) => ({ id, name, allowWrite, allowExec })), total: projects.length, nextOffset: offset + limit < projects.length ? offset + limit : null });
    }),
    definition('local_list_files', 'Lista arquivos e diretórios permitidos. Até 10.000 entradas são examinadas; refine path se truncated=true.', 'read', schema({ ...directoryProperties, recursive: { type: 'boolean', default: false }, maxDepth: maxDepthProperty, offset: offsetProperty, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }, ['projectId']), async (args, { signal }) => {
      const limit = integerArg(args, 'limit', 100, 1, 200);
      const offset = integerArg(args, 'offset', 0, 0, MAX_SCAN_ENTRIES);
      const result = await walk(args, booleanArg(args, 'recursive', false), signal);
      return textResult({ projectId: args.projectId, path: args.path ?? '.', entries: result.entries.slice(offset, offset + limit), nextOffset: offset + limit < result.entries.length ? offset + limit : null, scanned: result.scanned, truncated: result.truncated });
    }),
    definition('local_read_file', 'Lê um arquivo UTF-8 de até 1 MiB e retorna conteúdo completo e hash SHA-256.', 'read', schema({ projectId: projectProperty, path: pathProperty }, ['projectId', 'path']), async (args, { signal }) => {
      const resolved = await resolvePath(args);
      const snapshot = await readSnapshot(resolved, signal);
      return textResult({ path: resolved.relative, content: snapshot.content, sha256: snapshot.hash });
    }),
    definition('local_search', 'Pesquisa texto literal (sem regex) recursivamente. Limites: 2.000 arquivos, 16 MiB lidos, linhas de resultado com até 1.000 caracteres.', 'read', schema({ ...directoryProperties, query: { type: 'string', minLength: 1, maxLength: 4096 }, caseSensitive: { type: 'boolean', default: true }, maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, maxDepth: maxDepthProperty }, ['projectId', 'query']), async (args, { signal }) => {
      const query = stringArg(args, 'query', 4096);
      if (!query || query.includes('\0') || /[\r\n]/u.test(query)) throw new Error('query must be nonempty literal text on one line');
      const caseSensitive = booleanArg(args, 'caseSensitive', true);
      const needle = caseSensitive ? query : query.toLowerCase();
      const maxResults = integerArg(args, 'maxResults', 50, 1, 200);
      const scan = await walk(args, true, signal);
      const matches: { path: string; line: number; column: number; text: string; lineTruncated: boolean }[] = [];
      let filesSearched = 0;
      let bytesSearched = 0;
      let skippedFiles = 0;
      let truncated = scan.truncated;
      outer: for (const entry of scan.entries) {
        if (entry.type !== 'file') continue;
        abortIfNeeded(signal);
        if (filesSearched >= MAX_SEARCH_FILES || bytesSearched >= MAX_SEARCH_BYTES) { truncated = true; break; }
        if (entry.bytes > MAX_FILE_BYTES) { skippedFiles++; continue; }
        if (entry.bytes > MAX_SEARCH_BYTES - bytesSearched) { truncated = true; break; }
        // Reserve the file's byte budget before decoding: binary and invalid UTF-8
        // files cost I/O too. A growing file is refused by readSnapshot's limit.
        filesSearched++;
        bytesSearched += entry.bytes;
        let snapshot: Snapshot;
        try { snapshot = await readSnapshot(await resolvePath({ projectId: args.projectId, path: entry.path }), signal, entry.bytes); }
        catch (error) { abortIfNeeded(signal); skippedFiles++; continue; }
        const lines = snapshot.content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!.replace(/\r$/u, '');
          const column = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
          if (column === -1) continue;
          if (matches.length >= maxResults) { truncated = true; break outer; }
          const start = Math.max(0, column - 160);
          const excerpt = line.slice(start, start + MAX_SEARCH_LINE);
          matches.push({ path: entry.path, line: index + 1, column: column + 1, text: excerpt, lineTruncated: start > 0 || excerpt.length < line.length });
        }
      }
      return textResult({ projectId: args.projectId, query, matches, filesSearched, bytesSearched, skippedFiles, truncated });
    }),
    definition('local_write_file', 'Grava conteúdo completo após aprovação. expectedHash=null cria somente arquivo novo; para substituir, envie o SHA-256 atual. Mantém backup privado. Diffs limitados a 512 KiB e 2.000 linhas alteradas.', 'write', schema({ projectId: projectProperty, path: pathProperty, content: { type: 'string', maxLength: MAX_FILE_BYTES }, expectedHash: { anyOf: [hashProperty, { type: 'null' }] } }, ['projectId', 'path', 'content', 'expectedHash']), (args, context) => write(args, false, context), async (args) => (await prepareWrite(args, false)).preview),
    definition('local_edit_file', 'Substitui uma única ocorrência exata de oldText por newText após aprovação. Recusa correspondência ausente ou ambígua e hash desatualizado.', 'write', schema({ projectId: projectProperty, path: pathProperty, oldText: { type: 'string', minLength: 1, maxLength: MAX_FILE_BYTES }, newText: { type: 'string', maxLength: MAX_FILE_BYTES }, expectedHash: hashProperty }, ['projectId', 'path', 'oldText', 'newText', 'expectedHash']), (args, context) => write(args, true, context), async (args) => (await prepareWrite(args, true)).preview),
    definition('local_create_directory', 'Cria diretórios após aprovação e com allowWrite habilitado. Por padrão cria também os pais ausentes; cada componente é validado. Não remove nem move arquivos.', 'write', schema({ projectId: projectProperty, path: pathProperty, recursive: { type: 'boolean', default: true } }, ['projectId', 'path']), createDirectory, async (args) => (await prepareDirectory(args)).preview),
    definition('local_exec', 'Executa programa e argumentos sem shell implícito, sempre com aprovação e allowExec habilitado. Não é sandbox: o programa tem os privilégios do usuário. Ambiente herdado mínimo; sem overrides.', 'execute', schema({ projectId: projectProperty, executable: { type: 'string', minLength: 1, maxLength: 4096 }, args: { type: 'array', items: { type: 'string', maxLength: 65536 }, maxItems: 256, default: [] }, cwd: { ...pathProperty, default: '.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, default: 30000 }, maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 1048576, default: 131072 } }, ['projectId', 'executable']), async (args, { signal }) => {
      abortIfNeeded(signal);
      const command = await prepareCommand(args);
      abortIfNeeded(signal);
      return runCommand(command, signal);
    }, prepareCommand),
  ];

  async function prepareCommand(args: Arguments) {
    const resolved = await resolvePath(args, { directory: true, permission: 'execute', key: 'cwd' });
    const executable = stringArg(args, 'executable', 4096);
    if (!executable || /[\x00-\x1f]/u.test(executable)) throw new Error('executable must be a nonempty program name or path');
    if (process.platform === 'win32' && /\.(?:bat|cmd)$/iu.test(executable)) throw new Error('Windows batch files require an explicit approved shell executable');
    const argv = args.args ?? [];
    if (!Array.isArray(argv) || argv.length > 256 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || argv.reduce((size, arg) => size + Buffer.byteLength(arg as string), 0) > 65536) throw new Error('args must be at most 256 strings totaling at most 64 KiB, without NUL bytes');
    if (args.env !== undefined) throw new Error('Environment overrides are not allowed');
    return { projectId: resolved.project.id, executable, args: [...argv] as string[], cwd: resolved.relative, absoluteCwd: resolved.absolute, timeoutMs: integerArg(args, 'timeoutMs', 30000, 100, 120000), maxOutputBytes: integerArg(args, 'maxOutputBytes', 131072, 1024, 1048576), warning: 'O comando não é uma sandbox e terá os privilégios do usuário local.' };
  }
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
}

function killTree(child: ChildProcess, force = false): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const killer = spawn(path.join(windowsRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: commandEnvironment() });
    killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* best effort */ } });
    killer.unref();
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Process already exited. */ } }
  }
}

async function runCommand(command: { projectId: string; executable: string; args: string[]; cwd: string; absoluteCwd: string; timeoutMs: number; maxOutputBytes: number }, signal: AbortSignal) {
  const started = Date.now();
  return new Promise<ReturnType<typeof textResult>>((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(command.executable, command.args, { cwd: command.absoluteCwd, env: commandEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let captured = 0;
    let reason: 'timeout' | 'output_limit' | 'cancelled' | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = () => { clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); if (settlementTimer) clearTimeout(settlementTimer); signal.removeEventListener('abort', cancelled); };
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) killTree(child, true);
      if (reason === 'cancelled') { const cancelledError = new Error('Command cancelled'); cancelledError.name = 'AbortError'; reject(cancelledError); return; }
      if (error) { reject(error); return; }
      // Streaming TextDecoder discards a trailing partial UTF-8 sequence, keeping
      // the rendered output inside the same combined byte cap as captured data.
      const decode = (chunks: Buffer[]) => new TextDecoder().decode(Buffer.concat(chunks), { stream: true });
      let stdout = decode(output.stdout);
      let stderr = decode(output.stderr);
      const bound = (value: string, max: number) => {
        if (Buffer.byteLength(value) <= max) return value;
        return new TextDecoder().decode(Buffer.from(value).subarray(0, max), { stream: true });
      };
      stdout = bound(stdout, command.maxOutputBytes);
      stderr = bound(stderr, command.maxOutputBytes - Buffer.byteLength(stdout));
      const result = textResult({ projectId: command.projectId, executable: command.executable, args: command.args, cwd: command.cwd, exitCode, signal: exitSignal, stdout, stderr, durationMs: Date.now() - started, timedOut: reason === 'timeout', truncated: reason === 'output_limit', ...(reason ? { reason } : {}) });
      if (reason || exitCode !== 0) result.isError = true;
      resolve(result);
    };
    const stop = (why: typeof reason) => {
      if (settled) return;
      if (reason && why !== 'cancelled') return;
      if (why === 'cancelled' || !reason) reason = why;
      killTree(child);
      if (!forceTimer) forceTimer = setTimeout(() => killTree(child, true), 500);
      // Detached descendants or uninterruptible processes must not block the job forever.
      if (!settlementTimer) settlementTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(null, 'SIGKILL'); }, 2000);
    };
    const cancelled = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timeout'), command.timeoutMs);
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled || reason) return;
      const available = command.maxOutputBytes - captured;
      if (available > 0) { const part = chunk.subarray(0, available); output[stream].push(part); captured += part.length; }
      if (chunk.length > available) stop('output_limit');
    };
    child.stdout!.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr!.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, exitSignal) => finish(code, exitSignal));
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}
