/**
 * Reads and baseline writes for the item tracker, the destination that shows an item's
 * runs on the tracker the item came from. Its ledger is `attention_notice_sent` rows with
 * the tracker's destination id: each run's latest `started` or `terminal` row records the
 * state the status comment last showed for it, and a `question:`, `ask:`, `ruling:` or
 * `result` row records a comment posted once.
 */
import { RUN_ENDED_SOURCE_ACTOR } from '@archon/workflows/schemas/resource-start';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { getDialect, pool } from './connection';
import { insertWorkflowEvent } from './workflow-events';

/** The status rows: each run's latest one records the state its status comment showed. */
export const TRACKER_STARTED_KEY = 'started';
export const TRACKER_TERMINAL_KEY = 'terminal';
export type TrackerStatusKey = typeof TRACKER_STARTED_KEY | typeof TRACKER_TERMINAL_KEY;
/** The ledger key a run's `workflow_resumed` event reads as; the tracker never writes it. */
export const TRACKER_RESUMED_KEY = 'resumed';

export interface TrackerCandidateRun {
  id: string;
  itemKey: string;
  terminal: boolean;
}

const placeholders = (values: readonly unknown[], from: number): string =>
  values.map((_, i) => `$${String(from + i)}`).join(', ');
const terminalStatuses = (from: number): string => placeholders(TERMINAL_WORKFLOW_STATUSES, from);

/**
 * Runs on the items of `projectKey` whose status comment may owe an update to
 * `destination`: every run that has not ended, and every ended run whose latest tracker
 * row is not `terminal`. An ended run with a `terminal` row and no later `started` row or
 * resume is settled, so the set stays bounded to live and newly ended runs.
 */
export async function listTrackerCandidateRuns(
  projectKey: string,
  destination: string
): Promise<TrackerCandidateRun[]> {
  const field = (alias: string, key: string): string => getDialect().jsonText(`${alias}.data`, key);
  const trackerRow = (alias: string, key: string): string =>
    `${alias}.workflow_run_id = r.id AND ${alias}.event_type = 'attention_notice_sent'
      AND ${field(alias, 'destination')} = $2 AND ${field(alias, 'key')} = '${key}'`;
  const statuses = terminalStatuses(3);
  const result = await pool.query<{ id: string; item_key: string; terminal: number | boolean }>(
    `SELECT r.id, i.key AS item_key,
            CASE WHEN r.status IN (${statuses}) THEN 1 ELSE 0 END AS terminal
       FROM remote_agent_workflow_runs r JOIN remote_agent_items i ON i.id = r.item_id
      WHERE i.project_key = $1 AND (
        r.status NOT IN (${statuses})
        OR NOT EXISTS (SELECT 1 FROM remote_agent_workflow_events t WHERE ${trackerRow('t', TRACKER_TERMINAL_KEY)}
          AND NOT EXISTS (SELECT 1 FROM remote_agent_workflow_events s
            WHERE (${trackerRow('s', TRACKER_STARTED_KEY)}
              OR (s.workflow_run_id = r.id AND s.event_type = 'workflow_resumed'))
            AND COALESCE(s.event_order, 0) > COALESCE(t.event_order, 0))))`,
    [projectKey, destination, ...TERMINAL_WORKFLOW_STATUSES]
  );
  return result.rows.map(row => ({
    id: row.id,
    itemKey: row.item_key,
    terminal: Number(row.terminal) === 1,
  }));
}

/** A tracker ledger row to write: the run it is recorded on and its key. */
export interface TrackerRow {
  runId: string;
  key: string;
}

const ASK_KEY = 'ask:';
const RULING_KEY = 'ruling:';
export const trackerAskKey = (askId: string): string => `${ASK_KEY}${askId}`;
export const trackerRulingKey = (rulingId: string): string => `${RULING_KEY}${rulingId}`;

/** SQL for "a row for the tracker `destination` ($2) on run `run` under key `key`". */
function trackerRowSql(run: string, key: string): string {
  const field = (name: string): string => getDialect().jsonText('e.data', name);
  return `SELECT 1 FROM remote_agent_workflow_events e WHERE CAST(e.workflow_run_id AS TEXT) = CAST(${run} AS TEXT)
    AND e.event_type = 'attention_notice_sent' AND ${field('destination')} = $2
    AND ${field('key')} = ${key}`;
}

const OPEN_ASKS = `SELECT a.id, a.run_id, a.item_id FROM remote_agent_item_asks a
  JOIN remote_agent_items i ON i.id = a.item_id
  WHERE i.project_key = $1 AND a.closed_as IS NULL`;

// A ruling is posted once its item has a run: its row is kept on one of the item's runs.
const STANDING_RULINGS = `SELECT g.id, g.item_id,
    (SELECT r.id FROM remote_agent_workflow_runs r WHERE r.item_id = g.item_id
      ORDER BY r.started_at, r.id LIMIT 1) AS run_id
  FROM remote_agent_item_rulings g JOIN remote_agent_items i ON i.id = g.item_id
  WHERE i.project_key = $1 AND g.withdraws IS NULL
    AND NOT EXISTS (SELECT 1 FROM remote_agent_item_rulings w WHERE w.withdraws = g.id)
    AND EXISTS (SELECT 1 FROM remote_agent_workflow_runs r WHERE r.item_id = g.item_id)`;

