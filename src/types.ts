import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type Risk = 'read' | 'write' | 'execute';
export interface ProjectConfig {
  id: string;
  name: string;
  root: string;
  allowWrite: boolean;
  allowExec: boolean;
}
export interface UpstreamConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  readOnlyTools?: string[];
  allowedTools?: string[];
  timeoutMs?: number;
}
export interface AppConfig {
  version: 1;
  port: number;
  apiPort: number;
  publicUrl?: string;
  approvalMode: 'mutations' | 'all' | 'automatic';
  mcpToolExposure?: 'full' | 'compact';
  projects: ProjectConfig[];
  upstreams: UpstreamConfig[];
}
export interface Secrets { adminToken: string; apiToken: string }
export interface ToolContext { signal: AbortSignal; principal?: string }
export interface ToolDefinition {
  tool: Tool;
  risk: Risk;
  source: string;
  fingerprint?: string;
  preview?: (args: Record<string, unknown>) => Promise<unknown>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<CallToolResult>;
}
export interface UpstreamStatus {
  id: string;
  name: string;
  transport: string;
  status: 'disabled' | 'connecting' | 'connected' | 'error';
  toolCount: number;
  error?: string;
}
export type JobStatus = 'pending_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'expired';
export interface Job {
  id: string;
  tool: string;
  source: string;
  risk: Risk;
  status: JobStatus;
  approval?: 'automatic' | 'manual';
  createdAt: string;
  updatedAt: string;
  arguments: Record<string, unknown>;
  preview?: unknown;
  result?: CallToolResult;
  error?: string;
}
export const textResult = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
