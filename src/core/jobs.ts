import { createHash, randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import type { AuditLog } from './audit.js';
import type { Job, ToolDefinition, AppConfig } from '../types.js';

const TERMINAL = new Set(['succeeded', 'failed', 'rejected', 'cancelled', 'expired']);
const APPROVAL_TTL = 15 * 60 * 1000;
const MAX_JOBS = 200;
const MAX_RESULT = 4 * 1024 * 1024;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ':' + stableJson(val)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function signature(definition: ToolDefinition): string {
  return createHash('sha256').update(stableJson({ tool: definition.tool, risk: definition.risk, source: definition.source, fingerprint: definition.fingerprint })).digest('hex');
}

interface InternalJob { job: Job; signature: string; controller?: AbortController; }
export class JobManager {
  private readonly records = new Map<string, InternalJob>();
  private readonly keys = new Map<string, { digest: string; id: string }>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly validationOptions = { strict: false, allErrors: false, validateFormats: false, ownProperties: true, addUsedSchema: false };
  private readonly ajv = new Ajv2020(this.validationOptions);
  private readonly legacyAjv = new Ajv(this.validationOptions);
  private readonly ajv2019 = new Ajv2019(this.validationOptions);
  private submissionChain = Promise.resolve();
  private running = 0;
  private closed = false;
  paused = false;

  constructor(private readonly getTools: () => ToolDefinition[], private readonly approvalMode: () => AppConfig['approvalMode'], private readonly audit?: AuditLog) {}

  async submit(name: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<Job> {
    let result!: Job;
    const task = this.submissionChain.then(async () => { result = await this.submitOne(name, args, idempotencyKey); });
    this.submissionChain = task.catch(() => {});
    await task;
    return result;
  }

  private async submitOne(name: string, args: Record<string, unknown>, key?: string): Promise<Job> {
    if (this.closed) throw new Error('O serviço está encerrando.');
    if (key !== undefined && (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))) throw new Error('Chave de idempotência inválida.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments precisa ser um objeto JSON.');
    if (Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) throw new Error('Argumentos excedem 1 MiB.');
    const digest = createHash('sha256').update(stableJson({ name, args })).digest('hex');
    if (key && this.keys.has(key)) {
      const prior = this.keys.get(key)!;
      if (prior.digest !== digest) throw new Error('Chave de idempotência já usada com outros argumentos.');
      return this.get(prior.id);
    }
    if (this.paused) throw new Error('Execuções pausadas no painel local.');
    this.expire(); this.prune();
    if (this.records.size >= MAX_JOBS) throw new Error('Fila cheia. Conclua ou cancele trabalhos pendentes.');
    const definition = this.getTools().find(item => item.tool.name === name);
    if (!definition) throw new Error('Ferramenta indisponível. Atualize o catálogo.');
    const toolSignature = signature(definition);
    let validate = this.validators.get(toolSignature);
    if (!validate) {
      try {
        const dialect = definition.tool.inputSchema.$schema;
        const engine = typeof dialect === 'string' && /draft-07/.test(dialect) ? this.legacyAjv
          : typeof dialect === 'string' && /draft\/2019-09/.test(dialect) ? this.ajv2019 : this.ajv;
        validate = engine.compile(definition.tool.inputSchema);
      }
      catch { throw new Error('Schema da ferramenta incompatível com a validação local.'); }
      this.validators.set(toolSignature, validate);
      if (this.validators.size > 1000) this.validators.delete(this.validators.keys().next().value!);
    }
    const frozen = structuredClone(args);
    if (!validate(frozen)) throw new Error('Argumentos inválidos: ' + this.ajv.errorsText(validate.errors, { dataVar: 'arguments' }));
    const preview = definition.preview ? await definition.preview(structuredClone(frozen)) : undefined;
    if (this.closed || this.paused) throw new Error('Execuções pausadas ou serviço encerrando.');
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(), tool: name, source: definition.source, risk: definition.risk,
      status: this.approvalMode() === 'all' || definition.risk !== 'read' ? 'pending_approval' : 'queued',
      createdAt: now, updatedAt: now, arguments: frozen, ...(preview !== undefined ? { preview } : {}),
    };
    this.records.set(job.id, { job, signature: toolSignature });
    if (key) this.keys.set(key, { digest, id: job.id });
    this.audit?.record(job);
    this.drain();
    return structuredClone(job);
  }

  get(id: string): Job {
    this.expire();
    return structuredClone(this.require(id).job);
  }
  list(limit = 50): Job[] {
    this.expire();
    return [...this.records.values()].map(item => item.job).slice(-Math.min(limit, MAX_JOBS)).reverse().map(job => structuredClone(job));
  }
  approve(id: string): Job {
    if (this.paused || this.closed) throw new Error('Execuções pausadas ou serviço encerrando.');
    this.expire();
    const record = this.require(id);
    if (record.job.status !== 'pending_approval') throw new Error('Este trabalho não está aguardando aprovação.');
    const current = this.getTools().find(item => item.tool.name === record.job.tool);
    if (!current || signature(current) !== record.signature) {
      this.change(record, 'rejected', 'A ferramenta ou sua configuração foi alterada. Envie uma nova solicitação.');
      throw new Error('A ferramenta foi alterada desde a solicitação.');
    }
    this.change(record, 'queued'); this.drain();
    return structuredClone(record.job);
  }
  reject(id: string): Job {
    const record = this.require(id);
    if (record.job.status !== 'pending_approval') throw new Error('Só é possível recusar um trabalho pendente.');
    this.change(record, 'rejected', 'Solicitação recusada no painel local.');
    return structuredClone(record.job);
  }
  cancel(id: string): Job {
    const record = this.require(id);
    if (TERMINAL.has(record.job.status)) return structuredClone(record.job);
    this.change(record, 'cancelled', 'Cancelamento solicitado. Em ferramentas externas, confirme o estado antes de reenviar.');
    record.controller?.abort(new Error('Cancelado pelo usuário.'));
    return structuredClone(record.job);
  }
  setPaused(paused: boolean): void { this.paused = paused; if (!paused) this.drain(); }
  close(): void { this.closed = true; for (const record of this.records.values()) if (!TERMINAL.has(record.job.status)) this.cancel(record.job.id); }

  private require(id: string): InternalJob {
    const record = this.records.get(id);
    if (!record) throw new Error('Trabalho não encontrado ou removido da memória. Consulte a auditoria para seu histórico.');
    return record;
  }
  private change(record: InternalJob, status: Job['status'], error?: string): void {
    record.job.status = status; record.job.updatedAt = new Date().toISOString();
    if (error) record.job.error = error;
    this.audit?.record(record.job);
  }
  private expire(): void {
    for (const record of this.records.values()) {
      if (record.job.status === 'pending_approval' && Date.now() - Date.parse(record.job.createdAt) > APPROVAL_TTL) this.change(record, 'expired', 'A aprovação expirou após 15 minutos. Envie uma nova solicitação.');
    }
  }
  private prune(): void {
    let bytes = 0;
    for (const { job } of this.records.values()) bytes += Buffer.byteLength(JSON.stringify(job));
    for (const [id, record] of this.records) {
      if (this.records.size < MAX_JOBS && bytes <= 64 * 1024 * 1024) break;
      if (!TERMINAL.has(record.job.status)) continue;
      bytes -= Buffer.byteLength(JSON.stringify(record.job));
      this.records.delete(id);
      for (const [key, value] of this.keys) if (value.id === id) this.keys.delete(key);
    }
  }
  private drain(): void {
    if (this.paused || this.closed) return;
    for (const record of this.records.values()) {
      if (this.running >= 4) break;
      if (record.job.status !== 'queued') continue;
      this.running++;
      this.change(record, 'running');
      void this.run(record).finally(() => { this.running--; this.drain(); });
    }
  }
  private async run(record: InternalJob): Promise<void> {
    const controller = new AbortController(); record.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = this.getTools().find(item => item.tool.name === record.job.tool);
      if (!current || signature(current) !== record.signature) throw new Error('A ferramenta ou sua configuração mudou antes da execução.');
      const abort = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('Execução interrompida.')), { once: true });
      });
      timeout = setTimeout(() => controller.abort(new Error('Tempo limite de 120 segundos. A ação externa pode ter continuado; verifique o estado antes de reenviar.')), 120000);
      const result = await Promise.race([current.execute(structuredClone(record.job.arguments), { signal: controller.signal }), abort]);
      if (record.job.status !== 'running') return;
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT) throw new Error('A resposta excedeu 4 MiB. A ação pode ter sido concluída; consulte seu estado e reduza o resultado.');
      record.job.result = result;
      this.change(record, result.isError ? 'failed' : 'succeeded', result.isError ? 'A ferramenta retornou um erro. Consulte o resultado.' : undefined);
    } catch (error) {
      if (record.job.status === 'running') this.change(record, 'failed', error instanceof Error ? error.message : 'Falha na execução.');
    } finally { if (timeout) clearTimeout(timeout); delete record.controller; }
  }
}
