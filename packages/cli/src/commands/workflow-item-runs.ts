/**
 * `--item <key>` on `workflow wait`, `cancel` and `abandon`: the item's project, its runs,
 * the refusals for when the item does not name exactly the runs to act on, and the item
 * forms of the three verbs. The engine never chooses between runs; an ambiguous item is
 * refused with its runs listed.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { readItemRuns } from '@archon/workflows/item-read';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { waitForItemAttention, type ItemRunWait } from '@archon/core/services/item-attention-watch';
import {
  isCancellableRun,
  type CancelWorkflowResult,
} from '@archon/core/operations/workflow-operations';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine, writeStderr } from '../utils/stdout';
import { announceWaitAttached, formatWaitOutcome, waitOutcomePayload } from './workflow-inspect';
import {
  abandonOneRun,
  cancelOneRun,
  cancelResultPayload,
  formatAbandonResult,
  printAbandonResult,
  printCancelResult,
  type AbandonResult,
} from './workflow-run-stop';
import {
  cliRefusalText,
  formatAge,
  getLog,
  inheritedWorkflowCodebase,
  jsonWriteError,
} from './workflow-shared';

export type RunsCodebase = Awaited<ReturnType<typeof findCodebaseForCheckoutPath>> | undefined;

/**
 * The project `workflow runs` lists: the chat-selected project, none with `--all`, else
 * the registered project of `cwd` (null when `cwd` is in none).
 */
export async function findRunsCodebase(
  host: WorkflowHost,
  cwd: string,
  opts: { all?: boolean }
): Promise<RunsCodebase | Error> {
  try {
    const inherited = await inheritedWorkflowCodebase(host, opts.all);
    if (inherited !== undefined || opts.all) return inherited;
    return await findCodebaseForCheckoutPath(cwd, host.records.codebases);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
    return new Error(`Failed to resolve workflow runs project: ${err.message}`, { cause: err });
  }
}

export type ItemVerb = 'wait' | 'cancel' | 'abandon';

export type ItemRunsRefusalReason =
  | 'no_project'
  | 'not_found'
  | 'unreadable'
  | 'no_run'
  | 'several_runs';

/** Why `--item` names no run to act on. `runs` lists the runs the operator chooses from. */
export class ItemRunsRefusal extends Error {
  constructor(
    readonly reason: ItemRunsRefusalReason,
    message: string,
    readonly runs: readonly WorkflowRun[] = []
  ) {
    super(message);
    this.name = 'ItemRunsRefusal';
  }
}

export interface ItemRuns {
  /** Re-reads the item's runs; refuses when the item or one of its runs no longer reads. */
  read: () => Promise<WorkflowRun[]>;
  /** The item's own runs, in start order. */
  runs: WorkflowRun[];
}

/**
 * The item `key` names in the project `workflow runs --item` reads, with every one of its
 * runs. An unreadable run refuses the whole item: it may be the run the verb applies to,
 * and acting on the readable ones would choose between runs.
 */
export async function resolveItemRuns(
  host: WorkflowHost,
  cwd: string,
  key: string,
  verb: ItemVerb
): Promise<ItemRuns> {
  const codebase = await findRunsCodebase(host, cwd, {});
  if (codebase instanceof Error) throw codebase;
  if (!codebase) {
    throw new ItemRunsRefusal(
      'no_project',
      "--item names an item in one registered project; run it from that project's checkout."
    );
  }
  const project = projectRefForCodebase(codebase);
  const read = async (): Promise<WorkflowRun[]> => {
    const found = await readItemRuns(host.deps.store, project.key, key);
    if (found === null)
      throw new ItemRunsRefusal('not_found', `No item '${key}' in project ${project.name}.`);
    if (found.degraded.length > 0) {
      const ids = found.degraded.map(report => report.runId).join(', ');
      throw new ItemRunsRefusal(
        'unreadable',
        `Run(s) ${ids} on item '${key}' could not be read, so the item's runs are not known. ` +
          `Act on each run by id: archon workflow ${verb} <run-id>.`
      );
    }
    return found.runs;
  };
  return { read, runs: await read() };
}

