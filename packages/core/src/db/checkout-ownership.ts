import type { IWorkflowStore } from '@archon/workflows/store';
import {
  CheckoutReleasedError,
  introducesCheckout,
  checkoutEnvironmentReferences,
} from '@archon/workflows/schemas/checkout-ownership';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
export { introducesCheckout };
import { getDatabaseType } from './connection';
import type { TransactionQuery } from './resource-slots';
import { normalizeMetadata } from './workflow-run-shared';

/** Take before row locks: resource admission and local checkout retirement share this exclusion. */
export async function lockCheckoutOwnership(query: TransactionQuery): Promise<void> {
  if (getDatabaseType() === 'postgresql') await query('SELECT pg_advisory_xact_lock(1797)');
  // Even an empty write reserves SQLite's writer before any snapshot reads.
  else await query('UPDATE remote_agent_isolation_environments SET status = status WHERE 1 = 0');
}

type CheckoutRun = Pick<
  WorkflowRun,
  'codebase_id' | 'working_path' | 'metadata' | 'conversation_id'
>;

export async function releasedCheckout(
  query: TransactionQuery,
  run: CheckoutRun
): Promise<string | undefined> {
  const [environmentId, ownedId] = checkoutEnvironmentReferences(run.metadata);
  const result = await query<{ working_path: string }>(
    `SELECT e.working_path FROM remote_agent_isolation_environments e
      WHERE e.provider = 'worktree'
        AND ((e.codebase_id = $1 AND e.working_path = $2)
          OR CAST(e.id AS TEXT) = $3 OR CAST(e.id AS TEXT) = $4
          OR e.id = (SELECT isolation_env_id FROM remote_agent_conversations WHERE id = $5))
        AND NOT EXISTS (
          SELECT 1 FROM remote_agent_isolation_environments active
          WHERE active.provider = 'worktree' AND active.status = 'active'
            AND active.codebase_id = e.codebase_id AND active.working_path = e.working_path
        ) LIMIT 1`,
    [
      run.codebase_id,
      run.working_path,
      typeof environmentId === 'string' ? environmentId : null,
      typeof ownedId === 'string' ? ownedId : null,
      run.working_path || typeof environmentId === 'string' || typeof ownedId === 'string'
        ? null
        : run.conversation_id,
    ]
  );
  return result.rows[0]?.working_path;
}

export async function assertCheckoutAvailable(
  query: TransactionQuery,
  run: CheckoutRun
): Promise<void> {
  const path = await releasedCheckout(query, run);
  if (path !== undefined) throw new CheckoutReleasedError(path);
}

export async function assertNewRunCheckoutAvailable(
  query: TransactionQuery,
  data: Parameters<IWorkflowStore['createWorkflowRun']>[0]
): Promise<void> {
  await assertCheckoutAvailable(query, {
    codebase_id: data.codebase_id ?? null,
    working_path: data.working_path ?? null,
    metadata: data.metadata ?? {},
    conversation_id: data.origin?.conversationId ?? null,
  });
}

export async function readRunCheckout(query: TransactionQuery, id: string) {
  const result = await query<
    Omit<CheckoutRun, 'metadata'> & { status: WorkflowRun['status']; metadata: unknown }
  >(
    'SELECT codebase_id, working_path, metadata, conversation_id, status FROM remote_agent_workflow_runs WHERE id = $1',
    [id]
  );
  const run = result.rows[0];
  return run && { ...run, metadata: normalizeMetadata(run.metadata) };
}

export async function assertRunCheckoutAvailable(
  query: TransactionQuery,
  id: string
): Promise<void> {
  const run = await readRunCheckout(query, id);
  if (run) await assertCheckoutAvailable(query, run);
}

export function associatesCheckout(metadata: Record<string, unknown> | undefined): boolean {
  return introducesCheckout(undefined, { working_path: null, metadata: metadata ?? {} });
}
