import { canonicalJson } from '@helium/core';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface ControlConnection {
  host: string; port: number; database: string;
  user: 'runtime_control_admin' | 'runtime_control_runner';
  password?: string; psqlPath?: string;
}
export interface RuntimeScope { tenant: string; phase: string; kind: string; environment: 'test' }
export interface RuntimeSnapshot {
  scope: RuntimeScope; configVersionId: string; configHash: string;
  deploymentRevision: number; configurationApprovalId: string;
  resolvedPayload: unknown; resolvedAt: string;
  metadata: Record<string, unknown>; effectiveSnapshotHash: string;
}
export interface VersionRequest { scope: RuntimeScope; id: string; payload: unknown; parentId?: string }
export interface ChangeRequest {
  scope: RuntimeScope; versionId: string; expectedRevision: number;
  operationId: string; approval: string;
}
export interface StartRequest { attemptId: string; snapshot: RuntimeSnapshot; metadata: Record<string, unknown> }
export interface FinalizeRequest {
  attemptId: string; status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; evidence: Record<string, unknown>;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** No inherited PG*, service files, shell, or credentials in command arguments. */
export class RuntimeControl {
  constructor(private readonly connection: ControlConnection) {
    if (!connection || typeof connection.host !== 'string' || !connection.host.startsWith('/') || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
      || typeof connection.database !== 'string' || !/^[a-zA-Z0-9_]+$/.test(connection.database)
      || (connection.password !== undefined && typeof connection.password !== 'string')
      || (connection.psqlPath !== undefined && typeof connection.psqlPath !== 'string')
      || !['runtime_control_admin', 'runtime_control_runner'].includes(connection.user)) {
      throw new Error('Runtime control requires an explicit local test socket/database and restricted role');
    }
  }

  private async request(action: string, input: unknown): Promise<any> {
    const request = canonicalJson({ action, input });
    const c = this.connection;
    return new Promise((resolve, reject) => {
      const child = spawn(c.psqlPath ?? 'psql', ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', `request=${request}`], {
        env: { PATH: process.env.PATH, PGHOST: c.host, PGPORT: String(c.port), PGDATABASE: c.database,
          PGUSER: c.user, PGPASSWORD: c.password ?? '', PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null',
          PGCONNECT_TIMEOUT: '5', PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=5000' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Runtime control database process unavailable')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          const reason = stderr.match(/RC_[A-Z_]+/)?.[0] ?? 'DATABASE_UNAVAILABLE';
          reject(new Error(`Runtime control rejected: ${reason}`));
        } else {
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Runtime control invalid database response')); }
        }
      });
      child.stdin.on('error', () => {});
      // psql's quoted variable syntax escapes data; never splice request into SQL.
      child.stdin.end("SELECT runtime_control.request(:'request'::jsonb);\n");
    });
  }

  async createVersion(input: VersionRequest): Promise<{ id: string; hash: string }> {
    return this.request('version', { ...input, canonicalPayload: canonicalJson(input.payload) });
  }
  initialize(input: ChangeRequest): Promise<{ revision: number; versionId: string }> { return this.request('initialize', input); }
  activate(input: ChangeRequest): Promise<{ revision: number; versionId: string }> { return this.request('activate', input); }
  rollback(input: ChangeRequest): Promise<{ revision: number; versionId: string }> { return this.request('rollback', input); }

  async resolve(scope: RuntimeScope, metadata: Record<string, unknown> = {}): Promise<RuntimeSnapshot> {
    const result = await this.request('resolve', { scope });
    if (contentHash(result.resolvedPayload) !== result.configHash) throw new Error('Runtime control version integrity failure');
    const snapshot = { ...result, metadata };
    return JSON.parse(canonicalJson({ ...snapshot, effectiveSnapshotHash: contentHash(snapshot) }));
  }
  async startAttempt(input: StartRequest): Promise<{ attemptId: string; status: string }> {
    const { effectiveSnapshotHash, ...snapshot } = input.snapshot;
    if (contentHash(snapshot) !== effectiveSnapshotHash) throw new Error('Runtime control snapshot integrity failure');
    return this.request('start', { ...input, canonicalSnapshot: canonicalJson(snapshot) });
  }
  finalizeAttempt(input: FinalizeRequest): Promise<{ attemptId: string; status: string }> { return this.request('finalize', input); }
  inspectAttempt(attemptId: string): Promise<Record<string, unknown>> { return this.request('inspect', { attemptId }); }
}
