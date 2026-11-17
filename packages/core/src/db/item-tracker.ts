/**
 * Reads and baseline writes for the item tracker, the destination that shows an item's
 * runs on the tracker the item came from. Its ledger is `attention_notice_sent` rows with
 * the tracker's destination id. A status row, `started:<n>` or `terminal:<n>`, records
 * that the status comment showed a run live or ended after its `n`th resume. A `result`
 * row records the item's final result as posted, and a `question:`, `ask:` or `ruling:`
 * row a comment posted once.
 *
 * A status row names the end it showed rather than relying on its place in the ledger: a
 * row recorded after a resume that committed while its write was in flight still names
 * the end before that resume, so the run stays owed until its current state is shown.
 */
import { RUN_ENDED_SOURCE_ACTOR } from '@archon/workflows/schemas/resource-start';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { getDialect, pool } from './connection';
import { insertWorkflowEvent } from './workflow-events';

export type TrackerStatus = 'started' | 'terminal';
export const TRACKER_RESULT_KEY = 'result';

/** The status row that shows a run live or ended after its `resumes`th resume. */
export function trackerStatusKey(status: TrackerStatus, resumes: number): string {
  return `${status}:${String(resumes)}`;
}

export interface TrackerCandidateRun {
  id: string;
  itemKey: string;
  terminal: boolean;
  /** How many times the run has resumed; the status row for its current state names it. */
  resumes: number;
  /** The status comment shows the run's current state. */
  shown: boolean;
}

const placeholders = (values: readonly unknown[], from: number): string =>
  values.map((_, i) => `$${String(from + i)}`).join(', ');
const terminalStatuses = (from: number): string => placeholders(TERMINAL_WORKFLOW_STATUSES, from);

const resumeCount = (run: string): string =>
  `(SELECT COUNT(*) FROM remote_agent_workflow_events v
     WHERE v.workflow_run_id = ${run} AND v.event_type = 'workflow_resumed')`;

/** SQL for "event `alias` is a row of the tracker destination in parameter `param`". */
function trackerEvent(alias: string, param: string): string {
  return `${alias}.event_type = 'attention_notice_sent'
    AND ${getDialect().jsonText(`${alias}.data`, 'destination')} = ${param}`;
}
const keyOf = (alias: string): string => getDialect().jsonText(`${alias}.data`, 'key');

/**
 * Runs on the items of `projectKey` whose status comment may owe an update to
 * `destination`: every run that has not ended, and every ended run with no status row
 * for its current end. An ended run whose current end is shown is settled, so the set
 * stays bounded to live and newly ended runs.
 */
export async function listTrackerCandidateRuns(
  projectKey: string,
  destination: string
): Promise<TrackerCandidateRun[]> {
  const result = await pool.query<{
    id: string;
    item_key: string;
    terminal: number | boolean;
    resumes: number | string;
    shown: number | boolean;
  }>(
    `SELECT c.* FROM (
       SELECT b.*, CASE WHEN EXISTS (SELECT 1 FROM remote_agent_workflow_events t
           WHERE t.workflow_run_id = b.id AND ${trackerEvent('t', '$2')}
             AND ${keyOf('t')} = (CASE WHEN b.terminal = 1 THEN 'terminal:' ELSE 'started:' END)
               || CAST(b.resumes AS TEXT))
         THEN 1 ELSE 0 END AS shown
       FROM (SELECT r.id, i.key AS item_key,
                    CASE WHEN r.status IN (${terminalStatuses(3)}) THEN 1 ELSE 0 END AS terminal,
                    ${resumeCount('r.id')} AS resumes
               FROM remote_agent_workflow_runs r JOIN remote_agent_items i ON i.id = r.item_id
              WHERE i.project_key = $1) b) c
      WHERE c.terminal = 0 OR c.shown = 0`,
    [projectKey, destination, ...TERMINAL_WORKFLOW_STATUSES]
  );
  return result.rows.map(row => ({
    id: row.id,
    itemKey: row.item_key,
    terminal: Number(row.terminal) === 1,
    resumes: Number(row.resumes),
    shown: Number(row.shown) === 1,
  }));
}

