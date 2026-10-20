import type { IDatabase } from './adapters/types';
import { getDatabaseType, getDialect } from './connection';

/** Lock registrations before the run row, matching cleanup and pending claims. */
export async function lockRunCheckout(query: IDatabase['query'], id: string): Promise<void> {
  if (getDatabaseType() === 'sqlite') {
    // Reserve the writer before reading so a concurrent cleanup cannot invalidate the snapshot.
    await query('UPDATE remote_agent_workflow_runs SET id = id WHERE id = $1', [id]);
  }
  const dialect = getDialect();
  const envId = getDatabaseType() === 'postgresql' ? 'e.id::text' : 'e.id';
  const result = await query<{ working_path: string; status: string }>(
    `SELECT e.working_path, e.status FROM remote_agent_isolation_environments e
     WHERE e.provider = 'worktree' AND EXISTS (
       SELECT 1 FROM remote_agent_workflow_runs r
       LEFT JOIN remote_agent_conversations c ON c.id = r.conversation_id
       WHERE r.id = $1 AND (
         (e.codebase_id = r.codebase_id AND e.working_path = r.working_path)
         OR ${envId} = ${dialect.jsonText('r.metadata', 'isolation_env_id')}
         OR ${envId} = ${dialect.jsonText('r.metadata', 'owned_worktree.envId')}
         OR e.id = c.isolation_env_id
       )
     ) ORDER BY e.id${dialect.rowLock()}`,
    [id]
  );
  // Retired history must not block a checkout that has an active replacement registration.
  const paths = new Map<string, boolean>();
  for (const row of result.rows) {
    paths.set(row.working_path, paths.get(row.working_path) === true || row.status === 'active');
  }
  if ([...paths.values()].some(active => !active)) {
    throw new Error(`Workflow run checkout is no longer active (id: ${id})`);
  }
}
