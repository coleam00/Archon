import {
  admissionNoticeCursor,
  admissionNoticeFactsSchema,
  validateAdmissionNoticeLimit,
  type AdmissionNoticeCursor,
  type AdmissionNoticePage,
} from '@archon/workflows/admission-notice';
import { WorkflowEventCursorError } from '@archon/workflows/store';
import { preparedWorkflowLaunchSchema } from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';

function position(cursor: AdmissionNoticeCursor): string {
  const match = /^sql-admission:(0|[1-9][0-9]*)$/.exec(cursor);
  if (!match?.[1]) throw new WorkflowEventCursorError();
  return match[1];
}

export async function getAdmissionNoticeHead(): Promise<AdmissionNoticeCursor> {
  const result = await getDatabase().query<{ position: string }>(
    'SELECT CAST(COALESCE(MAX(queue_position), 0) AS TEXT) AS position FROM remote_agent_resource_start_requests'
  );
  return admissionNoticeCursor(`sql-admission:${result.rows[0].position}`);
}

function storedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function readAdmissionNoticesAfter(
  after: AdmissionNoticeCursor | null,
  { limit }: { limit: number }
): Promise<AdmissionNoticePage> {
  validateAdmissionNoticeLimit(limit);
  const lower = after === null ? '0' : position(after);
  const head = await getAdmissionNoticeHead();
  const upper = position(head);
  if (BigInt(lower) > BigInt(upper)) throw new WorkflowEventCursorError();
  // Admission serializes writers before allocating queue_position. A committed maximum
  // therefore cannot skip an earlier, still-uncommitted request.
  const result = await getDatabase().query<{
    position: string;
    id: string;
    receipt_id: string;
    binding_id: string;
    resource_key: string;
    overlap_policy: string;
    blocker_kind: string | null;
    blocker_run_id: string;
    launch: unknown;
    delivery_id: string;
    received_at: string | Date;
    source_actor: unknown;
  }>(
    `SELECT CAST(r.queue_position AS TEXT) AS position, r.id, r.receipt_id, r.binding_id,
            r.resource_key, r.overlap_policy, r.blocker_kind, r.blocker_run_id, r.launch,
            s.delivery_id, s.received_at, s.source_actor
       FROM remote_agent_resource_start_requests r
       JOIN remote_agent_start_receipts s ON s.id = r.receipt_id
      WHERE r.queue_position > $1 AND r.queue_position <= $2
        AND r.status = 'skipped' AND s.delivery_id IS NOT NULL
      ORDER BY r.queue_position LIMIT $3`,
    [lower, upper, limit + 1]
  );
  const caughtUp = result.rows.length <= limit;
  const notices = result.rows.slice(0, limit).map(row => {
    const launch = preparedWorkflowLaunchSchema.parse(storedJson(row.launch));
    return {
      cursor: admissionNoticeCursor(`sql-admission:${row.position}`),
      facts: admissionNoticeFactsSchema.parse({
        requestId: row.id,
        receiptId: row.receipt_id,
        bindingId: row.binding_id,
        resource: row.resource_key,
        overlap: row.overlap_policy,
        blocker: { kind: row.blocker_kind ?? 'run', id: row.blocker_run_id },
        deliveryId: row.delivery_id,
        receivedAt:
          row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
        sourceActor: storedJson(row.source_actor),
        codebaseId: launch.run.codebase_id,
        cwd: launch.execution.cwd,
      }),
    };
  });
  return { notices, next: caughtUp ? head : notices[notices.length - 1].cursor, caughtUp };
}
