/**
 * Who still uses an isolation environment: a run that can still claim it, or a start a
 * run's end handed its checkout that has not been admitted yet. Cleanup reads both in
 * one statement (getEnvUse), because ownership moves between them in single
 * transactions: a run's completion records its hand-off, and admission turns a queued
 * request into a pending run. Two separate reads, in either order, can miss one of those
 * moves and see a used checkout as unused.
 */
import {
  resourceStartRequestStatusSchema,
  startBindingPreparationStatusSchema,
} from '@archon/workflows/schemas/resource-start';
import { ISOLATION_ENV_ID_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import type { z } from 'zod';
import { getDatabaseType, getDialect, pool } from './connection';
import { readWorkflowRunStatus } from './workflow-run-status';

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

/**
 * A run releases its environment unconditionally only once it can never claim it
 * again: terminal AND not resumable. Derived rather than hand-listed so a new
 * resumable status keeps its pin automatically.
 */
const UNCLAIMABLE_WORKFLOW_STATUSES = TERMINAL_WORKFLOW_STATUSES.filter(
  status => !RESUMABLE_WORKFLOW_STATUSES.includes(status)
);

/**
 * Terminal but resumable ('failed'). Such a run pins its environment until a
 * cleanup sweep settles its outcome (see FailedRunRelease). A paused run is
 * resumable but not terminal, so it always pins.
 */
export const SETTLEABLE_WORKFLOW_STATUSES = TERMINAL_WORKFLOW_STATUSES.filter(status =>
  RESUMABLE_WORKFLOW_STATUSES.includes(status)
);

/**
 * When a cleanup sweep stops counting a failed run as a lock: once its outcome is
 * settled by Git integration or an eligible PR covering its local tips, or once
 * the run has been inactive longer than the sweep's stale window.
 * The run row itself is never touched.
 */
export type FailedRunRelease = { kind: 'settled' } | { kind: 'stale'; staleDays: number };

/** Builds a statement's placeholders in `params`, whose `$1` is the environment id. */
function placeholders(params: unknown[], values: readonly unknown[]): string {
  return values.map(value => `$${String(params.push(value))}`).join(', ');
}

/**
 * SELECT of the newest workflow run that still owns environment `$1` (columns `id`,
 * `status`), pushing its other parameters onto `params`. Historical conversation rows
 * are data, not locks: every CLI-launched run leaves one behind, so counting
 * references pinned every environment forever (#2868).
 *
 * "Owns" means the run can still act on the estate: it is running, pending or
 * paused, or it failed and remains resumable. With `release`, a failed run whose
 * outcome the caller has settled no longer owns it; every other claimable run
 * still does, whatever else shares the environment.
 *
 * Run metadata, conversation links, and same-codebase checkout paths all pin
 * estate. Creation proof governs deletion, while any claimable user blocks it.
 * A run started on a hand-off (`checkout_handoff`) from a run that owns the
 * environment owns it too: between admission and the lane's layout it records no
 * environment of its own yet.
 */
export function liveRunOwnerSql(
  params: unknown[],
  release?: FailedRunRelease,
  excludeRunId?: string
): string {
  const postgres = getDatabaseType() === 'postgresql';
  const dialect = getDialect();
  // Placeholders follow the status lists' lengths so a new status extends an IN
  // list without a hand-edited parameter position.
  const unclaimable = placeholders(params, UNCLAIMABLE_WORKFLOW_STATUSES);
  let releaseFilter = '';
  if (release) {
    const settleable = placeholders(params, SETTLEABLE_WORKFLOW_STATUSES);
    if (release.kind === 'settled') {
      releaseFilter = `AND r.status NOT IN (${settleable})`;
    } else {
      // The run's own clock: a failed run's completed_at is when it failed. SQLite's
      // datetime() normalizes either stored text format; a NULL or unparseable time
      // keeps the lock.
      const coalesced = 'COALESCE(r.completed_at, r.last_activity_at, r.started_at)';
      const lastActive = postgres ? coalesced : `datetime(${coalesced})`;
      params.push(release.staleDays);
      const threshold = dialect.nowMinusDays(params.length);
      releaseFilter = `AND (r.status NOT IN (${settleable}) OR ${lastActive} IS NULL OR ${lastActive} >= ${threshold})`;
    }
  }
  const exclusion =
    excludeRunId === undefined
      ? ''
      : `AND ${postgres ? 'r.id::text' : 'r.id'} <> $${String(params.push(excludeRunId))}`;
  return `SELECT r.id, r.status
     FROM remote_agent_workflow_runs r
     LEFT JOIN remote_agent_conversations c ON c.id = r.conversation_id
     WHERE (r.status NOT IN (${unclaimable}))
       ${releaseFilter}
       ${exclusion}
       AND (${runOwnsEnvSql('r', 'c')}
         OR EXISTS (SELECT 1 FROM remote_agent_workflow_runs h
           LEFT JOIN remote_agent_conversations hc ON hc.id = h.conversation_id
           WHERE ${postgres ? 'h.id::text' : 'h.id'} = ${dialect.jsonText('r.metadata', 'checkout_handoff.runId')}
             AND ${runOwnsEnvSql('h', 'hc')}))
     ORDER BY r.started_at DESC
     LIMIT 1`;
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
 * SELECT of the oldest start handed the checkout of a run that owns environment `$1`,
 * while that start still waits: its binding is pending, preparing, or failed and
 * retried, or it is prepared and its start request is queued. The protection follows
 * that recorded state, never its age. A rejected or unmatched binding, and a skipped or
 * withdrawn request, stop counting; an admitted request's run counts through
 * liveRunOwnerSql instead.
 */
function waitingHandoffSql(params: unknown[]): string {
  const postgres = getDatabaseType() === 'postgresql';
  // checkout_from is TEXT on both dialects; Postgres casts it before reading a key.
  const fromRunId = getDialect().jsonText(
    postgres ? '(b.checkout_from::jsonb)' : 'b.checkout_from',
    'runId'
  );
  const [prepared, queued] = [
    placeholders(params, [PREPARED_BINDING_STATUS]),
    placeholders(params, [QUEUED_REQUEST_STATUS]),
  ];
  const preparing = placeholders(params, PREPARING_BINDING_STATUSES);
  return `SELECT b.receipt_id, b.binding_id, h.id AS from_run_id, q.id AS request_id
     FROM remote_agent_start_receipt_bindings b
     JOIN remote_agent_workflow_runs h ON ${postgres ? 'h.id::text' : 'h.id'} = ${fromRunId}
     LEFT JOIN remote_agent_conversations hc ON hc.id = h.conversation_id
     LEFT JOIN remote_agent_resource_start_requests q
       ON b.preparation_status = ${prepared} AND q.receipt_id = b.receipt_id
         AND q.binding_id = b.binding_id AND q.status = ${queued}
     WHERE b.checkout_from IS NOT NULL
       AND ${runOwnsEnvSql('h', 'hc')}
       AND (b.preparation_status IN (${preparing}) OR q.id IS NOT NULL)
     ORDER BY b.created_at
     LIMIT 1`;
}

type OwnerRun = { id: string; status: WorkflowRunStatus };

/** Everything that still uses an environment, read in one statement. */
export interface EnvUse {
  /** The newest run that still owns the environment. */
  owner: OwnerRun | null;
  /** With `release`, the newest owner left once that release applies. */
  releasedOwner: OwnerRun | null;
  handoff: WaitingHandoff | null;
}

/**
 * The runs and waiting starts that use environment `envId`, from one statement and so
 * one snapshot (see the module comment). `release` is the cleanup sweep's settlement of
 * a failed owner; without it `releasedOwner` is null.
 */
export async function getEnvUse(envId: string, release?: FailedRunRelease): Promise<EnvUse> {
  const params: unknown[] = [envId];
  const owner = liveRunOwnerSql(params);
  const released = release ? liveRunOwnerSql(params, release) : undefined;
  const handoff = waitingHandoffSql(params);
  const result = await pool.query<{
    owner_id: string | null;
    owner_status: string | null;
    released_id: string | null;
    released_status: string | null;
    receipt_id: string | null;
    binding_id: string | null;
    from_run_id: string | null;
    request_id: string | null;
  }>(
    `SELECT o.id AS owner_id, o.status AS owner_status,
       ${released ? 's.id' : 'NULL'} AS released_id, ${released ? 's.status' : 'NULL'} AS released_status,
       w.receipt_id, w.binding_id, w.from_run_id, w.request_id
     FROM (SELECT 1 AS one) base
     LEFT JOIN (${owner}) o ON 1 = 1
     ${released ? `LEFT JOIN (${released}) s ON 1 = 1` : ''}
     LEFT JOIN (${handoff}) w ON 1 = 1`,
    params
  );
  const row = result.rows[0];
  const run = (id: string | null | undefined, status: string | null | undefined) =>
    id && status ? { id: String(id), status: readWorkflowRunStatus(String(id), status) } : null;
  return {
    owner: run(row?.owner_id, row?.owner_status),
    releasedOwner: run(row?.released_id, row?.released_status),
    handoff: row?.receipt_id && row.binding_id && row.from_run_id ? toWaitingHandoff(row) : null,
  };
}

function toWaitingHandoff(row: {
  receipt_id: string | null;
  binding_id: string | null;
  from_run_id: string | null;
  request_id: string | null;
}): WaitingHandoff {
  const start = {
    receiptId: String(row.receipt_id),
    bindingId: String(row.binding_id),
    fromRunId: String(row.from_run_id),
  };
  return row.request_id === null
    ? { ...start, waitingFor: 'preparation' }
    : { ...start, waitingFor: 'capacity', requestId: String(row.request_id) };
}
