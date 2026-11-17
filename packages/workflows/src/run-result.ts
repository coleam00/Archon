/**
 * A completed run's result as another run reads it: the `returns:` value its terminal
 * record holds, read from the database only, so it reads the same on every host. The
 * spill file of a text result past the output cap is never read.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { jsonValueSchema, type JsonValue } from './output-ref';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import type { RunPhase } from './executor-shared';
import type { ExecutionContext } from '@archon/provider-contract';
import { readCheckoutMark } from './checkout-mark';
import { sampleCheckout, type CheckoutSample } from './checkout-observation';
import type {
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowInputSpec,
  WorkflowRun,
} from './schemas';
import type { ResultCommit, TerminalRecord } from './schemas/terminal-record';
import { readSubrunMetadata, runInputsMetadata, SUBRUN_METADATA_KEYS } from './schemas';
import { splitAttentionRead } from './schemas/attention-degraded';
import type { IWorkflowStore } from './store';
import { getTerminalRecord, type TerminalRecordEvent } from './terminal-record';
import { requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.run-result');
  return cachedLog;
}

export type RunResultRead = { kind: 'result'; value: JsonValue } | { kind: 'none'; reason: string };

/**
 * The result `run` completed with. A run that did not complete has none, even when its
 * `returns:` node finished first. Throws when the terminal record does not parse: an
 * unreadable record is not "no result".
 */
export function readCompletedRunResult(
  run: Pick<WorkflowRun, 'status'>,
  events: readonly TerminalRecordEvent[]
): RunResultRead {
  if (run.status !== 'completed') return { kind: 'none', reason: `it is ${run.status}` };
  const record = getTerminalRecord(run.status, events);
  if (record === null) return { kind: 'none', reason: 'it has no terminal record' };
  const { returns } = record;
  switch (returns.availability) {
    case 'available':
      return { kind: 'result', value: jsonValueSchema.parse(returns.value) };
    case 'truncated':
      return {
        kind: 'none',
        reason: `its returns node '${returns.node_id}' output text past the output cap; declare output_format on it to make its result readable`,
      };
    case 'unavailable':
      return { kind: 'none', reason: `its result is unavailable (${returns.reason})` };
  }
}

/**
 * Where a result holds by one checkout sample: at the commit only when the checkout is a
 * clean git checkout. A validation that passed with an uncommitted or untracked file present
 * did not pass at the commit.
 */
export function resultCommitFromSample(sample: CheckoutSample): ResultCommit {
  const { observation } = sample;
  switch (observation.kind) {
    case 'not_git':
    case 'unavailable':
      return { held: false, reason: observation.kind };
    case 'git':
      if (observation.commit === null) return { held: false, reason: 'unborn' };
      if (!('worktree' in sample) || sample.worktree.status !== 'clean')
        return { held: false, reason: 'dirty' };
      return { held: true, commit: observation.commit };
  }
}

/**
 * The top-level `returns:` node, and what was observed when it completed: the checkout and
 * its mark, or that it ran beside other nodes, so the checkout it ended on may not be its
 * own. `startMark` is the checkout's mark when a run that takes no path lock began its
 * first pass: unset for a run that takes the lock, and on a resume, whose earlier pass
 * judged in a window no mark covers.
 */
export interface ReturnsCheckout {
  nodeId: string;
  startMark?: string | null;
  observed?: { sample: CheckoutSample; mark: string | null } | { concurrent: true };
}

/**
 * Sample the checkout the moment the top-level `returns:` node completes: the checkout its
 * result was given at. A node of a loop body or fan-out instance (a non-empty step prefix)
 * is never the run's `returns:` node, and a node replayed from an earlier pass is never
 * sampled: its checkout then is not observed. When another node of its concurrent phase
 * `mayRun` (it was dispatched, or its admission has not yet settled), it is not sampled
 * either: that sibling may have moved the checkout while it judged, and the engine cannot
 * tell that commit from one the node made itself.
 */
