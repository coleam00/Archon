import { reportedChildUsage, unreportedChildUsage } from '../../child-usage';
import { runOrStagePause, pauseGateRespectingExternalTransition } from '../../pause';
import { nodeInvocationKey } from '../../../node-record-reader';
import { finishNodeExecution } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import {
  type ExecutionDiagnostics,
  type NodeExecutionRecord,
  type NodeFailureKind,
} from '../../../schemas/node-execution';
import { describeUnfinishedFanOut, type FanOutOutcome } from '../../../schemas/fan-out-outcome';
import { recordDerivedExecution, recordNodeState } from '../../../node-event-write';
import { WorkflowSourceUnavailableError } from '../../../workflow-source';
import { spellWorkflowCommand } from '../../../deps';
import type { TokenUsage } from '@archon/provider-contract';
import type { WorkflowNode, FanOutConfig, WorkflowRun } from '../../../schemas';
import type { FanOutCancelReason } from '../../../store';
import {
  TerminalStatusWriteError,
  requireTerminalStatusWrite,
} from '../../../terminal-status-write';
import { type JsonValue } from '../../../output-ref';
import { mapWithHeldSlots } from '../../../utils/map-with-limit';
import { substituteWorkflowVariables } from '../../../workflow-variables';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { sumReportedCost, sumFanOutTokens } from '../../usage';
import { type ChildWorkflowOutcome, type RunChildWorkflowFn } from '../../child-run';
import { RunSourceUnreadableError, settledValuesOrThrow } from '../../node-source';
import { type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  nodeTemplateReferences,
  type ShellInputContext,
  resolveWorkflowValue,
} from '../../references';
import {
  classifyExistingChildren,
  fanOutItemInput,
  findAmbiguousChild,
  findFanOutChildRuns,
  hashFanOutItem,
  indexExistingChildren,
  settleFinishedHeldChildren,
  unclaimedIndices,
  type FanOutChildState,
} from './fan-out-children';
import { joinAllSuccess, joinFanOutOutcomes } from './fan-out-join';
import { buildFanOutOutcome } from './fan-out-outcome';

/**
 * Resolve `fan_out.items` → a JSON array. Workflow vars and $node.output refs, exactly as
 * the input surface resolves them. A `.field` ref that can't be honored throws an
 * OutputRefError → caught → fail closed. Never silently zero items: a resolution that
 * isn't a JSON array fails the node.
 */
function resolveFanOutItems(
  node: WorkflowNode,
  ctx: RunLayersContext,
  fanOut: FanOutConfig
): { items: unknown[] } | { error: string } {
  const parentRun = ctx.workflowRun;
  let parsedItems: unknown;
  try {
    const { prompt: itemsResolved } = substituteWorkflowVariables(
      fanOut.items,
      parentRun.id,
      parentRun.user_message ?? '',
      ctx.artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      undefined,
      undefined,
      undefined,
      { references: nodeTemplateReferences(fanOut.items, ctx) }
    );
    parsedItems = JSON.parse(itemsResolved);
  } catch (err) {
    return {
      error: `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`,
    };
  }
  if (!Array.isArray(parsedItems)) {
    return {
      error:
        `fan_out.items on '${node.id}' resolved to ${typeof parsedItems}, not a JSON array. ` +
        `'${fanOut.items}' must reference a node output that produces a JSON array.`,
    };
  }
  return { items: parsedItems };
}

/**
 * Resolve the node's static `with:` map (#2470) once — the same $INPUTS applied to EVERY
 * fan-out child. Per-item, the `fan_out.as` channel adds `$INPUTS.<as> = <item>` on top
 * (load-time collision-checked so `as` never overwrites a `with:` key). Resolved once
 * rather than per-child because the values don't depend on the item. Same three-tier
 * value resolution as the 1:1 path (#2637): literals typed, whole refs logical,
 * templates text.
 */
