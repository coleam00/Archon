/**
 * Read-only queries for the console's Software Factory section. A module of its own, outside
 * the `./workflows` entry, so the many tests that mock that entry need not know about it.
 */
import { createLogger } from '@archon/paths';
import { pool } from './connection';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.factory');
  return cachedLog;
}

/**
 * Which of `names` this codebase has at least one run of, in any status. A caller asks about
 * the handful of workflows a factory view names, well below the bound-parameter limits.
 */
export async function listRunWorkflowNames(
  codebaseId: string,
  names: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];
  const placeholders = unique.map((_, index) => `$${String(index + 2)}`).join(', ');
  try {
    const result = await pool.query<{ workflow_name: string }>(
      `SELECT DISTINCT workflow_name FROM remote_agent_workflow_runs WHERE codebase_id = $1 AND workflow_name IN (${placeholders})`,
      [codebaseId, ...unique]
    );
    return result.rows.map(row => row.workflow_name);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_names_list_failed');
    throw new Error(`Failed to list run workflow names: ${err.message}`);
  }
}
