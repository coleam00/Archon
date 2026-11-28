import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import type { DashboardWorkflowRun } from '@archon/core/schemas/workflow-run';
import {
  ISOLATION_ENV_ID_METADATA_KEY,
  readRunDispatchMetadata,
} from '@archon/workflows/schemas/run-metadata';
import {
  boundedMessageText,
  type RunProgress,
  type RunStep,
} from '@archon/workflows/schemas/run-progress';
import { NODE_STATE_EVENT_TYPES } from '@archon/workflows/store';
import { buildRunSteps } from '@archon/workflows/terminal-record';
import { getLog } from './api-route-kit';

async function readRunBranch(run: DashboardWorkflowRun): Promise<string | null> {
  const environmentId = run.metadata[ISOLATION_ENV_ID_METADATA_KEY];
  if (typeof environmentId !== 'string') return null;
  return (await isolationEnvDb.getById(environmentId))?.branch_name ?? null;
}

/**
 * The engine's reader rejects a damaged node record. One such run must not blank the
 * list: it is served without progress, and its card renders without a strip.
 */
function readRunSteps(
  run: DashboardWorkflowRun,
  events: Parameters<typeof buildRunSteps>[1]
): RunStep[] | null {
  try {
    return buildRunSteps(run, events);
  } catch (error) {
    getLog().error({ err: error, runId: run.id }, 'dashboard_run_progress_failed');
    return null;
  }
}

function laterOf(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) return left ?? right;
  return left > right ? left : right;
}

/**
 * The progress of each listed run that is running or paused, by run id; other runs have
 * no entry. Reads are batched across the page and skipped when it holds no active run.
 */
export async function readDashboardRunProgress(
  runs: readonly DashboardWorkflowRun[]
): Promise<Map<string, RunProgress | null>> {
  const active = runs.filter(run => run.status === 'running' || run.status === 'paused');
  if (active.length === 0) return new Map();
  const ids = active.map(run => run.id);
  const [events, eventTimes, messages, branches] = await Promise.all([
    workflowEventDb.listEventsForRuns(ids, NODE_STATE_EVENT_TYPES),
    workflowEventDb.listLatestEventTimes(ids),
    workflowEventDb.listLatestAgentMessages(ids),
    Promise.all(active.map(readRunBranch)),
  ]);
  return new Map(
    active.map((run, index): [string, RunProgress | null] => {
      const steps = readRunSteps(run, events.get(run.id) ?? []);
      if (steps === null) return [run.id, null];
      const message = messages.get(run.id) ?? null;
      const baseBranch = readRunDispatchMetadata(run.metadata)?.base_branch;
      return [
        run.id,
        {
          steps,
          last_observed_at:
            laterOf(run.last_activity_at, eventTimes.get(run.id) ?? null)?.toISOString() ?? null,
          last_message:
            message === null
              ? null
              : {
                  node_id: message.stepName,
                  at: message.observedAt,
                  ...boundedMessageText(message.text),
                },
          branch: branches[index] ?? null,
          base_branch: baseBranch === undefined || baseBranch === '' ? null : baseBranch,
        },
      ];
    })
  );
}