function resolveFanOutStaticInputs(
  node: WorkflowNode,
  ctx: RunLayersContext
): { inputs: Record<string, JsonValue> } | { error: string } {
  const parentRun = ctx.workflowRun;
  const inputs: Record<string, JsonValue> = {};
  const parentInputs = resolveRunInputs(parentRun);
  try {
    if (node.with !== undefined) {
      const resolutionCtx: ShellInputContext = {
        workflowRun: parentRun,
        artifactsDir: ctx.artifactsDir,
        stateDir: ctx.stateDir,
        baseBranch: ctx.baseBranch,
        docsDir: ctx.docsDir,
        issueContext: ctx.issueContext,
        nodeOutputs: ctx.nodeOutputs,
        loopBodyScopes: ctx.loopBodyScopes,
      };
      for (const [name, rawValue] of Object.entries(node.with)) {
        inputs[name] = resolveWorkflowValue(rawValue, resolutionCtx, parentInputs, false);
      }
    }
  } catch (err) {
    return {
      error: `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`,
    };
  }
  return { inputs };
}

/**
 * Spawn or re-drive every unsettled index through a `max_parallel` window, recording each
 * outcome in `state`. Returns the store error when a held-child lookup between rounds
 * fails.
 *
 * The window bounds UNFINISHED children, not only executing ones: a child that pauses
 * keeps its slot (#4044 D2), because it may hold half-done edits in a shared checkout,
 * and `max_parallel: 1` promises the children run one at a time. Items past a full
 * window get no run row until a held child finishes and the parent continues.
 */
async function driveChildWindow(
  itemCount: number,
  maxParallel: number,
  state: FanOutChildState,
  spawn: (index: number) => Promise<ChildWorkflowOutcome>,
  findChildren: () => Promise<WorkflowRun[]>,
  parentRunId: string
): Promise<{ lookupError: unknown } | undefined> {
  for (
    let waiting = unclaimedIndices(itemCount, state);
    waiting.length > 0 && state.heldByIndex.size < maxParallel;
    waiting = unclaimedIndices(itemCount, state)
  ) {
    const settled = await mapWithHeldSlots(
      waiting,
      maxParallel - state.heldByIndex.size,
      spawn,
      outcome => outcome.status === 'paused'
    );
    const claimed = settled.flatMap((result, k) =>
      result === undefined ? [] : [{ index: waiting[k], result }]
    );
    const outcomes = settledValuesOrThrow(
      claimed.map(c => c.result),
      parentRunId
    );
    claimed.forEach(({ index }, k) => {
      const outcome = outcomes[k];
      if (outcome.status === 'paused') state.heldByIndex.set(index, outcome.childRunId);
      else state.settledByIndex.set(index, outcome);
    });

    if (state.heldByIndex.size === 0) break;
    let rows: WorkflowRun[];
    try {
      rows = await findChildren();
    } catch (lookupError) {
      return { lookupError };
    }
    settleFinishedHeldChildren(rows, state);
  }
  return undefined;
}

/**
 * Some children are unfinished: pause the parent on them. Each child is its own run and
 * queue item, answered by its own run id; the engine never ends one for pausing. The
 * parent continues through `maybeResumeParentRun` once `isFanOutBlockReleased` holds,
 * re-enters as a continuation, and joins when no child is held.
 */
async function suspendOnHeldChildren(
  node: WorkflowNode,
  ctx: RunLayersContext,
  execution: NodeExecutionRecord,
  stepName: string,
  state: FanOutChildState,
  itemCount: number,
  notify: (text: string) => Promise<void>
): Promise<NodeExecutionResult> {
  const held = [...state.heldByIndex.entries()].sort(([a], [b]) => a - b);
  const unspawnedItems = unclaimedIndices(itemCount, state).length;
  const message =
    `fan_out node '${node.id}' is waiting on ${String(held.length)} unfinished sub-run(s) of ` +
    `'${node.workflow}': ${held.map(([i, id]) => `item ${String(i)}: run ${id}`).join(', ')}` +
    (unspawnedItems > 0 ? `; ${String(unspawnedItems)} item(s) not started yet` : '') +
    '. Answer each paused sub-run by its own run id; this run continues when they finish.';
  const suspended = finishNodeExecution(
    execution,
    { status: 'suspended', point: 'fan_out' },
    { output: { text: '' }, diagnostics: { fanOut: true } }
  );
  return runOrStagePause(
    ctx,
    async () => {
      const paused = await pauseGateRespectingExternalTransition(
        ctx.deps,
        ctx.workflowRun.id,
        {
          type: 'fan_out',
          nodeId: stepName,
          message,
          childRunIds: held.map(([, id]) => id),
          unspawnedItems,
        },
        { event: serializeNodeStateRecord(suspended), boundary: ctx.containerPause }
      );
      if (!paused) return serializeNodeOutput(execution);
      await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
      await notify(
        `⏸ **Waiting on sub-runs** (node \`${node.id}\`): ${message} ` +
          `See them with \`${spellWorkflowCommand(ctx.platform, 'status')}\`.`
      );
      return serializeNodeOutput(suspended);
    },
    () => serializeNodeOutput(execution)
  );
}

