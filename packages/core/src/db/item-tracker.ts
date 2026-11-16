/**
 * Reads and baseline writes for the item tracker, the destination that shows an item's
 * runs on the tracker the item came from. Its ledger is `attention_notice_sent` rows with
 * the tracker's destination id: each run's latest `started` or `terminal` row records the
 * state the status comment last showed for it.
 */
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { getDialect, pool } from './connection';
import { insertWorkflowEvent } from './workflow-events';

export interface TrackerCandidateRun {
  id: string;
  itemKey: string;
  terminal: boolean;
}

const terminalStatuses = (from: number): string =>
  TERMINAL_WORKFLOW_STATUSES.map((_, i) => `$${String(from + i)}`).join(', ');

/**
 * Runs on the items of `projectKey` whose status comment may owe an update to
 * `destination`: every run that has not ended, and every ended run whose latest tracker
 * row is not `terminal`. An ended run with a `terminal` row and no later `started` row is
 * settled, so the set stays bounded to live and newly ended runs.
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
        OR NOT EXISTS (SELECT 1 FROM remote_agent_workflow_events t WHERE ${trackerRow('t', 'terminal')}
          AND NOT EXISTS (SELECT 1 FROM remote_agent_workflow_events s WHERE ${trackerRow('s', 'started')}
            AND COALESCE(s.event_order, 0) > COALESCE(t.event_order, 0))))`,
    [projectKey, destination, ...TERMINAL_WORKFLOW_STATUSES]
  );
  return result.rows.map(row => ({
    id: row.id,
    itemKey: row.item_key,
    terminal: Number(row.terminal) === 1,
  }));
}

/**
 * Record every ended run on the items of `projectKey` as already shown to `destination`,
 * so turning the tracker on writes nothing for work that ended before. Runs inside the
 * caller's transaction.
 */
export async function recordTrackerBaseline(
  projectKey: string,
  destination: string,
  query: IDatabase['query']
): Promise<void> {
  const ended = await query<{ id: string }>(
    `SELECT r.id FROM remote_agent_workflow_runs r JOIN remote_agent_items i ON i.id = r.item_id
      WHERE i.project_key = $1 AND r.status IN (${terminalStatuses(2)})`,
    [projectKey, ...TERMINAL_WORKFLOW_STATUSES]
  );
  for (const run of ended.rows)
    await insertWorkflowEvent(query, {
      workflow_run_id: run.id,
      event_type: 'attention_notice_sent',
      data: { destination, key: 'terminal', baseline: true },
    });
}
