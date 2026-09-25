import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  checkoutObservationSchema,
  type CheckoutObservation,
} from '@archon/workflows/schemas/checkout-observation';
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
  row.checkout_baseline = readCheckoutBaseline(row);
  if (typeof row.started_at === 'string') row.started_at = toHydratedTimestamp(row.started_at);
  if (typeof row.completed_at === 'string')
    row.completed_at = toHydratedTimestamp(row.completed_at);
  if (typeof row.last_activity_at === 'string')
    row.last_activity_at = toHydratedTimestamp(row.last_activity_at);
  return row;
}

/**
 * SQLite stores the baseline as JSON text and PostgreSQL as JSONB. A value this build
 * cannot parse (corrupt, or written by a newer shape) reads as not recorded and is logged,
 * rather than reaching readers as an untyped object.
 */
function readCheckoutBaseline(row: WorkflowRun): CheckoutObservation | null {
  const raw: unknown = row.checkout_baseline;
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  const parsed = checkoutObservationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  getLog().warn({ workflowRunId: row.id }, 'db.workflow_run_checkout_baseline_unreadable');
  return null;
}