/**
 * Execute a fan-out `workflow:` node (#2121 slice 2, PR-C): expand the node into N
 * governed child runs over a data-driven item list, bound by a `max_parallel` sliding
 * window, and reduce the N child outcomes into one node outcome via the declared
 * `join`. This is the slice-1 1:1 sub-run re-entry table generalized to 1:N, keyed by
 * `metadata.child_index`:
 *   - resolve `fan_out.items` → a JSON array (fail closed on non-array/malformed);
 *   - re-inspect existing children (findChildRuns by parent_node_id) by child_index, so
 *     re-entry skips completed instances. A recovery (resuming a failed node) re-drives
 *     failed and fan-out-cancelled children; a continuation (re-entry after this node
 *     paused on its children) threads every settled child as it is;
 *   - spawn/re-drive the unsettled indices through a `max_parallel` window in which a
 *     paused child keeps its slot (mapWithHeldSlots);
 *   - a child that PAUSES stays paused as its own run and queue item (#4044). While any
 *     child is unfinished, the parent pauses on a `fan_out` gate listing them, and
 *     re-enters here when they finish. A `running`/`pending` child found on a recovery is
 *     ambiguous → the node fails WITHOUT auto-cancel (AGENTS.md "Do not guess lifecycle
 *     ownership"), surfacing a staleness-keyed wait/abandon action;
 *   - EVERY index is spawned and every child runs to its own terminal state — no child's
 *     outcome ends another's — and only then does the join reduce: `all_success` (any
 *     failed/cancelled child fails the node) / `all_done` (aggregate all terminal if a
 *     child run exists; failed/cancelled entries represented);
 *   - aggregate `$<id>.output` = JSON array in item order; cost/tokens = Σ children.
 *
 * Execution failures return a failed NodeExecutionResult; lifecycle persistence
 * rejection escapes to the run failure boundary. `node_completed` is written ONLY when the join is
 * satisfied, so a paused or failed fan-out node re-runs and re-inspects its children on
 * re-entry against the durable child-run rows.
 */