export async function observeReturnsCheckout(
  ctx: {
    returnsCheckout?: ReturnsCheckout;
    stepNamePrefix: string;
    cwd: string;
    execContext: ExecutionContext;
  },
  nodeId: string,
  output: { state: string },
  mayRun: ReadonlySet<string> | undefined
): Promise<void> {
  const held = ctx.returnsCheckout;
  if (held?.nodeId !== nodeId || ctx.stepNamePrefix !== '' || output.state !== 'completed') return;
  held.observed = [...(mayRun ?? [])].some(id => id !== nodeId)
    ? { concurrent: true }
    : await observeCheckout(ctx.cwd, ctx.execContext);
}

async function observeCheckout(
  cwd: string,
  execContext: ExecutionContext
): Promise<{ sample: CheckoutSample; mark: string | null }> {
  return {
    sample: await sampleCheckout(cwd, execContext),
    mark: await readCheckoutMark(cwd, execContext),
  };
}

/**
 * The commit a completing run's result holds at: the clean checkout its `returns:` node
 * completed on, only when nothing moved HEAD from then until the run completed. A node that
 * commits after the `returns:` node moves the checkout off the commit the result was given
 * at, so the result holds at no commit rather than at one it never judged. A run that takes
 * no path lock must also show HEAD never moved since its first pass began: another run may
 * move its checkout to another commit and back while it judges (#5769). `sampleCheckout`
 * never throws; a checkout it cannot read holds at no commit.
 */
export async function sampleResultCommit(
  run: {
    cwd: string;
    execContext: ExecutionContext;
    returnsCheckout?: ReturnsCheckout;
    workflow: Pick<ResolvedWorkflow, 'mutates_checkout'>;
    workflowRun: Pick<WorkflowRun, 'checkout_baseline'>;
  },
  workflowRunId: string
): Promise<ResultCommit> {
  const end = await observeCheckout(run.cwd, run.execContext);
  const given = heldThroughCompletion(run.returnsCheckout?.observed, end);
  const resultCommit =
    run.workflow.mutates_checkout === false
      ? heldSinceStart(given, run.workflowRun, run.returnsCheckout?.startMark, end.mark)
      : given;
  if (!resultCommit.held)
    getLog().info(
      { workflowRunId, reason: resultCommit.reason },
      'workflow.result_holds_at_no_commit'
    );
  return resultCommit;
}

/**
 * A run that declares `mutates_checkout: false` holds no path lock, so another run can
 * move its checkout while it judges. It never commits itself, so its result holds only at
 * the commit it started on, and only when HEAD never moved since its first pass began: a
 * move to another commit and back leaves the commit samples equal but changes the mark.
 */
function heldSinceStart(
  given: ResultCommit,
  run: Pick<WorkflowRun, 'checkout_baseline'>,
  startMark: string | null | undefined,
  endMark: string | null
): ResultCommit {
  if (!given.held) return given;
  const start = run.checkout_baseline;
  if (start?.kind !== 'git' || startMark == null || endMark === null)
    return { held: false, reason: 'unobserved' };
  return start.commit === given.commit && startMark === endMark
    ? given
    : { held: false, reason: 'moved' };
}

function heldThroughCompletion(
  atReturns: ReturnsCheckout['observed'],
  end: { sample: CheckoutSample; mark: string | null }
): ResultCommit {
  if (atReturns === undefined) return { held: false, reason: 'unobserved' };
  if ('concurrent' in atReturns) return { held: false, reason: 'concurrent' };
  const given = resultCommitFromSample(atReturns.sample);
  if (!given.held) return given;
  const ended = resultCommitFromSample(end.sample);
  if (!ended.held) return ended;
  if (atReturns.mark === null || end.mark === null) return { held: false, reason: 'unobserved' };
  return ended.commit === given.commit && atReturns.mark === end.mark
    ? given
    : { held: false, reason: 'moved' };
}

