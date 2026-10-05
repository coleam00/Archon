import { workflowRunOriginSchema, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { WORKFLOW_ORIGIN_ANCHOR_ID } from './workflow-origin-anchor';

import {
  checkoutObservationSchema,
  type CheckoutObservation,
} from '@archon/workflows/schemas/checkout-observation';
import { createLogger } from '@archon/paths';
import { toHydratedTimestamp } from './timestamps';

// Select origin as text: PostgreSQL otherwise decodes JSONB null and SQL NULL identically.
export type WorkflowRunSqlRow = Omit<WorkflowRun, 'origin'> & { origin?: unknown };

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
export function normalizeWorkflowRun<T extends WorkflowRunSqlRow>(
  row: T
): Omit<T, 'origin'> & WorkflowRun {
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
  const origin = readWorkflowRunOrigin(row);
  return {
    ...row,
    origin,
    conversation_id: origin?.conversationId ?? null,
    parent_conversation_id: origin?.parentConversationId ?? null,
    user_id: origin?.userId ?? null,
  };
}

export function readWorkflowRunOrigin(
  row: Pick<WorkflowRunSqlRow, 'origin' | 'conversation_id' | 'parent_conversation_id' | 'user_id'>
): WorkflowRun['origin'] {
  const rawOrigin = row.origin;
  const origin = workflowRunOriginSchema.parse(
    rawOrigin === null || rawOrigin === undefined
      ? {
          ...(row.conversation_id && row.conversation_id !== WORKFLOW_ORIGIN_ANCHOR_ID
            ? { conversationId: row.conversation_id }
            : {}),
          ...(row.parent_conversation_id
            ? { parentConversationId: row.parent_conversation_id }
            : {}),
          ...(row.user_id ? { userId: row.user_id } : {}),
        }
      : typeof rawOrigin === 'string'
        ? JSON.parse(rawOrigin)
        : rawOrigin
  );
  if (
    origin.conversationId === WORKFLOW_ORIGIN_ANCHOR_ID ||
    origin.parentConversationId === WORKFLOW_ORIGIN_ANCHOR_ID
  ) {
    throw new Error('Workflow origin references the reserved compatibility anchor');
  }
  return Object.keys(origin).length === 0 ? null : origin;
}

/**
 * SQLite stores the baseline as JSON text and PostgreSQL as JSONB. A value this build
 * cannot parse (corrupt, or written by a newer shape) reads as not recorded and is logged,
 * rather than reaching readers as an untyped object.
 */
function readCheckoutBaseline(row: WorkflowRunSqlRow): CheckoutObservation | null {
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