export async function executeFanOutWorkflowNode(
  node: WorkflowNode,
  ctx: RunLayersContext,
  fanOut: FanOutConfig,
  runChild: RunChildWorkflowFn,
  execution: NodeExecutionRecord
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, cwd, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };
  const stepName = ctx.stepNamePrefix + node.id;
  let tokensUnknown = false;
  let childUsage: ExecutionDiagnostics['childUsage'];

  // node_failed writer (mirrors executeWorkflowNode.failResult) — a fan-out failure may
  // still carry accumulated cost/tokens so spend over already-run children is tracked.
  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    diagnostics: Omit<ExecutionDiagnostics, 'fanOut'> = {}
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'failed', error, failureKind },
        {
          output: { text: '' },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { fanOut: true, childUsage, ...diagnostics },
        }
      )
    );
  };

  // node_completed writer (mirrors executeWorkflowNode.asCompleted) — written ONLY when
  // the join is satisfied, so getCompletedDagNodeOutputs skips a finished fan-out node
  // on resume but re-runs an unfinished one (which re-inspects children by child_index).
  const writeCompleted = async (
    output: string,
    costUsd?: number,
    tokens?: TokenUsage,
    structured?: unknown,
    fanOutOutcome?: FanOutOutcome
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: { text: output, ...(structured !== undefined ? { structured } : {}) },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: {
            fanOut: true,
            childUsage,
            ...(fanOutOutcome !== undefined ? { fanOutOutcome } : {}),
          },
        }
      )
    );
  };

  // Notify the platform immediately of a fan-out failure or pause (S3). Every early-failure
  // branch uses this — items resolution, the child-lookup errors, the ambiguous-child
  // check and the join — so a fan-out failure never reaches the user through the
  // end-of-run digest alone.
  const notify = async (text: string): Promise<void> => {
    await safeSendMessage(platform, conversationId, text, msgContext);
  };

  const failConfig = async (msg: string): Promise<NodeExecutionResult> => {
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  };

  const failChildLookup = async (error: unknown): Promise<NodeExecutionResult> => {
    const msg = `Failed to look up fan-out child runs for node '${node.id}': ${(error as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
  };

  // Cancel a child the fan-out path OWNS, stamping WHY (C2/I4) so the cancel is
  // attributable AND — unlike a user's out-of-band cancel — recoverable on resume.
  let childCancellationFailure: TerminalStatusWriteError | undefined;
  const cancelChild = async (childId: string, reason: FanOutCancelReason): Promise<void> => {
    if (!childId) return;
    try {
      await requireTerminalStatusWrite(deps.store.cancelFanOutRun(childId, reason), {
        workflowRunId: childId,
        site: 'dag.fan_out_cancel',
      });
    } catch (error) {
      if (error instanceof TerminalStatusWriteError) childCancellationFailure = error;
      throw error;
    }
  };

  // 1. Resolve the item list and the static `with:` inputs.
  const resolvedItems = resolveFanOutItems(node, ctx, fanOut);
  if ('error' in resolvedItems) return failConfig(resolvedItems.error);
  const { items } = resolvedItems;
  const staticInputs = resolveFanOutStaticInputs(node, ctx);
  if ('error' in staticInputs) return failConfig(staticInputs.error);

  // 2. Empty array → a valid zero-width expansion (#977 acceptance): complete with '[]'.
  if (items.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.fan_out_empty');
    return writeCompleted('[]', undefined, undefined, []);
  }

  // 3. Re-entry: index this node's existing children by child_index.
  let existingByIndex: Map<number, WorkflowRun>;
  try {
    existingByIndex = await indexExistingChildren(
      deps.store,
      parentRun.id,
      node,
      stepName,
      items,
      childId => cancelChild(childId, 'fan_out_orphan')
    );
  } catch (err) {
    if (err instanceof TerminalStatusWriteError) throw err;
    // Notify like every other early-failure branch — this one was the odd one out, so a
    // store error was the single fan-out failure that reached the user only via the
    // end-of-run digest.
    return failChildLookup(err);
  }

  // 4. Classify the existing children (#4044 D3). The node's own latest lifecycle record
  //    tells a CONTINUATION — this node paused on its children, and one of them finished —
  //    from a RECOVERY: an operator resuming a failed node, a crash, or a first run.
  //    A continuation threads every settled child as it is, so a sibling that failed in
  //    the first pass gets no free re-drive because another child paused. A recovery
  //    re-drives failed and fan-out-cancelled children, as resume-through-parent always did.
  //    A paused child is HELD in either mode: it keeps waiting for its own answer and keeps
  //    its `max_parallel` slot. A `running`/`pending` child is held in a continuation (the
  //    continuation host may be driving it after an answer), but is ambiguous in a
  //    recovery — a crash-orphan or a live run in another process. Per AGENTS.md "Do not
  //    guess lifecycle ownership" the node then fails WITHOUT cancelling it.
  const prior = ctx.unfinishedInvocations?.get(
    nodeInvocationKey(stepName, ctx.loopGroupPath)
  )?.lifecycle;
  const continuing = prior?.status === 'suspended' && prior.point === 'fan_out';
  const ambiguous = continuing
    ? undefined
    : findAmbiguousChild(existingByIndex, parentRun.id, node);
  if (ambiguous !== undefined) {
    await notify(
      `⚠️ **Fan-out blocked** (node \`${node.id}\`): ${ambiguous.message} ` +
        `Abandon: \`${spellWorkflowCommand(platform, `abandon ${ambiguous.child.id}`)}\``
    );
    return failResult(ambiguous.message, 'unknown', undefined, undefined, {
      blockedOnChildRunId: ambiguous.child.id,
    });
  }
  const state = classifyExistingChildren(existingByIndex, continuing);

  if (ctx.priorCompletedNodes !== undefined && existingByIndex.size === 0) {
    await notify(
      `Re-driving fan_out node '${node.id}': no child run rows exist for its ${String(items.length)} children. ` +
        'Resume uses the captured parent source; changes to that source require a fresh launch.'
    );
  }

  // 5. Spawn or re-drive every unsettled index through a `max_parallel` window. A failed
  //    or fan-out-cancelled existing child is re-driven in a recovery; a missing index
  //    spawns fresh.
  //
  //    No child's outcome terminates another's. Every child runs to its OWN terminal state
  //    before the join reduces — a fan-out is N independent governed runs that happen to
  //    be siblings, not a competition. An earlier revision fail-fasted here, deciding one
  //    child's fate from another's, which is not the engine's call to make.
  //
  //    `max_parallel` bounds concurrency, not total spend — a wide fan-out whose first
  //    child fails still runs every remaining child. The workflow `budget:` does not cover
  //    fan-out yet; a budgeted workflow rejects it at load (#2815).
  const spawn = async (i: number): Promise<ChildWorkflowOutcome> => {
    // A rolled-back cancellation has not released the child's working-path lock.
    // Let claimed siblings settle, but do not start another child against that lock.
    if (childCancellationFailure) throw childCancellationFailure;
    const item = items[i];
    const existing = existingByIndex.get(i);
    const input = fanOutItemInput(item);
    // Per-child $INPUTS (#2470): the static `with:` map plus the per-item `fan_out.as`
    // channel (the item value under `$INPUTS.<as>`). `as` is load-time guaranteed not to
    // collide with a `with:` key, so this spread order is unambiguous. The item travels
    // LOGICALLY under `as` (#2637 — an object item stays an object for the child);
    // `fanOutItemInput`'s text form remains the `$ARGUMENTS`/item-hash channel.
    const childInputs: Record<string, JsonValue> = {
      ...staticInputs.inputs,
      ...(fanOut.as !== undefined ? { [fanOut.as]: item as JsonValue } : {}),
    };
    const resumeChild =
      existing?.status === 'failed'
        ? ({ kind: 'failed', run: existing } as const)
        : existing?.status === 'cancelled'
          ? ({ kind: 'fan-out-cancelled', run: existing } as const)
          : undefined;
    return runChild({
      parentRun,
      nodeId: stepName,
      childWorkflowName: node.workflow,
      input,
      cwd,
      conversationId,
      userId: parentRun.user_id ?? undefined,
      codebaseId: parentRun.codebase_id ?? undefined,
      isolation: node.isolation,
      childIndex: i,
      itemHash: hashFanOutItem(input),
      ...(Object.keys(childInputs).length > 0 ? { inputs: childInputs } : {}),
      ...(resumeChild ? { resumeChild } : {}),
    }).catch((error: unknown) => {
      if (error instanceof WorkflowSourceUnavailableError)
        throw new RunSourceUnreadableError(stepName, error);
      if (error instanceof TerminalStatusWriteError) childCancellationFailure = error;
      throw error;
    });
  };

  const windowFailure = await driveChildWindow(
    items.length,
    fanOut.max_parallel === 'all' ? items.length : fanOut.max_parallel,
    state,
    spawn,
    () => findFanOutChildRuns(deps.store, parentRun.id, stepName),
    parentRun.id
  );
  if (windowFailure !== undefined) return failChildLookup(windowFailure.lookupError);

  // 6. Some children are unfinished: pause the parent on them.
  if (state.heldByIndex.size > 0) {
    return suspendOnHeldChildren(node, ctx, execution, stepName, state, items.length, notify);
  }

  const outcomes = items.map((_, i) => {
    const outcome = state.settledByIndex.get(i);
    if (outcome === undefined) {
      throw new Error(`fan_out node '${node.id}': item ${String(i)} has no settled outcome`);
    }
    return outcome;
  });

  childUsage = outcomes.map(reportedChildUsage);
  const unreported = outcomes.map(outcome =>
    unreportedChildUsage(outcome, ctx.reportedChildUsage, outcome.childRunId)
  );
  const usage = {
    costUsd: sumReportedCost(unreported),
    tokens: sumFanOutTokens(unreported),
    tokensUnknown: unreported.some(outcome => outcome.tokensUnknown === true),
  };
  const totalCostUsd = usage.costUsd;
  const totalTokens = usage.tokens;
  tokensUnknown = usage.tokensUnknown === true;

  return joinSettledChildren(node, ctx, fanOut.join, stepName, outcomes, {
    notify,
    fail: (error, failureKind, diagnostics) =>
      failResult(error, failureKind, totalCostUsd, totalTokens, diagnostics),
    complete: (elements, fanOutOutcome) =>
      writeCompleted(JSON.stringify(elements), totalCostUsd, totalTokens, elements, fanOutOutcome),
  });
}

