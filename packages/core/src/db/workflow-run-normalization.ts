import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createLogger } from '@archon/paths';
import { toHydratedTimestamp } from './timestamps';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('db.workflow-run-normalization');
  return cachedLog;
}

/**
 * Normalize a WorkflowRun row from the database.
 * SQLite stores metadata as TEXT (JSON string) and timestamps as TEXT datetimes;
 * PostgreSQL returns parsed objects and real Dates. Hydrate those representations
 * without rewriting stored values: malformed metadata text reads as {}, while null
 * remains null. Timestamp hydration prevents raw SQLite strings reaching Date readers
 * such as resolveWorkflowAdoption (#2845).
 */
export function normalizeWorkflowRun<T extends WorkflowRun>(row: T): T {
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch (error) {
      // SyntaxError messages can quote metadata contents; record only the class.
      getLog().warn(
        { workflowRunId: row.id, errorType: error instanceof Error ? error.name : typeof error },
        'db.workflow_run_metadata_parse_failed'
      );
      row.metadata = {};
    }
  }
  if (typeof row.started_at === 'string') row.started_at = toHydratedTimestamp(row.started_at);
  if (typeof row.completed_at === 'string')
    row.completed_at = toHydratedTimestamp(row.completed_at);
  if (typeof row.last_activity_at === 'string')
    row.last_activity_at = toHydratedTimestamp(row.last_activity_at);
  return row;
}