/**
 * Items whose final result is owed, with the run whose end it shows: no run on the item
 * is live, and the item's latest `terminal` row has no `result` row after it. A run that
 * resumes and is shown ending again gets a later `terminal` row, so its result is owed
 * again. Every item of `projectKey`, or only `itemKey`. Whether the work is over (no open
 * ask, no next stage on its way) the caller decides from the item's facts, and the
 * result stays owed until it is posted.
 */
export async function listTrackerResultsOwed(
  projectKey: string,
  destination: string,
  itemKey?: string
): Promise<{ itemKey: string; runId: string }[]> {
  const byKey = itemKey === undefined ? [] : [itemKey];
  const result = await pool.query<{ item_key: string; run_id: string }>(
    `SELECT i.key AS item_key, t.workflow_run_id AS run_id
       FROM remote_agent_items i
       JOIN remote_agent_workflow_runs r ON r.item_id = i.id
       JOIN remote_agent_workflow_events t ON t.workflow_run_id = r.id
        AND ${trackerEvent('t', '$2')} AND ${keyOf('t')} LIKE 'terminal:%'
      WHERE i.project_key = $1${byKey.length > 0 ? ' AND i.key = $3' : ''}
        AND NOT EXISTS (SELECT 1 FROM remote_agent_workflow_runs l
          WHERE l.item_id = i.id AND l.status NOT IN (${terminalStatuses(3 + byKey.length)}))
        AND NOT EXISTS (SELECT 1 FROM remote_agent_workflow_runs o
          JOIN remote_agent_workflow_events u ON u.workflow_run_id = o.id
           AND ${trackerEvent('u', '$2')}
          WHERE o.item_id = i.id
            AND (${keyOf('u')} LIKE 'terminal:%' OR ${keyOf('u')} = '${TRACKER_RESULT_KEY}')
            AND COALESCE(u.event_order, 0) > COALESCE(t.event_order, 0))`,
    [projectKey, destination, ...byKey, ...TERMINAL_WORKFLOW_STATUSES]
  );
  return result.rows.map(row => ({ itemKey: row.item_key, runId: row.run_id }));
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
  return `SELECT 1 FROM remote_agent_workflow_events e WHERE CAST(e.workflow_run_id AS TEXT) = CAST(${run} AS TEXT)
    AND ${trackerEvent('e', '$2')} AND ${keyOf('e')} = ${key}`;
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

/** The rows `destination` recorded on `runIds`. */
export async function listTrackerLedger(
  runIds: readonly string[],
  destination: string
): Promise<TrackerRow[]> {
  if (runIds.length === 0) return [];
  const result = await pool.query<{ workflow_run_id: string; key: string }>(
    `SELECT e.workflow_run_id, ${keyOf('e')} AS key FROM remote_agent_workflow_events e
      WHERE ${trackerEvent('e', '$1')} AND e.workflow_run_id IN (${placeholders(runIds, 2)})`,
    [destination, ...runIds]
  );
  return result.rows.map(row => ({ runId: row.workflow_run_id, key: row.key }));
}

/**
 * Record what the items of `projectKey` already hold as shown to `destination`, so
 * turning the tracker on writes nothing for it: every ended run's end and result, open
 * ask and standing ruling, and the caller's `rows` (the open pauses, which only the
 * caller can read). Runs inside the caller's transaction.
 */
export async function recordTrackerBaseline(
  projectKey: string,
  destination: string,
  query: IDatabase['query'],
  rows: readonly TrackerRow[] = []
): Promise<void> {
  const ended = await query<{ id: string; resumes: number | string }>(
    `SELECT r.id, ${resumeCount('r.id')} AS resumes
       FROM remote_agent_workflow_runs r JOIN remote_agent_items i ON i.id = r.item_id
      WHERE i.project_key = $1 AND r.status IN (${terminalStatuses(2)})`,
    [projectKey, ...TERMINAL_WORKFLOW_STATUSES]
  );
  const asks = await query<{ id: string; run_id: string }>(OPEN_ASKS, [projectKey]);
  const rulings = await query<{ id: string; run_id: string }>(STANDING_RULINGS, [projectKey]);
  const baseline: TrackerRow[] = [
    ...ended.rows.map(run => ({
      runId: run.id,
      key: trackerStatusKey('terminal', Number(run.resumes)),
    })),
    // After every `terminal` row, so no item's result is owed.
    ...ended.rows.map(run => ({ runId: run.id, key: TRACKER_RESULT_KEY })),
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
