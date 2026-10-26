import {
  buildTerminalRecord,
  observeRunArtifacts,
  terminalArtifactsFor,
  type TerminalRecordEvent,
} from '@archon/workflows/terminal-record';
import type { ArtifactManifest } from '@archon/workflows/schemas/terminal-record';
import type { RunTerminalStatus, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { getDatabase } from './connection';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';
import { insertWorkflowEvent, type WorkflowEventInput } from './workflow-events';

/** Artifact manifests walked before a terminal transaction, keyed by run id. */
export type TerminalArtifacts = ReadonlyMap<string, ArtifactManifest>;

export async function observeTerminalArtifacts(
  runs: readonly Pick<WorkflowRun, 'id' | 'output_root'>[]
): Promise<TerminalArtifacts> {
  return new Map(
    await Promise.all(runs.map(async run => [run.id, await observeRunArtifacts(run)] as const))
  );
}

/** Walk one run's artifacts outside any transaction; a missing run observes nothing. */
export async function observeRunTerminalArtifacts(id: string): Promise<TerminalArtifacts> {
  const result = await getDatabase().query<Pick<WorkflowRun, 'id' | 'output_root'>>(
    'SELECT id, output_root FROM remote_agent_workflow_runs WHERE id = $1',
    [id]
  );
  return observeTerminalArtifacts(result.rows);
}

/**
 * The winning status update, its projection, and its event share this transaction.
 * It does database work only: the caller walks the artifacts first, because a walk
 * inside the transaction holds the SQLite write lock for its whole duration.
 */
export async function insertTerminalWorkflowEvent(
  query: IDatabase['query'],
  event: WorkflowEventInput & {
    event_type: `workflow_${RunTerminalStatus}`;
  },
  artifacts: TerminalArtifacts
): Promise<void> {
  const runResult = await query<WorkflowRunRow>(
    'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
    [event.workflow_run_id]
  );
  const row = runResult.rows[0];
  if (!row) throw new Error(`Terminal workflow run disappeared: ${event.workflow_run_id}`);
  const eventResult = await query<TerminalRecordEvent>(
    `SELECT event_type, step_name, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1
     ORDER BY COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
    [event.workflow_run_id]
  );
  const run = normalizeWorkflowRun(row);
  const observed = artifacts.get(run.id);
  const manifest = terminalArtifactsFor(run, observed);
  if (manifest !== observed)
    getLog().warn({ workflowRunId: run.id }, 'db.workflow_terminal_artifacts_not_observed');
  await insertWorkflowEvent(query, {
    ...event,
    data: {
      ...event.data,
      terminal_record: buildTerminalRecord({ run, events: eventResult.rows, artifacts: manifest }),
    },
  });
}