/** The commit a run's result holds at, or null: never any other commit in its place. */
export function resultCommitOf(
  record: Pick<TerminalRecord, 'result_commit'> | null
): string | null {
  const held = record?.result_commit;
  return held?.held ? held.commit : null;
}

/** A `result_of` input to fill: the workflow it names, and whether it reads at a commit. */
export interface ResultInputSpec {
  workflow: string;
  at: WorkflowInputSpec['at'];
}

/** What one input asks the item for: `at` is set only for an `at: checkout` input. */
export interface ResultRequest {
  workflow: string;
  /** The commit to read at; null when the run's checkout is at no commit. */
  at?: { commit: string | null };
}

/** Which run, if any, a `result_of` input read, and what it read. */
export interface LatestResult {
  runId: string | null;
  result: RunResultRead;
  /**
   * For a read at a commit: the latest completed run of the workflow, whichever commit it
   * holds at, so a reader that got nothing can say where the latest result holds.
   */
  latest?: { runId: string; holdsAt: ResultCommit | undefined };
}

type ItemResultStore = Pick<IWorkflowStore, 'getItemRuns' | 'listEventsForRuns'>;

/**
 * Fill each request from the item's completed runs, ordered by `completed_at` with a tie to
 * the run that started later. A plain request reads the latest completed run of its
 * workflow. A request at a commit reads the latest completed run whose result holds at that
 * commit, and never a run that holds elsewhere. No older run is read in place of the one
 * chosen, so an item run whose row does not read throws: it may be the one, and an
 * unreadable row names no workflow to rule it out.
 */
export async function latestResultsOnItem(
  store: ItemResultStore,
  item: { projectKey: string; key: string },
  requests: ReadonlyMap<string, ResultRequest>
): Promise<Map<string, LatestResult>> {
  const found = await store.getItemRuns(item.projectKey, item.key);
  if (found === null) throw new Error(`Item '${item.key}' was not found`);
  const { values: runs, degraded } = splitAttentionRead(found.runs);
  if (degraded.length > 0)
    throw new Error(
      `item runs ${degraded.map(report => report.runId).join(', ')} did not read, and any of them may be the latest`
    );
  const completed = completedByWorkflow(runs);
  // A plain request reads only the latest run; a request at a commit may read any of them.
  const read = [...requests.values()].flatMap(({ workflow, at }) =>
    (completed.get(workflow) ?? []).slice(at === undefined ? -1 : 0)
  );
  const events: ReadonlyMap<string, TerminalRecordEvent[]> =
    read.length === 0
      ? new Map()
      : await store.listEventsForRuns(
          [...new Set(read.map(run => run.id))],
          ['workflow_completed'],
          // A tolerant read turns a malformed record into an empty one, which reads as none.
          { strict: true }
        );
  const results = new Map<string, LatestResult>();
  for (const [input, { workflow, at }] of requests) {
    const of = completed.get(workflow) ?? [];
    const latest = of.at(-1);
    results.set(
      input,
      latest === undefined
        ? { runId: null, result: { kind: 'none', reason: 'no completed run on the item' } }
        : at === undefined
          ? resultOf(latest, events)
          : resultAt(of, latest, at.commit, events)
    );
  }
  return results;
}

/**
 * Completed runs by workflow, oldest first. Runs come in start order; a stable sort by
 * completion keeps a tie in start order, so the last run of a workflow is its latest.
 */
function completedByWorkflow(runs: readonly WorkflowRun[]): Map<string, WorkflowRun[]> {
  const completed = new Map<string, WorkflowRun[]>();
  for (const run of runs
    .filter(run => run.status === 'completed' && run.completed_at !== null)
    .sort((left, right) => Number(left.completed_at) - Number(right.completed_at)))
    completed.set(run.workflow_name, [...(completed.get(run.workflow_name) ?? []), run]);
  return completed;
}

