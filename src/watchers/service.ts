import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Job } from '../types.js';
import { WATCH_MAX_ACTIVE, WATCH_MAX_RECORDS, WATCH_MAX_PAYLOAD_BYTES, WATCH_MAX_WAITERS, WATCH_MAX_WAITERS_PER_WATCHER,
  WATCH_DEFAULT_WAIT_MS, watchWaitOptionsSchema, watchCreateSchema, watchSignalSchema, watcherSchema, type Watcher, type WatchCreateResult, type WatchList, type WatchSnapshot, type WatchStatus } from './types.js';
export * from './types.js';

const MAX_STATE_BYTES = 24 * 1024 * 1024;
const principalSchema = z.string().min(1).max(4096);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = watcherSchema.extend({
  principal: principalSchema, tokenHash: hashSchema.optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(), inputHash: hashSchema,
  receipt: z.object({ eventId: z.string().uuid(), bodyHash: hashSchema }).strict().optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), watchers: z.array(recordSchema).max(WATCH_MAX_RECORDS) }).strict();
type State = z.infer<typeof stateSchema>; type Record = State['watchers'][number];
interface Waiter { wake(): void; stop(error: Error): void }
type TerminalListener = (principal: string, watcher: Watcher) => void | Promise<void>;
export interface WatchServiceOptions {
  stateDir: string; secretKey: string;
  getJob(principal: string, id: string): Job | undefined;
  isAuthorized(principal: string): boolean | Promise<boolean>;
  isPaused?(): boolean;
}
export class WatchError extends Error {
  constructor(message: string, readonly code = -32602, readonly data?: { reason: string }) { super(message); }
}
const unavailable = () => new WatchError('Acompanhamento indisponível para esta conexão.', -32000, { reason: 'not_found' });
const denied = () => new WatchError('A conexão não está autorizada para acompanhamentos.', -32000, { reason: 'authorization_required' });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  let parsed; try { parsed = schema.safeParse(input); } catch { throw new WatchError('Parâmetros de acompanhamento inválidos.'); }
  if (!parsed.success) throw new WatchError('Parâmetros de acompanhamento inválidos.'); return parsed.data;
}
function bounded(value: unknown): void {
  try { if (Buffer.byteLength(JSON.stringify(value)) <= WATCH_MAX_PAYLOAD_BYTES) return; } catch { /* Reject non-JSON input. */ }
  throw new WatchError('O resultado de acompanhamento excede 32 KiB ou contém JSON inválido.', -32602, { reason: 'payload_too_large' });
}
function publicWatcher(record: Record, includeResult = true): Watcher { return structuredClone(watcherSchema.parse({ watcherId: record.watcherId, name: record.name, trigger: record.trigger, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt, ...(includeResult && record.result ? { result: record.result } : {}), ...(record.error ? { error: record.error } : {}) })); }
function checkFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('O estado de acompanhamentos precisa ser um arquivo privado, regular e sem links.');
}
async function existingFile(filename: string): Promise<Stats | undefined> {
  try { const info = await lstat(filename); checkFile(info); return info; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function validateState(value: unknown): State {
  try {
    const state = stateSchema.parse(value); const ids = new Set<string>(); const keys = new Set<string>(); let active = 0;
    for (const item of state.watchers) {
      const key = JSON.stringify([item.principal, item.idempotencyKey]);
      if (ids.has(item.watcherId) || (item.idempotencyKey && keys.has(key))) throw new Error();
      if ((item.trigger.type === 'signal') !== Boolean(item.tokenHash)) throw new Error();
      if (item.status === 'waiting') { active++; if (item.result || item.error || item.receipt) throw new Error(); }
      if (item.receipt && (item.trigger.type !== 'signal' || !['succeeded', 'failed', 'needs_input'].includes(item.status) || !item.result)) throw new Error();
      if (['succeeded', 'failed', 'needs_input'].includes(item.status) && !item.result) throw new Error();
      const created = Date.parse(item.createdAt), updated = Date.parse(item.updatedAt), expires = Date.parse(item.expiresAt);
      if (updated < created || expires - created < 1000 || expires - created > 604800000) throw new Error();
      const creation = { name: item.name, trigger: item.trigger, timeoutMs: expires - created, ...(item.idempotencyKey ? { idempotencyKey: item.idempotencyKey } : {}) };
      if (hash(canonical(creation)) !== item.inputHash) throw new Error();
      if (item.result) bounded(item.result);
      ids.add(item.watcherId); if (item.idempotencyKey) keys.add(key);
    }
    if (active > WATCH_MAX_ACTIVE) throw new Error(); return state;
  } catch { throw new Error('O estado de acompanhamentos é inválido ou inconsistente.'); }
}

/** Durable, principal-scoped observations. Cancelling never cancels the external task. */
export class WatchService {
  private chain: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private closed = false;
  private lastError?: string;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly terminalListeners = new Set<TerminalListener>();
  private constructor(private readonly options: WatchServiceOptions, private state: State) {}

  static async open(options: WatchServiceOptions): Promise<WatchService> {
    if (!options.secretKey) throw new Error('Segredo estável da instância obrigatório para acompanhamentos.');
    const stateDir = path.resolve(options.stateDir); await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw new Error('O diretório de estado de acompanhamentos é inseguro.');
    await chmod(stateDir, 0o700);
    const filename = path.join(stateDir, 'watchers.json'); const info = await existingFile(filename); let state: State = { version: 1, watchers: [] };
    if (info) {
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await file.stat(); checkFile(actual);
        if (actual.dev !== info.dev || actual.ino !== info.ino || actual.size > MAX_STATE_BYTES) throw new Error('Arquivo de estado inseguro ou grande demais.');
        await file.chmod(0o600);
        try { state = validateState(JSON.parse(await file.readFile('utf8'))); } catch { throw new Error('Não foi possível abrir o estado válido de acompanhamentos.'); }
      } finally { await file.close(); }
    }
    const service = new WatchService({ ...options, stateDir }, state);
    for (const record of state.watchers) if (record.tokenHash && record.tokenHash !== hash(service.token(record))) throw new Error('O estado de acompanhamentos não corresponde ao segredo da instância.');
    await service.refresh(true); service.schedule(); return service;
  }
  private serialized<T>(action: () => Promise<T> | T): Promise<T> {
    const task = this.chain.then(() => { if (this.closed) throw new WatchError('O serviço de acompanhamentos foi encerrado.', -32000); return action(); });
    this.chain = task.then(() => {}, () => {}); return task;
  }
  private async authorized(principal: string): Promise<boolean> {
    try { return principalSchema.safeParse(principal).success && Boolean(await this.options.isAuthorized(principal)); } catch { return false; }
  }
  private async requireAuthorization(principal: string): Promise<void> { if (!(await this.authorized(principal))) throw denied(); }
  private owned(principal: string, id: string): Record {
    const record = this.state.watchers.find(item => item.watcherId === id && item.principal === principal); if (!record) throw unavailable(); return record;
  }
  private token(record: Record): string { return createHmac('sha256', this.options.secretKey).update(JSON.stringify(['ponte.watch.signal.v1', record.principal, record.watcherId])).digest('base64url'); }
  private created(record: Record): WatchCreateResult { return { ...publicWatcher(record), ...(record.trigger.type === 'signal' ? { signalToken: this.token(record) } : {}) }; }
  private finish(record: Record, status: WatchStatus, error?: string): void { record.status = status; record.updatedAt = new Date().toISOString(); if (error) record.error = error; }
  private job(record: Record, job: Job): void {
    if (record.status !== 'waiting' || !['succeeded', 'failed', 'rejected', 'cancelled', 'expired'].includes(job.status)) return;
    const status = job.status === 'rejected' ? 'failed' : job.status as WatchStatus;
    this.finish(record, status);
    if (status === 'succeeded' || status === 'failed') {
      record.result = { summary: job.error?.slice(0, 2048) || `Job ${job.id}: ${job.status}.` };
      if (job.result) {
        const result = { ...record.result, evidence: { jobResult: job.result } };
        try { bounded(result); record.result = parse(watcherSchema.shape.result.unwrap(), result); } catch { record.result.summary += ' Resultado completo disponível no job.'; }
      }
    } else if (job.error) record.error = job.error.slice(0, 2048);
  }
  private findJob(principal: string, id: string): Job | undefined {
    try { const job = this.options.getJob(principal, id); return job?.id === id ? job : undefined; } catch { return undefined; }
  }
  private async commit(next: State): Promise<void> {
    const body = JSON.stringify(next) + '\n'; if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new WatchError('Armazenamento de acompanhamentos cheio.', -32000, { reason: 'storage_limit' });
    const destination = path.join(this.options.stateDir, 'watchers.json'); const temporary = destination + '.' + randomBytes(12).toString('hex') + '.tmp';
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(body, 'utf8'); await file.sync(); } finally { await file.close(); }
      await existingFile(destination); await rename(temporary, destination);
      // File fsync + atomic rename matches EventService and works on Windows, where directories cannot be opened for fsync.
      const terminal = next.watchers.filter(record => record.status !== 'waiting'
        && this.state.watchers.find(previous => previous.watcherId === record.watcherId)?.status !== record.status);
      this.state = next; this.lastError = undefined;
      for (const record of next.watchers) if (record.status !== 'waiting') for (const waiter of this.waiters.get(record.watcherId) ?? []) waiter.wake();
      // Observers run only after persistence. Never await a listener: Events may call get() to reconcile a subscription.
      for (const record of terminal) for (const listener of this.terminalListeners) {
        try {
          void Promise.resolve(listener(record.principal, publicWatcher(record))).catch(() => { this.lastError = 'Falha ao notificar um observador de acompanhamento.'; });
        } catch { this.lastError = 'Falha ao notificar um observador de acompanhamento.'; }
      }
    } finally { await rm(temporary, { force: true }); }
  }
  onTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => { this.terminalListeners.delete(listener); };
  }
  private async refresh(restarting = false): Promise<void> {
    const changes = new Map<string, Record>(); const grants = new Map<string, boolean>(); const now = Date.now();
    for (const stored of this.state.watchers) {
      if (stored.status !== 'waiting') continue;
      const record = structuredClone(stored);
      if (!grants.has(record.principal)) grants.set(record.principal, await this.authorized(record.principal));
      if (!grants.get(record.principal)) this.finish(record, 'cancelled', 'Autorização revogada.');
      else if (Date.parse(record.expiresAt) <= now) this.finish(record, 'expired', 'Prazo do acompanhamento encerrado.');
      else if (record.trigger.type === 'job') {
        const job = this.findJob(record.principal, record.trigger.jobId);
        if (job) this.job(record, job); else if (restarting) this.finish(record, 'interrupted', 'Job indisponível após reinício da Ponte.');
      }
      if (record.status !== 'waiting') changes.set(record.watcherId, record);
    }
    if (changes.size) await this.commit({ version: 1, watchers: this.state.watchers.map(record => changes.get(record.watcherId) ?? record) });
  }
  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.serialized(() => this.refresh()).catch(() => { this.lastError = 'Falha ao atualizar o estado dos acompanhamentos.'; }).finally(() => this.schedule());
    }, 250); this.timer.unref();
  }
  async create(principal: string, input: unknown): Promise<WatchCreateResult> {
    bounded(input); const value = parse(watchCreateSchema, input); const inputHash = hash(canonical(value));
    return this.serialized(async () => {
      await this.refresh(); await this.requireAuthorization(principal);
      const existing = value.idempotencyKey ? this.state.watchers.find(item => item.principal === principal && item.idempotencyKey === value.idempotencyKey) : undefined;
      if (existing) {
        if (existing.inputHash !== inputHash) throw new WatchError('Chave de idempotência já usada com outros argumentos.', -32000, { reason: 'conflict' });
        return this.created(existing);
      }
      if (this.options.isPaused?.()) throw new WatchError('Execuções pausadas no painel local.', -32000, { reason: 'paused' });
      if (this.state.watchers.filter(item => item.status === 'waiting').length >= WATCH_MAX_ACTIVE) throw new WatchError('Limite de acompanhamentos ativos atingido.', -32000, { reason: 'watcher_limit' });
      const job = value.trigger.type === 'job' ? this.findJob(principal, value.trigger.jobId) : undefined;
      if (value.trigger.type === 'job' && !job) throw unavailable();
      const now = Date.now(); const record: Record = { watcherId: randomUUID(), principal, name: value.name, trigger: value.trigger, status: 'waiting', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + value.timeoutMs).toISOString(), inputHash, ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {}) };
      if (value.trigger.type === 'signal') record.tokenHash = hash(this.token(record));
      if (job) this.job(record, job);
      const next = structuredClone(this.state);
      // Capacity retention: evict the oldest terminal record only; pending watches are never pruned.
      if (next.watchers.length >= WATCH_MAX_RECORDS) {
        const oldest = next.watchers.filter(item => item.status !== 'waiting').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
        if (!oldest) throw new WatchError('Armazenamento de acompanhamentos cheio.', -32000, { reason: 'storage_limit' });
        next.watchers = next.watchers.filter(item => item.watcherId !== oldest.watcherId);
      }
      next.watchers.push(record); await this.commit(next); await this.requireAuthorization(principal); return this.created(record);
    });
  }
  async get(principal: string, id: string): Promise<Watcher> {
    return this.serialized(async () => { await this.refresh(); await this.requireAuthorization(principal); return publicWatcher(this.owned(principal, id)); });
  }
  async list(principal: string, input: unknown = {}): Promise<WatchList> {
    const params = parse(z.object({ offset: z.number().int().min(0).max(WATCH_MAX_RECORDS).default(0), limit: z.number().int().min(1).max(WATCH_MAX_RECORDS).default(50) }).strict(), input);
    return this.serialized(async () => { await this.refresh(); await this.requireAuthorization(principal); const own = this.state.watchers.filter(item => item.principal === principal).reverse(); return { watchers: own.slice(params.offset, params.offset + params.limit).map(record => publicWatcher(record)), total: own.length, ...params }; });
  }
  async cancel(principal: string, id: string): Promise<Watcher> {
    return this.serialized(async () => { await this.refresh(); await this.requireAuthorization(principal); this.owned(principal, id); return this.cancelOne(id); });
  }
  private async cancelOne(id: string): Promise<Watcher> {
    const next = structuredClone(this.state); const record = next.watchers.find(item => item.watcherId === id); if (!record) throw unavailable();
    if (record.status === 'waiting') { this.finish(record, 'cancelled', 'Acompanhamento cancelado; o trabalho externo não foi alterado.'); await this.commit(next); }
    return publicWatcher(record);
  }
  async adminGet(id: string): Promise<Watcher> { return this.serialized(async () => { await this.refresh(); const record = this.state.watchers.find(item => item.watcherId === id); if (!record) throw unavailable(); return publicWatcher(record); }); }
  async adminCancel(id: string): Promise<Watcher> { return this.serialized(async () => { await this.refresh(); return this.cancelOne(id); }); }
  private async requireSignal(id: string, token: string): Promise<Record> {
    const record = this.state.watchers.find(item => item.watcherId === id);
    if (!record?.tokenHash || typeof token !== 'string' || token.length > 1024 || !timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) throw unavailable();
    await this.refresh(); await this.requireAuthorization(record.principal);
    return this.state.watchers.find(item => item.watcherId === id)!;
  }
  async authenticateSignal(id: string, token: string): Promise<void> {
    await this.serialized(async () => { await this.requireSignal(id, token); });
  }
  async signal(id: string, token: string, input: unknown): Promise<Watcher> {
    return this.serialized(async () => {
      const current = await this.requireSignal(id, token);
      bounded(input); const value = parse(watchSignalSchema, input);
      if (current.trigger.type !== 'signal' || current.trigger.runId !== value.runId) throw new WatchError('Correlação de acompanhamento inválida.', -32602);
      const bodyHash = hash(canonical(value));
      if (current.receipt?.eventId === value.eventId && current.receipt.bodyHash === bodyHash) return publicWatcher(current);
      if (current.status !== 'waiting') throw new WatchError('O acompanhamento já foi concluído.', -32000, { reason: 'conflict' });
      const next = structuredClone(this.state); const target = next.watchers.find(item => item.watcherId === id)!;
      this.finish(target, value.status); target.result = { summary: value.summary, ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}), ...(value.evidence ? { evidence: value.evidence } : {}) }; target.receipt = { eventId: value.eventId, bodyHash };
      await this.commit(next); await this.requireAuthorization(target.principal); return publicWatcher(target);
    });
  }
  // Trusted terminal listener: ownership was established at creation; JobManager may prune before this queue runs.
  async recordJob(job: Job): Promise<void> {
    await this.serialized(async () => {
      await this.refresh(); const next = structuredClone(this.state); let changed = false;
      for (const record of next.watchers) if (record.status === 'waiting' && record.trigger.type === 'job' && record.trigger.jobId === job.id) {
        this.job(record, job); if (record.status !== 'waiting') changed = true;
      }
      if (changed) await this.commit(next);
    });
  }
  async wait(principal: string, id: string, waitMs = WATCH_DEFAULT_WAIT_MS, signal?: AbortSignal): Promise<Watcher> {
    parse(watchWaitOptionsSchema, { waitMs });
    let resolve!: (value: Watcher) => void; let reject!: (error: Error) => void;
    const waiting = new Promise<Watcher>((yes, no) => { resolve = yes; reject = no; });
    // Attach a rejection handler before queued registration; an early abort must not be unhandled.
    void waiting.catch(() => {});
    await this.serialized(async () => {
      await this.refresh(); await this.requireAuthorization(principal);
      // close() may run while either authorization check is awaiting. Do not register a waiter after its cleanup.
      if (this.closed) throw new WatchError('O serviço de acompanhamentos foi encerrado.', -32000);
      const record = this.owned(principal, id);
      if (signal?.aborted) throw new WatchError('Espera interrompida.', -32000, { reason: 'aborted' });
      if (record.status !== 'waiting' || waitMs === 0) { resolve(publicWatcher(record)); return; }
      const group = this.waiters.get(id) ?? new Set<Waiter>();
      if (group.size >= WATCH_MAX_WAITERS_PER_WATCHER || this.waiterCount() >= WATCH_MAX_WAITERS) throw new WatchError('Limite de aguardadores atingido.', -32000, { reason: 'waiter_limit' });
      let done = false; let waking = false; let timeout: ReturnType<typeof setTimeout>;
      const cleanup = () => { if (done) return; done = true; clearTimeout(timeout); signal?.removeEventListener('abort', aborted); group.delete(waiter); if (!group.size) this.waiters.delete(id); };
      const waiter: Waiter = {
        wake: () => { if (done || waking) return; waking = true; void this.get(principal, id).then(value => { if (!done) { cleanup(); resolve(value); } }, error => { if (!done) { cleanup(); reject(error); } }); },
        stop: error => { if (!done) { cleanup(); reject(error); } },
      };
      const aborted = () => waiter.stop(new WatchError('Espera interrompida.', -32000, { reason: 'aborted' }));
      group.add(waiter); this.waiters.set(id, group); timeout = setTimeout(waiter.wake, waitMs); signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    return waiting;
  }
  private waiterCount(): number { let count = 0; for (const group of this.waiters.values()) count += group.size; return count; }
  snapshot(): WatchSnapshot {
    const stats: WatchSnapshot['stats'] = { waiting: 0, succeeded: 0, failed: 0, needs_input: 0, cancelled: 0, expired: 0, interrupted: 0 };
    for (const item of this.state.watchers) stats[item.status]++;
    return { watchers: [...this.state.watchers].reverse().map(record => publicWatcher(record, false)), stats, activeWaiters: this.waiterCount(), limits: { active: WATCH_MAX_ACTIVE, records: WATCH_MAX_RECORDS, waiters: WATCH_MAX_WAITERS, waitersPerWatcher: WATCH_MAX_WAITERS_PER_WATCHER }, ...(this.lastError ? { error: this.lastError } : {}) };
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearTimeout(this.timer);
    for (const group of this.waiters.values()) for (const waiter of [...group]) waiter.stop(new WatchError('Serviço de acompanhamentos encerrado.', -32000));
    this.closing = this.chain; await this.closing;
    this.terminalListeners.clear();
  }
}
