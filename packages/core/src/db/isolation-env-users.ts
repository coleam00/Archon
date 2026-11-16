/**
 * Who still uses an isolation environment besides a claimable run: the SQL that says a
 * run is attached to an environment, shared with getLiveRunOwningEnv, and the starts a
 * run's end handed its checkout that have not been admitted yet.
 */
import {
  resourceStartRequestStatusSchema,
  startBindingPreparationStatusSchema,
} from '@archon/workflows/schemas/resource-start';
import { ISOLATION_ENV_ID_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import type { z } from 'zod';
import { getDatabaseType, getDialect, pool } from './connection';

/**
 * SQL true when run `run` (its conversation joined as `conversation`) is attached to
 * environment `$1`: through its metadata, its creation proof, its conversation, or a
 * same-codebase checkout path. It says nothing about the run's status.
 */
export function runOwnsEnvSql(run: string, conversation: string): string {
  const postgres = getDatabaseType() === 'postgresql';
  const dialect = getDialect();
  // UUID identifiers must compare as text so $1 has one type across metadata,
  // conversation links, and environment associations.
  const conversationEnv = `${conversation}.isolation_env_id${postgres ? '::text' : ''}`;
  return `(${dialect.jsonText(`${run}.metadata`, ISOLATION_ENV_ID_METADATA_KEY)} = $1
    OR ${dialect.jsonText(`${run}.metadata`, 'owned_worktree.envId')} = $1
    OR ${conversationEnv} = $1
    OR EXISTS (SELECT 1 FROM remote_agent_isolation_environments e
      WHERE ${postgres ? 'e.id::text' : 'e.id'} = $1 AND e.codebase_id = ${run}.codebase_id AND e.working_path = ${run}.working_path))`;
}

/** A start handed environment `$1`'s checkout that has not been admitted yet. */
export type WaitingHandoff = {
  receiptId: string;
  bindingId: string;
  /** The run whose estate holds the handed checkout (`checkout_from.runId`). */
  fromRunId: string;
} & (
  | { waitingFor: 'preparation' }
  // Prepared and queued for a resource slot; `archon trigger withdraw` takes `requestId`.
  | { waitingFor: 'capacity'; requestId: string }
);

const PREPARING_BINDING_STATUSES = startBindingPreparationStatusSchema.extract([
  'pending',
  'preparing',
  'failed',
]).options;
const PREPARED_BINDING_STATUS = startBindingPreparationStatusSchema.enum.complete;
const QUEUED_REQUEST_STATUS: z.infer<typeof resourceStartRequestStatusSchema> = 'queued';

/**
 * The oldest start handed the checkout of a run that owns the environment, while that
 * start still waits: its binding is pending, preparing, or failed and retried, or it is
 * prepared and its start request is queued. The protection follows that recorded state,
 * never its age. A rejected or unmatched binding, and a skipped or withdrawn request,
 * stop counting; an admitted request's run counts through getLiveRunOwningEnv instead.
 */
export async function getWaitingHandoffOfEnv(envId: string): Promise<WaitingHandoff | null> {
  const postgres = getDatabaseType() === 'postgresql';
  // checkout_from is TEXT on both dialects; Postgres casts it before reading a key.
  const fromRunId = getDialect().jsonText(
    postgres ? '(b.checkout_from::jsonb)' : 'b.checkout_from',
    'runId'
  );
  const preparing = PREPARING_BINDING_STATUSES.map((_, i) => `$${String(i + 4)}`).join(', ');
  const result = await pool.query<{
    receipt_id: string;
    binding_id: string;
    from_run_id: string;
    request_id: string | null;
  }>(
    `SELECT b.receipt_id, b.binding_id, h.id AS from_run_id, q.id AS request_id
     FROM remote_agent_start_receipt_bindings b
     JOIN remote_agent_workflow_runs h ON ${postgres ? 'h.id::text' : 'h.id'} = ${fromRunId}
     LEFT JOIN remote_agent_conversations hc ON hc.id = h.conversation_id
     LEFT JOIN remote_agent_resource_start_requests q
       ON b.preparation_status = $2 AND q.receipt_id = b.receipt_id
         AND q.binding_id = b.binding_id AND q.status = $3
     WHERE b.checkout_from IS NOT NULL
       AND ${runOwnsEnvSql('h', 'hc')}
       AND (b.preparation_status IN (${preparing}) OR q.id IS NOT NULL)
     ORDER BY b.created_at
     LIMIT 1`,
    [envId, PREPARED_BINDING_STATUS, QUEUED_REQUEST_STATUS, ...PREPARING_BINDING_STATUSES]
  );
  const row = result.rows[0];
  if (!row) return null;
  const start = {
    receiptId: String(row.receipt_id),
    bindingId: row.binding_id,
    fromRunId: String(row.from_run_id),
  };
  return row.request_id === null
    ? { ...start, waitingFor: 'preparation' }
    : { ...start, waitingFor: 'capacity', requestId: String(row.request_id) };
}
