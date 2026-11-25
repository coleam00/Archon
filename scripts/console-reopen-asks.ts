/**
 * `bun run dev:console --reopen-asks`: reopen answered asks on the console's throwaway copy of
 * the live database, so Needs you can be looked at with real asks while the live factory has
 * none open. Never run on any other database: it rewrites engine rows.
 *
 * For each item and workflow, the newest set of asks (one asking run's) is reopened when every
 * ask in it was answered and none is open: its close columns are cleared, so the engine lists
 * them as open again. Only the newest set, so the engine's rule of at most one open set per
 * workflow per item holds; and a second run on the same copy changes nothing, because the
 * newest set is then open.
 */
import type { Database } from 'bun:sqlite';

/** The asking runs whose sets are reopened: newest per item and workflow, wholly answered. */
const NEWEST_ANSWERED_SETS = `
  WITH sets AS (
    SELECT item_id, workflow_name, run_id, MAX(created_at) AS asked_at,
           SUM(CASE WHEN closed_as = 'answered' THEN 0 ELSE 1 END) AS not_answered
    FROM remote_agent_item_asks
    GROUP BY item_id, workflow_name, run_id
  ),
  newest AS (
    SELECT s.* FROM sets s
    WHERE s.asked_at = (
      SELECT MAX(o.asked_at) FROM sets o
      WHERE o.item_id = s.item_id AND o.workflow_name = s.workflow_name
    )
  )
  SELECT run_id FROM newest WHERE not_answered = 0`;

/** Reopen the newest wholly answered set of asks per item and workflow; returns how many asks. */
export function reopenAnsweredAsks(db: Database): number {
  const runs = db.query<{ run_id: string }, []>(NEWEST_ANSWERED_SETS).all();
  const reopen = db.prepare(
    `UPDATE remote_agent_item_asks
       SET closed_as = NULL, answer = NULL, closed_at = NULL, closed_via = NULL,
           closed_by_declared = NULL, closed_by_user_id = NULL, closed_from_run_id = NULL,
           closed_from_node_path = NULL, replaced_by_run_id = NULL
     WHERE run_id = ? AND closed_as = 'answered'`
  );
  let reopened = 0;
  db.transaction(() => {
    for (const { run_id } of runs) reopened += reopen.run(run_id).changes;
  })();
  return reopened;
}