/** How a settled fan-out reports: the node's own writers, bound to its spend. */
interface SettledFanOutWriters {
  notify: (text: string) => Promise<void>;
  fail: (
    error: string,
    failureKind: NodeFailureKind,
    diagnostics?: { fanOutOutcome: FanOutOutcome }
  ) => Promise<NodeExecutionResult>;
  complete: (elements: JsonValue[], fanOutOutcome: FanOutOutcome) => Promise<NodeExecutionResult>;
}

/**
 * Every child is terminal: classify each slot from its durable child row, reduce through
 * the join, and write the node's outcome with its slot record. A read failure fails the
 * node without leaving a live child owned, because no child is live any more.
 */
async function joinSettledChildren(
  node: WorkflowNode,
  ctx: RunLayersContext,
  join: FanOutConfig['join'],
  stepName: string,
  outcomes: readonly ChildWorkflowOutcome[],
  writers: SettledFanOutWriters
): Promise<NodeExecutionResult> {
  const parentRunId = ctx.workflowRun.id;
  const built = await buildFanOutOutcome(ctx.deps.store, parentRunId, stepName, outcomes);
  if ('lookupError' in built) {
    const msg = `Failed to look up settled fan-out child runs for node '${node.id}': ${(built.lookupError as Error).message}`;
    // `all_success` names its failing child without the slot record, so a read failure
    // must not replace that child-attributed failure with an anonymous one.
    const joined = join === 'all_success' ? joinAllSuccess(parentRunId, node, outcomes) : undefined;
    if (joined?.status === 'failed') {
      await writers.notify(joined.notice);
      return writers.fail(`${joined.error} (${msg})`, joined.failureKind);
    }
    await writers.notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return writers.fail(msg, 'unknown');
  }
  const { outcome: fanOutOutcome } = built;
  const { tally } = fanOutOutcome;

  const joined = joinFanOutOutcomes(parentRunId, node, join, outcomes, fanOutOutcome.slots);
  if (joined.status === 'failed') {
    if (tally.not_started > 0) {
      getLog().warn(
        { parentRunId, nodeId: node.id, ...tally },
        'workflow.fan_out_slots_not_started'
      );
    }
    await writers.notify(joined.notice);
    return writers.fail(joined.error, joined.failureKind, { fanOutOutcome });
  }
  const completed = await writers.complete(joined.elements, fanOutOutcome);
  // The node completed by its join; the qualification goes out only after that durable
  // write, through a notifier that never throws, so delivery cannot fail completed work.
  if (tally.completed < tally.total) {
    getLog().warn(
      { parentRunId, nodeId: node.id, ...tally },
      'workflow.fan_out_completed_with_unfinished_children'
    );
    await writers.notify(
      `⚠️ **Fan-out completed with unfinished children** (node \`${node.id}\`): ` +
        `${describeUnfinishedFanOut(tally)}. ` +
        `Each slot's outcome is in the console run view and \`archon workflow get ${parentRunId}\`.`
    );
  }
  return completed;
}
