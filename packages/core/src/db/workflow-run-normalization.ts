import { workflowRunOriginSchema, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { WORKFLOW_ORIGIN_ANCHOR_ID } from './workflow-origin-anchor';

import {
  checkoutObservationSchema,
  type CheckoutObservation,
} from '@archon/workflows/schemas/checkout-observation';
import { createLogger } from '@archon/paths';
import { toHydratedTimestamp } from './timestamps';

/** Columns whose database value differs from the public `WorkflowRun` value. */
type RawRunColumn =
  | 'origin'
  | 'metadata'
  | 'started_at'
  | 'completed_at'
  | 'last_activity_at'
  | 'checkout_baseline';

/**
 * A workflow-run row as either dialect returns it, before `normalizeWorkflowRun`.
 * SQLite stores JSON as text and timestamps as text datetimes; PostgreSQL returns
 * parsed JSONB and Dates. Queries select `CAST(origin AS TEXT) AS origin` because
 * PostgreSQL otherwise decodes JSONB null and SQL NULL identically. The conversation
 * columns are physical and may hold the reserved compatibility anchor.
 */
export type WorkflowRunRow = Omit<WorkflowRun, RawRunColumn> & {
  origin: unknown;
  metadata: string | Record<string, unknown> | null;
  started_at: string | Date;
  completed_at: string | Date | null;
  last_activity_at: string | Date | null;
  checkout_baseline: unknown;
};

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('db.workflow-run-normalization');
  return cachedLog;
}

/**
 * Normalize a workflow-run row from the database into a public `WorkflowRun`, keeping
 * any extra projected columns, without rewriting stored values. Metadata that is not a
 * JSON object (malformed text, JSON null or SQL NULL) reads as {}. Timestamp hydration
 * prevents raw SQLite strings reaching Date readers such as resolveWorkflowAdoption (#2845). The public conversation columns are projected from
 * the origin, so the compatibility anchor never leaves this module.
 */
export function normalizeWorkflowRun<T extends WorkflowRunRow>(
  row: T
): Omit<T, RawRunColumn | 'conversation_id' | 'parent_conversation_id' | 'user_id'> & WorkflowRun {
  const origin = readWorkflowRunOrigin(row);
  return {
    ...row,
    metadata: readMetadata(row),
    checkout_baseline: readCheckoutBaseline(row),
    started_at: toHydratedTimestamp(row.started_at),
    completed_at: row.completed_at === null ? null : toHydratedTimestamp(row.completed_at),
    last_activity_at:
      row.last_activity_at === null ? null : toHydratedTimestamp(row.last_activity_at),
    origin,
    conversation_id: origin?.conversationId ?? null,
    parent_conversation_id: origin?.parentConversationId ?? null,
    user_id: origin?.userId ?? null,
  };
}

function readMetadata(row: WorkflowRunRow): Record<string, unknown> {
  let value: unknown = row.metadata;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      // SyntaxError messages can quote metadata contents; record only the class.
      getLog().warn(
        { workflowRunId: row.id, errorType: error instanceof Error ? error.name : typeof error },
        'db.workflow_run_metadata_parse_failed'
      );
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readWorkflowRunOrigin(
  row: Pick<WorkflowRunRow, 'origin' | 'conversation_id' | 'parent_conversation_id' | 'user_id'>
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
function readCheckoutBaseline(row: WorkflowRunRow): CheckoutObservation | null {
  const raw = row.checkout_baseline;
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
