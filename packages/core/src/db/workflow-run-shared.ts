/**
 * Internals shared by the workflow-run database modules. Siblings import these
 * directly; the `./workflows` entry does not re-export them.
 */
import { createLogger } from '@archon/paths';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { getDatabaseType, getDialect } from './connection';
import type { TransactionQuery } from './resource-slots';
import { parseJsonObject } from './workflow-run-normalization';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflows');
  return cachedLog;
}

export function normalizeMetadata(raw: unknown): Record<string, unknown> {
  return parseJsonObject(raw) ?? {};
}

/**
 * Read one run row for a read-merge-write of its metadata. SQLite takes its write
 * lock before the read, so the merge acts on the row it read.
 */
export async function lockedRunRow(
  query: TransactionQuery,
  id: string
): Promise<{ status: WorkflowRunStatus; metadata: unknown } | undefined> {
  if (getDatabaseType() === 'sqlite') {
    await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [id]);
  }
  const result = await query<{ status: WorkflowRunStatus; metadata: unknown }>(
    `SELECT status, metadata FROM remote_agent_workflow_runs WHERE id = $1${getDialect().rowLock()}`,
    [id]
  );
  return result.rows[0];
}

/** SQL fragment reading an integer from a JSON column at a dotted key path. */
export function jsonIntExtract(col: string, path: string): string {
  return `CAST(${getDialect().jsonText(col, path)} AS INTEGER)`;
}
