import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Job } from '../types.js';
import { decodeWebhookSecret, postWebhook, validateCallbackUrl, verifyCallback, webhookHeaders, type WebhookPost } from './webhook.js';

const EVENT_NAME = 'ponte.job.completed';
const MAX_SUBSCRIPTIONS = 100;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const JOB_RESERVATION_BYTES = MAX_RESULT_BYTES + 256 * 1024;
const MAX_TTL_MS = 24 * 3600_000;
const VERIFY_CACHE_MS = 10 * 60_000;
const KEY_OVERLAP_MS = 5 * 60_000;
const MAX_ATTEMPTS = 6;
const TERMINAL = new Set<Job['status']>(['succeeded', 'failed', 'rejected', 'cancelled', 'expired']);
const terminalStatus = z.enum(['succeeded', 'failed', 'rejected', 'cancelled', 'expired']);
const timestamp = z.string().datetime({ offset: true });
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const principalSchema = z.string().min(1).max(4096);
const argumentsSchema = z.object({ jobId: z.string().uuid() }).strict();
const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().min(1).max(4096), secret: z.string().min(1).max(128) }).strict();
const subscribeSchema = z.object({
  name: z.literal(EVENT_NAME), arguments: argumentsSchema, delivery: deliverySchema,
  cursor: z.union([z.string().max(4096), z.null()]).optional(), ttlMs: integer.nullable().optional(), maxAgeMs: integer.optional(),
}).strict();
const unsubscribeSchema = z.object({ name: z.literal(EVENT_NAME), arguments: argumentsSchema, delivery: deliverySchema.omit({ secret: true }) }).strict();
const jobSchema = z.object({
  id: z.string().uuid(), tool: z.string().min(1).max(256), source: z.string().min(1).max(4096),
  risk: z.enum(['read', 'write', 'execute']), status: z.enum(['pending_approval', 'queued', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired']),
  approval: z.enum(['automatic', 'manual']).optional(), createdAt: timestamp, updatedAt: timestamp,
  arguments: z.object({}).strict(), result: z.record(z.unknown()).optional(), error: z.string().max(32768).optional(),
}).strict();
const eventSchema = z.object({
  eventId: z.string().uuid(), name: z.literal(EVENT_NAME), timestamp, cursor: z.null(),
  data: z.object({ jobId: z.string().uuid(), tool: z.string().min(1).max(256), status: terminalStatus, createdAt: timestamp, updatedAt: timestamp }).strict(),
}).strict();
const attemptSchema = z.object({
  event: eventSchema, status: z.enum(['queued', 'retrying', 'delivered', 'failed']), attempts: integer.max(MAX_ATTEMPTS),
  nextAttemptAt: integer, lastAttemptAt: integer.optional(), deliveredAt: integer.optional(), lastError: z.string().max(256).optional(),
}).strict();
const subscriptionSchema = z.object({
  id: z.string().regex(/^sub_[a-f0-9]{64}$/), principal: principalSchema, name: z.literal(EVENT_NAME), arguments: argumentsSchema,
  url: z.string().min(1).max(4096), secret: z.string().min(1).max(128),
  previousSecret: z.object({ secret: z.string().min(1).max(128), until: integer }).strict().optional(),
  createdAt: integer, expiresAt: integer, delivery: attemptSchema.optional(),
}).strict();
const archiveSchema = z.object({ principal: principalSchema, expiresAt: integer, job: jobSchema }).strict();
const stateSchema = z.object({ version: z.literal(1), subscriptions: z.array(subscriptionSchema).max(MAX_SUBSCRIPTIONS), archives: z.array(archiveSchema).max(1000) }).strict();
type State = z.infer<typeof stateSchema>;
type Subscription = State['subscriptions'][number];
type Archive = State['archives'][number];

export interface EventServiceOptions {
  stateDir: string;
  getJob: (principal: string, jobId: string) => Job;
  isAuthorized: (principal: string) => boolean | Promise<boolean>;
  post?: WebhookPost;
  now?: () => number;
}
export interface EventSnapshot {
  enabled: true; subscriptionCount: number; pendingDeliveries: number; delivered: number; failed: number;
  subscriptions: Array<{ id: string; event: string; jobId: string; createdAt: string; refreshBefore: string;
    status: 'waiting' | 'queued' | 'retrying' | 'delivered' | 'failed'; attempts: number;
    lastAttemptAt?: string; deliveredAt?: string; lastError?: string }>;
  error?: string;
}

class EventError extends Error {
  constructor(message: string, readonly code = -32602, readonly data?: Record<string, unknown>) { super(message); }
}
function parameters<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new EventError('Parâmetros de Events inválidos.');
  return parsed.data;
}
const iso = (value: number) => new Date(value).toISOString();
const archiveKey = (principal: string, jobId: string) => JSON.stringify([principal, jobId]);
const identity = (principal: string, url: string, jobId: string) => JSON.stringify([principal, url, EVENT_NAME, jobId]);
const subscriptionId = (canonicalIdentity: string) => 'sub_' + createHash('sha256').update(canonicalIdentity).digest('hex');

function checkOwnedFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('O estado de Events precisa ser um arquivo privado, regular e sem links.');
  }
}
async function existingFile(filename: string): Promise<Stats | undefined> {
  try { const info = await lstat(filename); checkOwnedFile(info); return info; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function validateState(input: unknown): State {
  let state: State;
  try { state = stateSchema.parse(input); }
  catch { throw new Error('O estado de Events é inválido.'); }
  const ids = new Set<string>(); const identities = new Set<string>(); const archives = new Map<string, Archive>();
  for (const archive of state.archives) {
    const key = archiveKey(archive.principal, archive.job.id);
    if (archives.has(key) || Buffer.byteLength(JSON.stringify(archive.job.result ?? {})) > MAX_RESULT_BYTES) throw new Error('O estado de Events é inconsistente.');
    archives.set(key, archive);
  }
  for (const subscription of state.subscriptions) {
    const key = identity(subscription.principal, subscription.url, subscription.arguments.jobId);
    const archive = archives.get(archiveKey(subscription.principal, subscription.arguments.jobId));
    if (subscription.id !== subscriptionId(key) || ids.has(subscription.id) || identities.has(key) || !archive || archive.expiresAt < subscription.expiresAt
      || (subscription.delivery && subscription.delivery.event.data.jobId !== subscription.arguments.jobId)) throw new Error('O estado de Events é inconsistente.');
    try {
      validateCallbackUrl(subscription.url); decodeWebhookSecret(subscription.secret);
      if (subscription.previousSecret) decodeWebhookSecret(subscription.previousSecret.secret);
    } catch { throw new Error('O estado de Events contém um callback inválido.'); }
    ids.add(subscription.id); identities.add(key);
  }
  return state;
}
function storedJob(job: Job): Archive['job'] {
  if (job.result && Buffer.byteLength(JSON.stringify(job.result)) > MAX_RESULT_BYTES) throw new EventError('O resultado excede o limite de arquivo de Events.', -32000);
  return jobSchema.parse({
    id: job.id, tool: job.tool, source: job.source, risk: job.risk, status: job.status,
    ...(job.approval ? { approval: job.approval } : {}), createdAt: job.createdAt, updatedAt: job.updatedAt, arguments: {},
    ...(job.result ? { result: structuredClone(job.result) } : {}), ...(job.error ? { error: job.error.slice(0, 32768) } : {}),
  });
}

/** Durable watches and delivery receipts; executable job requests are never replayed. */
export class EventService {
  private chain: Promise<void> = Promise.resolve();
  private pumping?: Promise<void>;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private subscribing = false;
  private lastError?: string;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly verified = new Map<string, number>();
  private readonly now: () => number;
  private readonly post: WebhookPost;

  private constructor(private readonly options: EventServiceOptions, private state: State) {
    this.now = options.now ?? Date.now; this.post = options.post ?? postWebhook;
  }
  static async open(options: EventServiceOptions): Promise<EventService> {
    const stateDir = path.resolve(options.stateDir);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) throw new Error('O diretório de estado de Events é inseguro.');
    await chmod(stateDir, 0o700);
    const filename = path.join(stateDir, 'events.json');
    const info = await existingFile(filename);
    let state: State = { version: 1, subscriptions: [], archives: [] };
    if (info) {
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await file.stat(); checkOwnedFile(opened);
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_STATE_BYTES) throw new Error('O arquivo de estado de Events é inseguro ou excede o limite.');
        await file.chmod(0o600);
        try { state = validateState(JSON.parse(await file.readFile('utf8'))); }
        catch { throw new Error('Não foi possível abrir o estado válido de Events.'); }
      } finally { await file.close(); }
    }
    const service = new EventService({ ...options, stateDir }, state);
    const restored = structuredClone(state);
    service.prune(restored);
    for (const archive of restored.archives) {
      if (TERMINAL.has(archive.job.status)) continue;
      let current: Job | undefined;
      try { current = options.getJob(archive.principal, archive.job.id); } catch { /* Jobs are intentionally volatile. */ }
      archive.job = current ? storedJob(current) : { ...archive.job, status: 'cancelled', updatedAt: iso(service.now()),
        error: 'Execução interrompida pelo reinício da Ponte. Efeitos externos podem ter ocorrido; a operação não será reenviada automaticamente.' };
      service.enqueueTerminal(restored, archive);
    }
    await service.commit(restored);
    service.schedule();
    return service;
  }

  private serialized<T>(action: () => Promise<T> | T): Promise<T> {
    const task = this.chain.then(action); this.chain = task.then(() => {}, () => {}); return task;
  }
  private async authorized(principal: string): Promise<boolean> {
    try { return Boolean(await this.options.isAuthorized(principal)); } catch { return false; }
  }
  private async requireAuthorization(principal: string): Promise<void> {
    if (!principalSchema.safeParse(principal).success || this.closed || !(await this.authorized(principal))) throw new EventError('A conexão não está autorizada para Events.', -32000, { reason: 'authorization_required' });
  }
  private findJob(principal: string, id: string): Job {
    try { const job = this.options.getJob(principal, id); if (job.id === id) return job; } catch { /* Try the same owner's durable archive. */ }
    const archived = this.getArchivedJob(principal, id);
    if (archived) return archived;
    throw new EventError('Trabalho indisponível para esta conexão.');
  }
  private prune(state: State): void {
    const current = this.now();
    state.subscriptions = state.subscriptions.filter(subscription => subscription.expiresAt > current);
    state.archives = state.archives.filter(archive => archive.expiresAt > current);
    for (const subscription of state.subscriptions) if (subscription.previousSecret && subscription.previousSecret.until <= current) delete subscription.previousSecret;
  }
  private async commit(next: State): Promise<void> {
    const body = JSON.stringify(next) + '\n';
    // Reserve room for a maximum-size eventual result before accepting a watch.
    const reservation = next.archives.filter(archive => !TERMINAL.has(archive.job.status)).length * JOB_RESERVATION_BYTES
      + next.subscriptions.filter(subscription => !subscription.delivery).length * 4096;
    if (next.archives.length > 1000 || Buffer.byteLength(body) + reservation > MAX_STATE_BYTES) throw new EventError('O armazenamento de Events está cheio. Encerre assinaturas ou aguarde a expiração dos resultados.', -32000, { reason: 'storage_limit' });
    const destination = path.join(this.options.stateDir, 'events.json');
    const temporary = destination + '.' + randomBytes(12).toString('hex') + '.tmp';
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(body, 'utf8'); await file.sync(); } finally { await file.close(); }
      await existingFile(destination); await rename(temporary, destination); this.state = next; this.lastError = undefined;
    } finally { await rm(temporary, { force: true }); }
    this.schedule();
  }
  private enqueueTerminal(state: State, archive: Archive): void {
    if (!TERMINAL.has(archive.job.status)) return;
    for (const subscription of state.subscriptions) {
      if (subscription.principal !== archive.principal || subscription.arguments.jobId !== archive.job.id || subscription.delivery) continue;
      const job = archive.job;
      subscription.delivery = { attempts: 0, status: 'queued', nextAttemptAt: this.now(), event: {
        eventId: randomUUID(), name: EVENT_NAME, timestamp: job.updatedAt, cursor: null,
        data: { jobId: job.id, tool: job.tool, status: terminalStatus.parse(job.status), createdAt: job.createdAt, updatedAt: job.updatedAt },
      } };
    }
  }

  async list(principal: string, params: unknown): Promise<unknown> {
    await this.requireAuthorization(principal);
    const input = parameters(z.object({ cursor: z.string().optional() }).strict(), params);
    if (input.cursor !== undefined) throw new EventError('Cursor de catálogo inválido.');
    return { events: [{
      name: EVENT_NAME, description: 'Avisa quando um trabalho específico termina, falha, é recusado, cancelado ou expira. Após receber o evento, consulte bridge_job com o jobId para obter o resultado e continuar o pedido do usuário sem reenviar a operação.',
      delivery: ['webhook'],
      inputSchema: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid', description: 'ID retornado pela execução da ferramenta nesta conexão.' } }, required: ['jobId'], additionalProperties: false },
      payloadSchema: { type: 'object', properties: { jobId: { type: 'string', format: 'uuid' }, tool: { type: 'string' },
        status: { type: 'string', enum: [...TERMINAL] }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } },
        required: ['jobId', 'tool', 'status', 'createdAt', 'updatedAt'], additionalProperties: false },
    }] };
  }

  async subscribe(principal: string, params: unknown): Promise<{ id: string; refreshBefore: string; cursor: null; truncated: false }> {
    const input = parameters(subscribeSchema, params);
    if (input.cursor !== undefined && input.cursor !== null) throw new EventError('Esta Ponte não oferece reprodução histórica de eventos.', -32026, { feature: 'replay' });
    validateCallbackUrl(input.delivery.url); decodeWebhookSecret(input.delivery.secret);
    // Admit at most one subscribe before joining the shared state queue. A slow
    // callback can delay state work once, but cannot build an unbounded backlog.
    if (this.subscribing) throw new EventError('Uma assinatura de Events já está sendo preparada. Tente novamente em instantes.', -32025, { reason: 'subscription_busy' });
    this.subscribing = true;
    return this.serialized(async () => {
      await this.requireAuthorization(principal);
      this.findJob(principal, input.arguments.jobId);
      let next = structuredClone(this.state); this.prune(next);
      const key = identity(principal, input.delivery.url, input.arguments.jobId);
      const existing = next.subscriptions.find(item => identity(item.principal, item.url, item.arguments.jobId) === key);
      if (!existing && next.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new EventError('Limite de 100 assinaturas de Events atingido.', -32000, { reason: 'subscription_limit' });
      const id = subscriptionId(key);
      const cacheKey = createHash('sha256').update(JSON.stringify([principal, input.delivery.url, input.delivery.secret])).digest('hex');
      const verifiedAt = this.verified.get(cacheKey);
      if (verifiedAt === undefined || verifiedAt + VERIFY_CACHE_MS <= this.now()) {
        const controller = this.track(id);
        try { await verifyCallback({ url: input.delivery.url, secret: input.delivery.secret, subscriptionId: id }, this.post, controller.signal); }
        finally { this.untrack(id, controller); }
        this.verified.set(cacheKey, this.now());
        for (const [cached, at] of this.verified) if (at + VERIFY_CACHE_MS <= this.now()) this.verified.delete(cached);
        while (this.verified.size > 200) this.verified.delete(this.verified.keys().next().value!);
      }
      await this.requireAuthorization(principal);
      const job = this.findJob(principal, input.arguments.jobId); // Re-read after the challenge to close the completion race.
      const current = this.now(); const expiresAt = current + Math.min(MAX_TTL_MS, Math.max(1, input.ttlMs ?? MAX_TTL_MS));
      // No state mutation can interleave with this serialized verification.
      next = structuredClone(this.state); this.prune(next);
      let subscription = next.subscriptions.find(item => item.id === id);
      if (!subscription) {
        subscription = { id, principal, name: EVENT_NAME, arguments: input.arguments, url: input.delivery.url,
          secret: input.delivery.secret, createdAt: current, expiresAt };
        next.subscriptions.push(subscription);
      } else {
        if (subscription.secret !== input.delivery.secret) subscription.previousSecret = { secret: subscription.secret, until: current + KEY_OVERLAP_MS };
        subscription.secret = input.delivery.secret; subscription.expiresAt = expiresAt;
      }
      let archive = next.archives.find(item => item.principal === principal && item.job.id === job.id);
      if (!archive) { archive = { principal, expiresAt, job: storedJob(job) }; next.archives.push(archive); }
      else { archive.expiresAt = Math.max(archive.expiresAt, expiresAt); archive.job = storedJob(job); }
      this.enqueueTerminal(next, archive);
      await this.commit(next);
      return { id: subscription.id, refreshBefore: iso(expiresAt), cursor: null, truncated: false as const };
    }).finally(() => { this.subscribing = false; });
  }

  async unsubscribe(principal: string, params: unknown): Promise<Record<string, never>> {
    const input = parameters(unsubscribeSchema, params); validateCallbackUrl(input.delivery.url);
    await this.requireAuthorization(principal);
    const key = identity(principal, input.delivery.url, input.arguments.jobId);
    const found = this.state.subscriptions.find(item => identity(item.principal, item.url, item.arguments.jobId) === key);
    if (found) for (const controller of this.controllers.get(found.id) ?? []) controller.abort(new Error('Assinatura encerrada.'));
    // Resolve identity inside the queue as well: an initial subscribe may still
    // be verifying its callback and must not activate after unsubscribe returns.
    await this.serialized(async () => {
      const matching = this.state.subscriptions.find(item => identity(item.principal, item.url, item.arguments.jobId) === key);
      if (!matching) return;
      for (const controller of this.controllers.get(matching.id) ?? []) controller.abort(new Error('Assinatura encerrada.'));
      const next = structuredClone(this.state); next.subscriptions = next.subscriptions.filter(item => item.id !== matching.id);
      await this.commit(next);
    });
    return {};
  }
  async cancel(id: string): Promise<boolean> {
    for (const controller of this.controllers.get(id) ?? []) controller.abort(new Error('Assinatura encerrada.'));
    return this.serialized(async () => {
      if (!this.state.subscriptions.some(item => item.id === id)) return false;
      const next = structuredClone(this.state); next.subscriptions = next.subscriptions.filter(item => item.id !== id);
      await this.commit(next); return true;
    });
  }
  async record(job: Job): Promise<void> {
    if (this.closed || !TERMINAL.has(job.status)) return;
    try {
      await this.serialized(async () => {
        const relevant = this.state.archives.some(archive => archive.job.id === job.id && archive.expiresAt > this.now());
        if (!relevant) return;
        const next = structuredClone(this.state); this.prune(next);
        for (const archive of next.archives) {
          if (archive.job.id !== job.id) continue;
          archive.job = storedJob(job); this.enqueueTerminal(next, archive);
        }
        await this.commit(next);
      });
    } catch (error) { this.lastError = 'Não foi possível guardar a conclusão para Events. O resultado da execução não foi alterado.'; throw error; }
  }
  getArchivedJob(principal: string, jobId: string): Job | undefined {
    const archive = this.state.archives.find(item => item.principal === principal && item.job.id === jobId && item.expiresAt > this.now());
    return archive ? structuredClone(archive.job) as Job : undefined;
  }
  snapshot(): EventSnapshot {
    const subscriptions = this.state.subscriptions.filter(item => item.expiresAt > this.now());
    return { enabled: true, subscriptionCount: subscriptions.length,
      pendingDeliveries: subscriptions.filter(item => item.delivery && ['queued', 'retrying'].includes(item.delivery.status)).length,
      delivered: subscriptions.filter(item => item.delivery?.status === 'delivered').length,
      failed: subscriptions.filter(item => item.delivery?.status === 'failed').length,
      subscriptions: subscriptions.map(item => ({ id: item.id, event: item.name, jobId: item.arguments.jobId, createdAt: iso(item.createdAt), refreshBefore: iso(item.expiresAt),
        status: item.delivery?.status ?? 'waiting', attempts: item.delivery?.attempts ?? 0,
        ...(item.delivery?.lastAttemptAt !== undefined ? { lastAttemptAt: iso(item.delivery.lastAttemptAt) } : {}),
        ...(item.delivery?.deliveredAt !== undefined ? { deliveredAt: iso(item.delivery.deliveredAt) } : {}),
        ...(item.delivery?.lastError ? { lastError: item.delivery.lastError } : {}),
      })), ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private track(id: string): AbortController {
    const controller = new AbortController();
    const controllers = this.controllers.get(id) ?? new Set<AbortController>(); controllers.add(controller); this.controllers.set(id, controllers);
    return controller;
  }
  private untrack(id: string, controller: AbortController): void {
    const controllers = this.controllers.get(id); controllers?.delete(controller); if (!controllers?.size) this.controllers.delete(id);
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.pumping || (!this.state.subscriptions.length && !this.state.archives.length)) return;
    const current = this.now(); let delay = 60_000;
    for (const subscription of this.state.subscriptions) {
      delay = Math.min(delay, subscription.expiresAt - current);
      if (!subscription.delivery) delay = Math.min(delay, 1000);
      else if (['queued', 'retrying'].includes(subscription.delivery.status)) delay = Math.min(delay, subscription.delivery.nextAttemptAt - current);
    }
    for (const archive of this.state.archives) {
      delay = Math.min(delay, archive.expiresAt - current);
      if (!TERMINAL.has(archive.job.status)) delay = Math.min(delay, 1000);
    }
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump().catch(() => {}); }, Math.max(1, delay));
    this.timer.unref();
  }
  pump(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = this.performPump().catch(error => { this.lastError = 'Não foi possível atualizar as entregas de Events.'; throw error; })
      .finally(() => { this.pumping = undefined; this.schedule(); });
    return this.pumping;
  }
  private async performPump(): Promise<void> {
    const prepared = await this.serialized(async () => {
      if (this.closed) return [] as Array<{ id: string; eventId: string }>;
      let next: State | undefined;
      const edit = () => next ??= structuredClone(this.state);
      const current = this.now();
      if (this.state.subscriptions.some(item => item.expiresAt <= current || (item.previousSecret && item.previousSecret.until <= current))
        || this.state.archives.some(item => item.expiresAt <= current)) this.prune(edit());
      const invalid = new Set<string>();
      for (const principal of new Set((next ?? this.state).subscriptions.map(item => item.principal))) if (!(await this.authorized(principal))) invalid.add(principal);
      if (invalid.size) {
        const changed = edit();
        for (const subscription of changed.subscriptions) if (invalid.has(subscription.principal)) for (const controller of this.controllers.get(subscription.id) ?? []) controller.abort();
        changed.subscriptions = changed.subscriptions.filter(item => !invalid.has(item.principal));
        changed.archives = changed.archives.filter(item => !invalid.has(item.principal));
      }
      // Calling getJob also advances the existing approval-expiration mechanism.
      for (const archive of (next ?? this.state).archives) {
        if (TERMINAL.has(archive.job.status)) continue;
        let latest: Job | undefined;
        try { latest = this.options.getJob(archive.principal, archive.job.id); } catch { /* Preserve the explicit startup interruption policy. */ }
        if (!latest || !TERMINAL.has(latest.status)) continue;
        const changed = edit(); const target = changed.archives.find(item => item.principal === archive.principal && item.job.id === archive.job.id)!;
        target.job = storedJob(latest); this.enqueueTerminal(changed, target);
      }
      const ready: Array<{ id: string; eventId: string }> = [];
      for (const subscription of (next ?? this.state).subscriptions) {
        const delivery = subscription.delivery;
        if (!delivery || !['queued', 'retrying'].includes(delivery.status) || delivery.nextAttemptAt > current) continue;
        const target = edit().subscriptions.find(item => item.id === subscription.id)!.delivery!;
        if (target.attempts >= MAX_ATTEMPTS) { target.status = 'failed'; target.lastError = 'O limite de tentativas de entrega foi atingido.'; continue; }
        target.attempts++; target.status = 'retrying'; target.lastAttemptAt = current;
        target.nextAttemptAt = current + Math.min(60_000, 1000 * 2 ** (target.attempts - 1));
        ready.push({ id: subscription.id, eventId: target.event.eventId });
        if (ready.length >= 4) break;
      }
      if (next) await this.commit(next); // Persist attempt identity before making the outbound request.
      return ready;
    });
    await Promise.all(prepared.map(item => this.deliver(item.id, item.eventId)));
  }
  private async deliver(id: string, eventId: string): Promise<void> {
    let subscription = this.state.subscriptions.find(item => item.id === id);
    if (!subscription || this.closed || !(await this.authorized(subscription.principal))) return;
    subscription = this.state.subscriptions.find(item => item.id === id);
    if (!subscription || subscription.expiresAt <= this.now() || subscription.delivery?.event.eventId !== eventId || this.closed) return;
    const body = JSON.stringify(subscription.delivery.event);
    const secrets = [subscription.secret, ...(subscription.previousSecret && subscription.previousSecret.until > this.now() ? [subscription.previousSecret.secret] : [])];
    const headers = webhookHeaders(id, eventId, body, secrets, this.now());
    const controller = this.track(id);
    let status: number | undefined;
    try { status = (await this.post(subscription.url, body, headers, controller.signal)).status; }
    catch { /* Network errors may contain callback secrets; never expose their messages. */ }
    finally { this.untrack(id, controller); }
    await this.serialized(async () => {
      const current = this.state.subscriptions.find(item => item.id === id);
      if (!current || current.delivery?.event.eventId !== eventId) return;
      const next = structuredClone(this.state); const delivery = next.subscriptions.find(item => item.id === id)!.delivery!;
      if (status !== undefined && status >= 200 && status < 300) {
        delivery.status = 'delivered'; delivery.deliveredAt = this.now(); delete delivery.lastError;
      } else {
        delivery.status = status === 410 || status === 413 || delivery.attempts >= MAX_ATTEMPTS ? 'failed' : 'retrying';
        delivery.lastError = status === undefined ? 'Falha de conexão ao entregar o evento.' : `O destino recusou a entrega (HTTP ${status}).`;
      }
      await this.commit(next);
    });
  }
  async flush(): Promise<void> { await this.chain; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const controllers of this.controllers.values()) for (const controller of controllers) controller.abort(new Error('Events está encerrando.'));
    this.closing = (async () => { await this.pumping?.catch(() => {}); await this.chain; })();
    return this.closing;
  }
}