/**
 * The runs of `runs` the verb applies to: exactly one, or every one with `allRuns`.
 * None, or several without `allRuns`, is refused with the runs listed.
 */
export function selectItemRuns(
  runs: readonly WorkflowRun[],
  applies: (run: WorkflowRun) => boolean,
  opts: { key: string; verb: ItemVerb; statePhrase: string; allRuns?: boolean }
): WorkflowRun[] {
  const matching = runs.filter(applies);
  if (matching.length === 0) {
    throw new ItemRunsRefusal('no_run', `No ${opts.statePhrase} run on item '${opts.key}'.`, runs);
  }
  if (matching.length > 1 && !opts.allRuns) {
    throw new ItemRunsRefusal(
      'several_runs',
      `${String(matching.length)} runs on item '${opts.key}' are ${opts.statePhrase}; ` +
        `name one by id, or pass --all-runs to ${opts.verb} every one.`,
      matching
    );
  }
  return matching;
}

/** Report a refusal (or a failed item read) and return the exit status. */
export async function writeItemRefusal(
  error: unknown,
  verb: ItemVerb,
  key: string,
  json: boolean | undefined
): Promise<number> {
  const refusal = error instanceof ItemRunsRefusal ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    await writeJsonLine({
      ok: false,
      action: verb,
      item: key,
      ...(refusal ? { reason: refusal.reason } : {}),
      error: message,
      ...(refusal && refusal.runs.length > 0 ? { runs: refusal.runs.map(itemRunSummary) } : {}),
    });
    return 1;
  }
  const lines = [`Error: ${message}`, ...(refusal?.runs ?? []).map(itemRunLine)];
  await writeStderr(`${lines.join('\n')}\n`);
  return 1;
}

function itemRunSummary(run: WorkflowRun) {
  return {
    id: run.id,
    workflow: run.workflow_name,
    status: run.status,
    startedAt: run.started_at.toISOString(),
  };
}

function itemRunLine(run: WorkflowRun): string {
  return `  ${run.id}  ${run.status.padEnd(9)}  ${run.workflow_name}  (${formatAge(run.started_at)})`;
}

/** How the item form of cancel or abandon acts on one run, reusing the run-id form's parts. */
interface ItemRunAction<Result> {
  verb: 'cancel' | 'abandon';
  statePhrase: string;
  applies: (run: WorkflowRun) => boolean;
  act: (host: WorkflowHost, runId: string) => Promise<Result>;
  payload: (runId: string, result: Result) => object;
  print: (runId: string, result: Result) => void;
}

const CANCEL_ITEM_RUN: ItemRunAction<CancelWorkflowResult> = {
  verb: 'cancel',
  statePhrase: 'pending or running',
  applies: isCancellableRun,
  act: cancelOneRun,
  payload: cancelResultPayload,
  print: printCancelResult,
};

const ABANDON_ITEM_RUN: ItemRunAction<AbandonResult> = {
  verb: 'abandon',
  statePhrase: 'live',
  // The item's live work. A failed run or a cancelled run's cleanup retry is abandoned by
  // id: counting them would make almost every item with history ambiguous.
  applies: run => run.status === 'pending' || run.status === 'running' || run.status === 'paused',
  act: abandonOneRun,
  payload: formatAbandonResult,
  print: printAbandonResult,
};

export interface ItemControlOptions {
  json?: boolean;
  /** Act on every run the verb applies to instead of refusing when several do. */
  allRuns?: boolean;
}

/** `workflow cancel --item <key>`: cancel the item's pending or running run, or each with `allRuns`. */
export function workflowCancelItemCommand(
  host: WorkflowHost,
  key: string,
  cwd: string,
  opts: ItemControlOptions = {}
): Promise<number> {
  return runItemControl(host, key, cwd, opts, CANCEL_ITEM_RUN);
}