function resultOf(
  run: WorkflowRun,
  events: ReadonlyMap<string, TerminalRecordEvent[]>
): LatestResult {
  return { runId: run.id, result: readCompletedRunResult(run, events.get(run.id) ?? []) };
}

/** The latest of `of` whose result holds at `commit`; never `latest` in its place. */
function resultAt(
  of: readonly WorkflowRun[],
  latest: WorkflowRun,
  commit: string | null,
  events: ReadonlyMap<string, TerminalRecordEvent[]>
): LatestResult {
  const recordOf = (run: WorkflowRun): TerminalRecord | null =>
    getTerminalRecord(run.status, events.get(run.id) ?? []);
  const held =
    commit === null
      ? undefined
      : [...of].reverse().find(run => resultCommitOf(recordOf(run)) === commit);
  return {
    ...(held !== undefined
      ? resultOf(held, events)
      : {
          runId: null,
          result: {
            kind: 'none',
            reason:
              commit === null
                ? "this run's checkout is at no commit"
                : `no completed run holds at ${commit}`,
          },
        }),
    latest: { runId: latest.id, holdsAt: recordOf(latest)?.result_commit },
  };
}

/** The declared `result_of` inputs a fresh run was not supplied, by input name. */
export function unsuppliedResultInputs(
  workflow: Pick<ResolvedWorkflow, 'inputs'>,
  startInputs: Readonly<Record<string, JsonValue>> | undefined
): Map<string, ResultInputSpec> {
  return new Map(
    Object.entries(workflow.inputs ?? {}).flatMap(([name, spec]) =>
      spec.result_of !== undefined && !Object.hasOwn(startInputs ?? {}, name)
        ? [[name, { workflow: spec.result_of, at: spec.at }] as const]
        : []
    )
  );
}

/**
 * A run whose `result_of` inputs were not supplied reads them from its item, so with no
 * item it is refused before it does any work. A `workflow:` child carries no item, so its
 * parent must pass such an input through `with:`.
 */
export async function refuseResultInputsWithoutItem(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  resultInputs: ReadonlyMap<string, ResultInputSpec>
): Promise<WorkflowExecutionResult | undefined> {
  const [first] = resultInputs;
  if (first === undefined || workflowRun.item_id !== null) return undefined;
  const [input, { workflow: source }] = first;
  const reason = `Workflow '${workflow.name}' reads input '${input}' from result_of '${source}', which resolves from the run's item: start it with --item <key>, or supply '${input}'`;
  await sendCriticalMessage(platform, conversationId, `❌ **Workflow not started**: ${reason}`);
  await requireTerminalStatusWrite(
    deps.store.cancelWorkflowRun(
      workflowRun.id,
      { cancel_reason: 'precondition_failed' },
      { pendingOnly: true }
    ),
    { workflowRunId: workflowRun.id, site: 'workflow.result_inputs_without_item_refused' }
  );
  return { success: false, workflowRunId: workflowRun.id, error: reason };
}

/** A commit as the start message names it. */
function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function holdsAtText(holdsAt: ResultCommit | undefined): string {
  if (holdsAt === undefined) return 'no commit (recorded before results held at commits)';
  return holdsAt.held ? shortCommit(holdsAt.commit) : `no commit (${holdsAt.reason})`;
}

/**
 * The start message's line for one input: which run it read, or why it is null. `latest`
 * is set only on a read at a commit, and `at` is that commit, null for a checkout at none.
 */
function readLine(
  input: string,
  workflowName: string,
  { runId, result, latest }: LatestResult,
  at: string | null
): string {
  const name = `\`${input}\``;
  const of = `\`${workflowName}\``;
  if (runId === null && latest === undefined)
    return `• ${name}: null, no completed run of ${of} on the item`;
  const holds = latest === undefined ? '' : `, which holds at ${shortCommit(at ?? '')}`;
  if (runId !== null)
    return result.kind === 'result'
      ? `• ${name}: result of ${of} run \`${runId}\`${holds}`
      : `• ${name}: null, the latest completed run of ${of}${holds}, \`${runId}\`, has no result: ${result.reason}`;
  const where =
    at === null
      ? "this run's checkout is at no commit"
      : `no completed run of ${of} holds at ${shortCommit(at)}`;
  return `• ${name}: null, ${where}; the latest, \`${String(latest?.runId)}\`, holds at ${holdsAtText(latest?.holdsAt)}`;
}

