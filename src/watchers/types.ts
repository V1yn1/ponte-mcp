import { z } from 'zod';

export const WATCH_RUN_ID_PATTERN = '^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?=[\\s\\S]*\\S)[\\s\\S]+$';
export const watchRunIdSchema = z.string().min(1).max(128).regex(new RegExp(WATCH_RUN_ID_PATTERN));

export const WATCH_MAX_PAYLOAD_BYTES = 32 * 1024;
export const WATCH_MAX_ACTIVE = 100;
export const WATCH_MAX_RECORDS = 500;
export const WATCH_MAX_WAITERS = 200;
export const WATCH_MAX_WAITERS_PER_WATCHER = 20;
export const watchStatusSchema = z.enum(['waiting', 'succeeded', 'failed', 'needs_input', 'cancelled', 'expired', 'interrupted']);
export const watchTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('signal'), source: z.string().min(1).max(128), runId: watchRunIdSchema }).strict(),
  z.object({ type: z.literal('job'), jobId: z.string().uuid() }).strict(),
]);
export const watchCreateSchema = z.object({
  name: z.string().min(1).max(160), trigger: watchTriggerSchema,
  timeoutMs: z.number().int().min(1000).max(604800000).default(3600000),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
}).strict();
// JSON values only: callers cannot persist functions, non-finite numbers or class instances.
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return Object.values(value).every(item => jsonValue(item, depth + 1));
  return false;
}
const evidenceSchema = z.record(z.unknown()).refine(value => jsonValue(value), 'Evidência JSON inválida.');
export const watchResultSchema = z.object({ summary: z.string().min(1).max(WATCH_MAX_PAYLOAD_BYTES), exitCode: z.number().int().safe().optional(), evidence: evidenceSchema.optional() }).strict();
export const watchSignalSchema = watchResultSchema.extend({ eventId: z.string().uuid(), runId: watchRunIdSchema, status: z.enum(['succeeded', 'failed', 'needs_input']) }).strict();
export const watcherSchema = z.object({
  watcherId: z.string().uuid(), name: z.string().min(1).max(160), trigger: watchTriggerSchema, status: watchStatusSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  result: watchResultSchema.optional(), error: z.string().max(2048).optional(),
}).strict();
export type WatchCreateInput = z.input<typeof watchCreateSchema>;
export type WatchSignalInput = z.infer<typeof watchSignalSchema>;
export type Watcher = z.infer<typeof watcherSchema>;
export type WatchStatus = Watcher['status'];
export type WatchCreateResult = Watcher & { signalToken?: string };
export interface WatchList { watchers: Watcher[]; total: number; offset: number; limit: number }
export interface WatchSnapshot {
  watchers: Watcher[]; stats: Record<WatchStatus, number>; activeWaiters: number;
  limits: { active: number; records: number; waiters: number; waitersPerWatcher: number };
  error?: string;
}
