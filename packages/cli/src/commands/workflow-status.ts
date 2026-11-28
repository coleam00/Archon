/**
 * What `workflow status` needs beside the listing: the project it resolves to, and what this
 * process sees of each active run's owner.
 */
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { observeRunOwner } from '@archon/core/services/run-attention-watch';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { observeRunOwners } from '@archon/workflows/owner-observation';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type {
  DashboardWorkflowRun,
  RunOwnerObservation,
} from '@archon/workflows/schemas/workflow-run-listing';
import { runAttention } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine } from '../utils/stdout';
import { buildNodeSummaries, fetchVerboseEvents } from './workflow-node-summaries';
import { printStatusRun } from './workflow-inspect';
import type { readHeldStarts } from './workflow-held-starts';
import { getLog, inheritedWorkflowCodebase } from './workflow-shared';

import { latestWorkflowNotices } from '@archon/workflows/workflow-notice';

type HeldStarts = Awaited<ReturnType<typeof readHeldStarts>>;

export async function resolveStatusCodebase(
  host: WorkflowHost,
  cwd: string,
  all: boolean | undefined
) {
  try {
    const codebase = await inheritedWorkflowCodebase(host, all);
    if (codebase === undefined && !all) {
      return await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    }
    return codebase;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_status_codebase_lookup_failed');
    throw new Error(`Failed to resolve workflow status project: ${err.message}`, { cause: err });
  }
}

/**
 * What this process sees of each run's owner, by the rule `workflow wait` and `workflow resume`
 * use, in `runs`' order. Reading changes nothing: a run whose owner does not answer is listed, never
 * ended. An observation that itself failed reads `unknown`: a read that cannot be made must
 * never read as gone, and must not fail the listing.
 */
export async function statusOwners(
  host: WorkflowHost,
  runs: readonly DashboardWorkflowRun[]
): Promise<Map<string, RunOwnerObservation | null>> {
  const observe = async (run: WorkflowRun): Promise<RunOwnerObservation | null> => {
    try {
      return await observeRunOwner(host.deps.store, run);
    } catch (error) {
      getLog().warn({ err: error, runId: run.id }, 'cli.workflow_status_owner_unreadable');
      return 'unknown';
    }
  };
  const observed = await observeRunOwners({ runs: async () => [...runs], observe }, runs);
  return new Map(runs.map((run, index) => [run.id, observed[index] ?? null]));
}

/** `--lost` keeps only runs reported unreachable; `unknown` is never lost. */
export function lostOnly(
  runs: DashboardWorkflowRun[],
  owners: ReadonlyMap<string, RunOwnerObservation | null>
): DashboardWorkflowRun[] {
  return runs.filter(run => owners.get(run.id) === 'unreachable');
}

async function verboseStatusRuns(
  host: WorkflowHost,
  runs: DashboardWorkflowRun[],
  rawEvents = false
) {
  const fetchedPerRun = await Promise.all(
    runs.map(run => fetchVerboseEvents(host, run.id, rawEvents))
  );
  if (fetchedPerRun.some(result => result.failed)) {
    throw new Error('Failed to fetch workflow events for verbose status.');
  }
  return runs.map((run, i) => {
    const runEvents = fetchedPerRun[i]?.events ?? [];
    return rawEvents
      ? { ...run, attention: runAttention(run), events: runEvents }
      : { ...run, attention: runAttention(run), nodes: buildNodeSummaries(runEvents) };
  });
}

/** The JSON view: each run with its notice and owner, and what the listing was asked for. */
export async function writeStatusJson(
  host: WorkflowHost,
  runs: DashboardWorkflowRun[],
  owners: ReadonlyMap<string, RunOwnerObservation | null>,
  notices: Awaited<ReturnType<typeof latestWorkflowNotices>>,
  scopeFallback: boolean,
  hold: HeldStarts['hold'],
  heldStarts: HeldStarts['heldStarts'],
  opts: { verbose?: boolean; rawEvents?: boolean; lost?: boolean }
): Promise<void> {
  const common = {
    ownerFilter: opts.lost ? 'unreachable' : null,
    scopeFallback,
    hold,
    heldStarts,
  };
  if (!opts.verbose) {
    await writeJsonLine({
      runs: runs.map(run => ({
        ...run,
        attention: runAttention(run),
        notice: notices.get(run.id) ?? null,
        owner: owners.get(run.id) ?? null,
      })),
      ...common,
    });
    return;
  }
  const runsOutput = await verboseStatusRuns(host, runs, opts.rawEvents);
  await writeJsonLine({
    runs: runsOutput.map(run => ({
      ...run,
      notice: notices.get(run.id) ?? null,
      owner: owners.get(run.id) ?? null,
    })),
    ...common,
  });
}

/** The text view: each run with its notice and owner, headed by what the listing was asked for. */
export async function printStatusText(
  host: WorkflowHost,
  runs: DashboardWorkflowRun[],
  owners: ReadonlyMap<string, RunOwnerObservation | null>,
  notices: Awaited<ReturnType<typeof latestWorkflowNotices>>,
  opts: { verbose?: boolean; lost?: boolean }
): Promise<void> {
  if (opts.lost) {
    console.log('Showing only runs whose recorded owner on this host does not answer (--lost).');
  }
  if (runs.length === 0) {
    console.log(opts.lost ? 'No active run has an unreachable owner.' : 'No active workflows.');
    return;
  }

  console.log(`\nActive workflows (${runs.length}):\n`);
  for (const run of runs) {
    await printStatusRun(host, run, opts.verbose, notices.get(run.id), owners.get(run.id));
  }
}