/**
 * Fill a claimed fresh run's unsupplied `result_of` inputs from its item and write them
 * into its `$INPUTS`, once, so a resume keeps them. An `at: checkout` input reads at the
 * commit of `checkout`, the run's starting checkout. Says on the run's conversation what
 * each input read. A store error, an unreadable item run or record fails the run.
 */
export async function resolveResultInputs(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  unsupplied: ReadonlyMap<string, ResultInputSpec>,
  checkout: CheckoutSample
): Promise<RunPhase<WorkflowRun>> {
  if (unsupplied.size === 0) return { stopped: false, value: workflowRun };
  // A dirty start still reads at its HEAD commit: a land merges commits, not worktree changes.
  const startCommit = checkout.observation.kind === 'git' ? checkout.observation.commit : null;
  try {
    // A run with no item was refused before its claim.
    const item = workflowRun.item_id ? await deps.store.getItem(workflowRun.item_id) : null;
    if (item === null) throw new Error(`Item '${String(workflowRun.item_id)}' was not found`);
    const results = await latestResultsOnItem(
      deps.store,
      item,
      new Map(
        [...unsupplied].map(([input, spec]) => [
          input,
          {
            workflow: spec.workflow,
            ...(spec.at === 'checkout' ? { at: { commit: startCommit } } : {}),
          },
        ])
      )
    );
    const resolved: Record<string, JsonValue> = {};
    const lines: string[] = [];
    const read: Record<string, { runId: string | null; at?: string | null }> = {};
    for (const [input, { workflow: workflowName, at }] of unsupplied) {
      const latest = results.get(input);
      if (latest === undefined) throw new Error(`No result read for '${input}'`);
      const { runId, result } = latest;
      // An `at: checkout` value carries the commit it holds at, so a land merges that
      // commit and not whatever its checkout is on by the time it acts.
      resolved[input] =
        result.kind !== 'result'
          ? null
          : at === 'checkout'
            ? { commit: String(startCommit), result: result.value }
            : result.value;
      read[input] = at === 'checkout' ? { runId, at: startCommit } : { runId };
      lines.push(readLine(input, workflowName, latest, startCommit));
    }
    const metadata = runInputsMetadata(
      { ...readSubrunMetadata(workflowRun.metadata).inputs, ...resolved },
      Object.hasOwn(workflowRun.metadata, SUBRUN_METADATA_KEYS.inputsValues)
    );
    await deps.store.updateWorkflowRun(workflowRun.id, { metadata });
    getLog().info({ workflowRunId: workflowRun.id, read }, 'workflow.result_inputs_resolved');
    await safeSendMessage(
      platform,
      conversationId,
      `Earlier results read from the item:\n${lines.join('\n')}`
    );
    return {
      stopped: false,
      value: { ...workflowRun, metadata: { ...workflowRun.metadata, ...metadata } },
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: workflowRun.id }, 'workflow.result_inputs_failed');
    const reason = `Unable to read the earlier results its result_of inputs name: ${err.message}`;
    await sendCriticalMessage(platform, conversationId, `❌ **Workflow failed**: ${reason}`);
    await requireTerminalStatusWrite(deps.store.failWorkflowRun(workflowRun.id, reason), {
      workflowRunId: workflowRun.id,
      site: 'workflow.result_inputs_failure_record_failed',
    });
    return {
      stopped: true,
      result: { success: false, workflowRunId: workflowRun.id, error: reason },
    };
  }
}
