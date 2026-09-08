import type { IWorkflowTriggerStore, TriggerAdmission } from '@archon/workflows/trigger';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { getDatabase } from './connection';
import { createWorkflowRun, getWorkflowRun } from './workflows';

interface AdmissionRow {
  run_id: string;
  disposition: 'accepted' | 'skipped';
}
function result(row: AdmissionRow): TriggerAdmission {
  return {
    disposition: row.disposition === 'skipped' ? 'skipped' : 'duplicate',
    runId: row.run_id,
  };
}

export function createWorkflowTriggerStore(): IWorkflowTriggerStore {
  return {
    async getAdmission(triggerId, eventId): Promise<TriggerAdmission | null> {
      const rows = await getDatabase().withTransaction(query =>
        query<AdmissionRow>(
          'SELECT run_id, disposition FROM remote_agent_workflow_trigger_events WHERE trigger_id = $1 AND event_id = $2',
          [triggerId, eventId]
        )
      );
      return rows.rows[0] ? result(rows.rows[0]) : null;
    },
    async admit({ triggerId, eventId, overlap, run }): Promise<TriggerAdmission> {
      return getDatabase().withTransaction(async query => {
        // A write FIRST serializes per-trigger admission on Postgres and takes
        // SQLite's writer lock before any snapshot is read, including across processes.
        await query(
          'INSERT INTO remote_agent_workflow_trigger_locks (trigger_id) VALUES ($1) ON CONFLICT (trigger_id) DO UPDATE SET trigger_id = excluded.trigger_id',
          [triggerId]
        );
        const existing = await query<AdmissionRow>(
          'SELECT run_id, disposition FROM remote_agent_workflow_trigger_events WHERE trigger_id = $1 AND event_id = $2',
          [triggerId, eventId]
        );
        if (existing.rows[0]) return result(existing.rows[0]);
        let runId = run.id;
        let disposition: 'accepted' | 'skipped' = 'accepted';
        if (overlap === 'skip') {
          const terminal = TERMINAL_WORKFLOW_STATUSES.map(
            (_, index) => `$${String(index + 2)}`
          ).join(', ');
          const scheduledResume =
            getDatabase().dialect === 'postgres'
              ? "jsonb_typeof(r.metadata->'scheduled_resume') = 'object'"
              : "json_type(r.metadata, '$.scheduled_resume') = 'object'";
          const active = await query<{ id: string }>(
            `SELECT r.id FROM remote_agent_workflow_trigger_events e JOIN remote_agent_workflow_runs r ON r.id = e.run_id WHERE e.trigger_id = $1 AND e.disposition = 'accepted' AND (r.status NOT IN (${terminal}) OR (r.status = 'failed' AND ${scheduledResume})) LIMIT 1`,
            [triggerId, ...TERMINAL_WORKFLOW_STATUSES]
          );
          if (active.rows[0]) {
            runId = active.rows[0].id;
            disposition = 'skipped';
          }
        }
        if (disposition === 'accepted') await createWorkflowRun(run, query);
        await query(
          'INSERT INTO remote_agent_workflow_trigger_events (trigger_id, event_id, run_id, disposition) VALUES ($1, $2, $3, $4)',
          [triggerId, eventId, runId, disposition]
        );
        return { disposition, runId };
      });
    },
    async claimPendingRun(runId): ReturnType<IWorkflowTriggerStore['claimPendingRun']> {
      const claimed = await getDatabase().withTransaction(query =>
        query(
          "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1 AND status = 'pending'",
          [runId]
        )
      );
      if (claimed.rowCount === 0) return null;
      const run = await getWorkflowRun(runId);
      if (!run) throw new Error(`Admitted run '${runId}' disappeared`);
      // The persisted CAS owns execution; the executor receives its fresh-run
      // snapshot so it performs normal startup, not continuation hydration.
      return { ...run, status: 'pending' };
    },
  };
}