/** `workflow abandon --item <key>`: abandon the item's live run, or each with `allRuns`. */
export function workflowAbandonItemCommand(
  host: WorkflowHost,
  key: string,
  cwd: string,
  opts: ItemControlOptions = {}
): Promise<number> {
  return runItemControl(host, key, cwd, opts, ABANDON_ITEM_RUN);
}

/**
 * Act on the selected runs one at a time, in start order, exactly as the run-id form acts
 * on one, so a live owner is handled the same way. One run's failure does not stop the
 * rest; every run is reported, and the exit status is 1 when any failed.
 */
async function runItemControl<Result>(
  host: WorkflowHost,
  key: string,
  cwd: string,
  opts: ItemControlOptions,
  action: ItemRunAction<Result>
): Promise<number> {
  let selected: WorkflowRun[];
  try {
    const { runs } = await resolveItemRuns(host, cwd, key, action.verb);
    selected = selectItemRuns(runs, action.applies, {
      key,
      verb: action.verb,
      statePhrase: action.statePhrase,
      allRuns: opts.allRuns,
    });
  } catch (error) {
    return writeItemRefusal(error, action.verb, key, opts.json);
  }

  const results: object[] = [];
  let failed = false;
  for (const run of selected) {
    try {
      const result = await action.act(host, run.id);
      if (opts.json) results.push(action.payload(run.id, result));
      else action.print(run.id, result);
    } catch (error) {
      failed = true;
      if (opts.json) results.push(jsonWriteError(run.id, action.verb, error));
      else await writeStderr(`Error: ${cliRefusalText(error)}\n`);
    }
  }
  if (opts.json) await writeJsonLine({ ok: !failed, action: action.verb, item: key, results });
  return failed ? 1 : 0;
}

/**
 * `workflow wait --item <key>`: block until a run on the item needs attention, ends, loses
 * its owner, or reaches the deadline. Runs already ended at call time are history; a run
 * that starts on the item during the wait is watched too. Every run that settled is
 * reported by id, so nothing is chosen between. Exit codes as `workflowWaitCommand`.
 */
export async function workflowWaitItemCommand(
  host: WorkflowHost,
  key: string,
  cwd: string,
  { json, timeoutSeconds }: { json?: boolean; timeoutSeconds?: number } = {}
): Promise<number> {
  let results: ItemRunWait[];
  try {
    const item = await resolveItemRuns(host, cwd, key, 'wait');
    if (item.runs.every(run => TERMINAL_WORKFLOW_STATUSES.includes(run.status)))
      throw new ItemRunsRefusal('no_run', `No live run on item '${key}'.`, item.runs);
    results = await waitForItemAttention(host.deps.store, item.runs, item.read, {
      doorbell: host.doorbell,
      ...(timeoutSeconds === undefined ? {} : { deadlineMs: timeoutSeconds * 1000 }),
      onAttached: (runId, observedStatus, ownerLiveness) =>
        announceWaitAttached(runId, observedStatus, json, ownerLiveness),
    });
  } catch (error) {
    if (!(error instanceof ItemRunsRefusal))
      getLog().error({ err: error, item: key }, 'cli.workflow_wait_item_failed');
    return writeItemRefusal(error, 'wait', key, json);
  }

  const exitCode = waitItemExitCode(results);
  if (json) {
    await writeJsonLine({
      ok: exitCode !== 1,
      action: 'wait',
      item: key,
      results: results.map(({ runId, result }) => waitOutcomePayload(runId, runId, result)),
    });
  } else {
    for (const { runId, result } of results) console.log(formatWaitOutcome(runId, result));
  }
  return exitCode;
}

/** 0 when a run needs attention or lost its owner, 3 when the deadline came first, else 1. */
function waitItemExitCode(results: readonly ItemRunWait[]): number {
  if (results.some(({ result }) => result.kind === 'attention' || result.kind === 'owner_lost'))
    return 0;
  return results.some(({ result }) => result.kind === 'deadline') ? 3 : 1;
}