/**
 * Keys of the items of `projectKey` with an open ask or a standing ruling that
 * `destination` has not recorded a comment for. A ruling counts once its item has a run.
 */
export async function listTrackerItemsOwingComments(
  projectKey: string,
  destination: string
): Promise<string[]> {
  const result = await pool.query<{ key: string }>(
    `SELECT DISTINCT i.key FROM remote_agent_items i WHERE i.id IN (
       SELECT o.item_id FROM (${OPEN_ASKS}) o
        WHERE NOT EXISTS (${trackerRowSql('o.run_id', `'${ASK_KEY}' || o.id`)})
       UNION
       SELECT g.item_id FROM (${STANDING_RULINGS}) g
        WHERE NOT EXISTS (SELECT 1 FROM remote_agent_workflow_runs gr WHERE gr.item_id = g.item_id
          AND EXISTS (${trackerRowSql('gr.id', `'${RULING_KEY}' || g.id`)})))`,
    [projectKey, destination]
  );
  return result.rows.map(row => row.key);
}

/**
 * True when the end of one of `runIds` started a next stage that has no run yet: a
 * run-ended binding matched it and is still being prepared, or its start waits in the
 * resource queue. Admission creates the run in the same write that ends both states.
 */
export async function runEndStageOwed(runIds: readonly string[]): Promise<boolean> {
  if (runIds.length === 0) return false;
  const result = await pool.query<{ source_actor: string | null }>(
    `SELECT r.source_actor FROM remote_agent_start_receipts r
      WHERE r.outcome = 'matched' AND r.delivery_id IN (${placeholders(runIds, 1)})
        AND (EXISTS (SELECT 1 FROM remote_agent_start_receipt_bindings b WHERE b.receipt_id = r.id
              AND b.preparation_status IN ('pending', 'preparing'))
          OR EXISTS (SELECT 1 FROM remote_agent_resource_start_requests q WHERE q.receipt_id = r.id
              AND q.status = 'queued'))`,
    [...runIds]
  );
  return result.rows.some(row => {
    if (row.source_actor === null) return false;
    const actor = JSON.parse(row.source_actor) as { source?: unknown } | null;
    return actor?.source === RUN_ENDED_SOURCE_ACTOR;
  });
}

/**
 * The ledger of `destination` on `runIds` in event order. A run's `workflow_resumed` event
 * reads as a `resumed` row, so what the tracker showed before it is stale whether or not
 * the tracker saw the run live again before it ended again.
 */
export async function listTrackerLedger(
  runIds: readonly string[],
  destination: string
): Promise<TrackerRow[]> {
  if (runIds.length === 0) return [];
  const field = (key: string): string => getDialect().jsonText('e.data', key);
  const result = await pool.query<{ workflow_run_id: string; key: string }>(
    `SELECT e.workflow_run_id,
            CASE WHEN e.event_type = 'workflow_resumed' THEN '${TRACKER_RESUMED_KEY}' ELSE ${field('key')} END AS key
       FROM remote_agent_workflow_events e
      WHERE e.workflow_run_id IN (${placeholders(runIds, 2)})
        AND (e.event_type = 'workflow_resumed'
          OR (e.event_type = 'attention_notice_sent' AND ${field('destination')} = $1))
      ORDER BY COALESCE(e.event_order, 0) ASC, e.created_at ASC, e.id ASC`,
    [destination, ...runIds]
  );
  return result.rows.map(row => ({ runId: row.workflow_run_id, key: row.key }));
}

/**
 * Record what the items of `projectKey` already hold as shown to `destination`, so
 * turning the tracker on writes nothing for it: every ended run, open ask and standing
 * ruling, and the caller's `rows` (the open pauses, which only the caller can read).
 * Runs inside the caller's transaction.
 */
export async function recordTrackerBaseline(
  projectKey: string,
  destination: string,
  query: IDatabase['query'],
  rows: readonly TrackerRow[] = []
): Promise<void> {
  const ended = await query<{ id: string }>(
    `SELECT r.id FROM remote_agent_workflow_runs r JOIN remote_agent_items i ON i.id = r.item_id
      WHERE i.project_key = $1 AND r.status IN (${terminalStatuses(2)})`,
    [projectKey, ...TERMINAL_WORKFLOW_STATUSES]
  );
  const asks = await query<{ id: string; run_id: string }>(OPEN_ASKS, [projectKey]);
  const rulings = await query<{ id: string; run_id: string }>(STANDING_RULINGS, [projectKey]);
  const baseline: TrackerRow[] = [
    ...ended.rows.map(run => ({ runId: run.id, key: TRACKER_TERMINAL_KEY })),
    ...asks.rows.map(ask => ({ runId: ask.run_id, key: trackerAskKey(ask.id) })),
    ...rulings.rows.map(ruling => ({ runId: ruling.run_id, key: trackerRulingKey(ruling.id) })),
    ...rows,
  ];
  for (const row of baseline)
    await insertWorkflowEvent(query, {
      workflow_run_id: row.runId,
      event_type: 'attention_notice_sent',
      data: { destination, key: row.key, baseline: true },
    });
}
