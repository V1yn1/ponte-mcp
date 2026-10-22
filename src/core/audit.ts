import { mkdir, appendFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from '../types.js';

export class AuditLog {
  private chain = Promise.resolve();
  private lastError?: string;
  constructor(private readonly directory: string) {}

  record(job: Job): void {
    const entry = { at: job.updatedAt, jobId: job.id, tool: job.tool, source: job.source, risk: job.risk, status: job.status };
    this.chain = this.chain.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = path.join(this.directory, 'audit.jsonl');
      const size = await stat(filename).then(value => value.size).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return 0;
      });
      if (size > 5 * 1024 * 1024) {
        await rm(filename + '.1', { force: true });
        await rename(filename, filename + '.1');
      }
      await appendFile(filename, JSON.stringify(entry) + '\n', { mode: 0o600 });
      this.lastError = undefined;
    }).catch(() => { this.lastError = 'Não foi possível gravar a auditoria local.'; });
  }
  get error(): string | undefined { return this.lastError; }
  async flush(): Promise<void> { await this.chain; }
}
