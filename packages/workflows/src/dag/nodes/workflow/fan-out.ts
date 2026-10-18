import { pauseGateRespectingExternalTransition } from '../../pause';
import { nodeInvocationKey } from '../../../node-record-reader';
import { finishNodeExecution } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import { type NodeExecutionRecord, type NodeFailureKind } from '../../../schemas/node-execution';
import { recordDerivedExecution, recordNodeState } from '../../../node-event-write';
import { WorkflowSourceUnavailableError } from '../../../workflow-source';
import type { WorkflowDeps } from '../../../deps';
import { spellWorkflowCommand } from '../../../deps';
import type { TokenUsage } from '@archon/provider-contract';
import type { WorkflowNode, FanOutConfig, WorkflowRun } from '../../../schemas';
import { readSubrunMetadata, isTerminalRunStatus } from '../../../schemas';
import { FAN_OUT_CANCEL_REASONS } from '../../../store';
import type { FanOutCancelReason } from '../../../store';
import {
  TerminalStatusWriteError,
  requireTerminalStatusWrite,
} from '../../../terminal-status-write';
import { canonicalValueText, type JsonValue } from '../../../output-ref';
import { mapWithHeldSlots } from '../../../utils/map-with-limit';
import { substituteWorkflowVariables, safeSendMessage } from '../../../executor-shared';
import { getLog } from '../../log';
import { sumFanOutCost, sumFanOutTokens } from '../../usage';
import {
  childOutcomeFromRun,
  type ChildWorkflowOutcome,
  type RunChildWorkflowFn,
} from '../../child-run';
import { RunSourceUnreadableError, settledValuesOrThrow } from '../../node-source';
import { type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  nodeTemplateReferences,
  type ShellInputContext,
  resolveWorkflowValue,
} from '../../references';

/**
 * The child's terminal LOGICAL value as a fan-out aggregate element: prefer the typed
 * `structuredOutput` (#2637); fall back to parsing the text summary, and keep non-JSON
 * text as the raw string, since a string IS what the child returned.
 */
function subrunLogicalValue(outcome: ChildWorkflowOutcome): unknown {
  if (outcome.structuredOutput !== undefined) return outcome.structuredOutput;
  try {
    return JSON.parse(outcome.output ?? '') as unknown;
  } catch {
    return outcome.output ?? '';
  }
}

/**
 * `metadata.cancelled_reason` values the fan-out path stamps on children it cancels
 * ITSELF (so the cancel is attributable and — unlike a user's out-of-band cancel —
 * recoverable on resume). `fan_out_orphan`: a child whose `child_index` fell out of range
 * when the item list shrank. `fan_out_checkout_check`: a child whose path-lock or
 * checkout-sharing store access failed before it ran any node (executor.ts).
 *
 * `fan_out_sibling` and `fan_out_gate` are READ-ONLY legacy. `fan_out_sibling` marked an
 * in-flight sibling cancelled once an earlier revision's fail-fast sealed the node's fate;
 * `fan_out_gate` marked a child cancelled because it paused, before a paused child could
 * wait as its own run (#4044). Nothing writes either any more. They stay in the type and
 * in the recoverable set on purpose: a run from before the upgrade has rows carrying
 * them, and dropping them would make those children read as user-cancelled — terminal,
 * never re-driven, so the parent would fail every resume with no way back. Delete them
 * only once no resumable run can predate the change.
 */
const FAN_OUT_RECOVERABLE_CANCEL_REASONS: ReadonlySet<string> = new Set(FAN_OUT_CANCEL_REASONS);

/**
 * A `running`/`pending` child found on re-entry is ambiguous: a crash-orphan of a prior
 * pass, or a live execution in another process. Past this idle window (no
 * `last_activity_at` heartbeat — written ≤ every 60s while a child runs) it reads as an
 * orphan; within it, as possibly still live. Only the MESSAGE differs — per AGENTS.md
 * "Do not guess lifecycle ownership", NEITHER branch cancels.
 */
const FAN_OUT_CHILD_STALE_MS = 5 * 60_000;

/** The fan-out cancel reason stamped on a child, if any. */
function fanOutCancelReason(run: WorkflowRun): string | undefined {
  const reason = (run.metadata as Record<string, unknown> | undefined)?.cancelled_reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** True when a cancelled child was cancelled BY the fan-out path → recoverable on resume. */
function isFanOutRecoverableCancel(run: WorkflowRun): boolean {
  const reason = fanOutCancelReason(run);
  return reason !== undefined && FAN_OUT_RECOVERABLE_CANCEL_REASONS.has(reason);
}

/** True when a `running`/`pending` child has had no activity within the idle window. */
function isFanOutChildStale(run: WorkflowRun, now = Date.now()): boolean {
  const last = run.last_activity_at ?? run.started_at;
  return last === null || now - last.getTime() > FAN_OUT_CHILD_STALE_MS;
}

/**
 * Cheap, dependency-free content hash (djb2) of a fan-out child's input string, stamped
 * at spawn so resume can detect a non-deterministic items producer (same index, changed
 * content) and WARN (never re-key). Collision-tolerant: a warn-only signal, not identity.
 */
function hashFanOutItem(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i);
  return (h >>> 0).toString(16);
}

/**
 * A `running`/`pending` fan-out child found on re-entry — ambiguous ownership, so NOT
 * auto-cancelled (AGENTS.md "Do not guess lifecycle ownership"). Names the state and the
 * run to act on, with wording keyed to `last_activity_at` staleness (fresh → likely live;
 * stale → likely orphaned). This text is persisted as the node failure and read on every surface, so it
 * names the run in full and leaves the abandon command to whichever surface renders it.
 */
function fanOutAmbiguousChildMessage(
  node: WorkflowNode,
  child: WorkflowRun,
  index: number,
  stale: boolean
): string {
  const ref = `child ${String(index)} (run ${child.id.slice(0, 8)})`;
  return stale
    ? `fan_out node '${node.id}': ${ref} of '${node.workflow}' is still '${child.status}' with no ` +
        'recent activity — it appears orphaned by an interrupted run. Abandon run ' +
        `${child.id}, then resume the parent to re-drive it.`
    : `fan_out node '${node.id}': ${ref} of '${node.workflow}' may still be running (recent activity) — ` +
        `wait for it to finish and resume, or abandon run ${child.id} if it is stuck.`;
}

export async function findFanOutChildRuns(
  store: WorkflowDeps['store'],
  parentRunId: string,
  nodePath: string
): Promise<WorkflowRun[]> {
  return (await store.findChildRuns(parentRunId)).filter(
    child => readSubrunMetadata(child.metadata).parentNodeId === nodePath
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

  // node_failed writer (mirrors executeWorkflowNode.failResult) — a fan-out failure may
  // still carry accumulated cost/tokens so spend over already-run children is tracked.
  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    blockedOnChildRunId?: string
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
          diagnostics: {
            fanOut: true,
            ...(blockedOnChildRunId !== undefined ? { blockedOnChildRunId } : {}),
          },
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
    structured?: unknown
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
          diagnostics: { fanOut: true },
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

  // Item → child input/$ARGUMENTS (canonical value text: strings raw, objects JSON).
  // Also the pre-image for the resume item-hash (S2) — identity unchanged by #2637,
  // since canonicalValueText is byte-identical to the previous inline mapping.
  const itemToInput = (item: unknown): string => canonicalValueText(item);

  // 1. Resolve `fan_out.items` → a JSON array. Workflow vars and $node.output refs,
  //    exactly as the input surface resolves them. A `.field` ref that
  //    can't be honored throws an OutputRefError → caught → fail closed. Never silently
  //    zero items: a resolution that isn't a JSON array fails the node.
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
    const msg = `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }

  if (!Array.isArray(parsedItems)) {
    const msg =
      `fan_out.items on '${node.id}' resolved to ${typeof parsedItems}, not a JSON array. ` +
      `'${fanOut.items}' must reference a node output that produces a JSON array.`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }
  const items: unknown[] = parsedItems;

  // Resolve the node's static `with:` map (#2470) once — the same $INPUTS applied to EVERY
  // fan-out child. Per-item, the `fan_out.as` channel adds `$INPUTS.<as> = <item>` on top
  // (load-time collision-checked so `as` never overwrites a `with:` key). Resolved here
  // rather than per-child because the values don't depend on the item. Same three-tier
  // value resolution as the 1:1 path (#2637): literals typed, whole refs logical,
  // templates text.
  const fanOutStaticInputs: Record<string, JsonValue> = {};
  const parentInputs = resolveRunInputs(parentRun);
  try {
    if (node.with !== undefined) {
      const fanOutResolutionCtx: ShellInputContext = {
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
        fanOutStaticInputs[name] = resolveWorkflowValue(
          rawValue,
          fanOutResolutionCtx,
          parentInputs,
          false
        );
      }
    }
  } catch (err) {
    const msg = `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }

  // 2. Empty array → a valid zero-width expansion (#977 acceptance): complete with '[]'.
  if (items.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.fan_out_empty');
    return writeCompleted('[]', undefined, undefined, []);
  }

  // 3. Re-entry: find THIS node's existing children (a parent may run several workflow
  //    nodes → filter by parent_node_id) and index them by metadata.child_index. Empty
  //    on the first run; carries the ordered instance set on resume.
  const existingByIndex = new Map<number, WorkflowRun>();
  try {
    const children = await findFanOutChildRuns(deps.store, parentRun.id, stepName);
    for (const child of children) {
      const meta = readSubrunMetadata(child.metadata as Record<string, unknown> | undefined);
      const idx = meta.childIndex;
      // A child of THIS node with no `child_index`: it was spawned when the node was a 1:1
      // sub-run (that path stamps `parent_node_id` and no index), and the node has since
      // grown a `fan_out:`. Dropping it silently left a live, billing, untracked child that
      // nothing would ever cancel — so it gets the same treatment as an out-of-range index.
      if (idx === undefined) {
        getLog().warn(
          {
            parentRunId: parentRun.id,
            nodeId: node.id,
            childRunId: child.id,
            status: child.status,
          },
          'workflow.fan_out_child_missing_index'
        );
        if (child.status === 'running' || child.status === 'pending' || child.status === 'paused') {
          await cancelChild(child.id, 'fan_out_orphan');
        }
        continue;
      }
      // I2: a child_index beyond the (now-shorter) item list — the items producer shrank
      // between attempts. Never silently dropped: WARN for visibility, and cancel a
      // still-live orphan (tagged) so it stops billing (a terminal one no-ops).
      if (idx < 0 || idx >= items.length) {
        getLog().warn(
          {
            parentRunId: parentRun.id,
            nodeId: node.id,
            childRunId: child.id,
            childIndex: idx,
            itemCount: items.length,
          },
          'workflow.fan_out_child_index_out_of_range'
        );
        if (child.status === 'running' || child.status === 'pending' || child.status === 'paused') {
          await cancelChild(child.id, 'fan_out_orphan');
        }
        continue;
      }
      // S4: a duplicate child_index (two rows for one index) is anomalous — last write
      // wins (as the 1:1 precedent does), but log it rather than swallow it silently.
      if (existingByIndex.has(idx)) {
        getLog().debug(
          { parentRunId: parentRun.id, nodeId: node.id, childIndex: idx, childRunId: child.id },
          'workflow.fan_out_duplicate_child_index'
        );
      }
      // S2: a non-deterministic items producer may have changed the item at this index
      // between attempts. Resume still re-keys by index (safe under the cached-output
      // invariant), but WARN so the content drift is visible.
      const priorHash = meta.fanOutItemHash;
      if (priorHash !== undefined && priorHash !== hashFanOutItem(itemToInput(items[idx]))) {
        getLog().warn(
          { parentRunId: parentRun.id, nodeId: node.id, childIndex: idx, childRunId: child.id },
          'workflow.fan_out_item_content_changed'
        );
      }
      existingByIndex.set(idx, child);
    }
  } catch (err) {
    if (err instanceof TerminalStatusWriteError) throw err;
    // Notify like every other early-failure branch — this one was the odd one out, so a
    // store error was the single fan-out failure that reached the user only via the
    // end-of-run digest.
    const msg = `Failed to look up fan-out child runs for node '${node.id}': ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
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
  if (!continuing) {
    const ambiguous = [...existingByIndex.entries()].filter(
      ([, c]) => c.status === 'running' || c.status === 'pending'
    );
    if (ambiguous.length > 0) {
      const [index, child] = ambiguous[0];
      const stale = isFanOutChildStale(child);
      getLog().warn(
        {
          parentRunId: parentRun.id,
          nodeId: node.id,
          childRunId: child.id,
          childIndex: index,
          status: child.status,
          stale,
        },
        'workflow.fan_out_child_nonterminal_on_resume'
      );
      const msg = fanOutAmbiguousChildMessage(node, child, index, stale);
      await notify(
        `⚠️ **Fan-out blocked** (node \`${node.id}\`): ${msg} ` +
          `Abandon: \`${spellWorkflowCommand(platform, `abandon ${child.id}`)}\``
      );
      return failResult(msg, 'unknown', undefined, undefined, child.id);
    }
  }

  const settledByIndex = new Map<number, ChildWorkflowOutcome>();
  /** Child run id of every held (non-terminal) child, by item index. */
  const heldByIndex = new Map<number, string>();
  for (const [index, child] of existingByIndex) {
    switch (child.status) {
      case 'paused':
      case 'running':
      case 'pending':
        heldByIndex.set(index, child.id);
        break;
      case 'completed':
        settledByIndex.set(index, childOutcomeFromRun(child));
        break;
      case 'failed':
        if (continuing) settledByIndex.set(index, childOutcomeFromRun(child));
        break;
      case 'cancelled':
        // A user-cancelled child (no fan-out tag) is terminal in either mode — it fails
        // all_success and is represented in all_done.
        if (continuing || !isFanOutRecoverableCancel(child)) {
          settledByIndex.set(index, childOutcomeFromRun(child));
        }
        break;
    }
  }

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
  //    The window bounds UNFINISHED children, not only executing ones: a child that pauses
  //    keeps its slot (#4044 D2), because it may hold half-done edits in a shared checkout,
  //    and `max_parallel: 1` promises the children run one at a time. Items past a full
  //    window get no run row until a held child finishes and the parent continues.
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
    const input = itemToInput(item);
    // Per-child $INPUTS (#2470): the static `with:` map plus the per-item `fan_out.as`
    // channel (the item value under `$INPUTS.<as>`). `as` is load-time guaranteed not to
    // collide with a `with:` key, so this spread order is unambiguous. The item travels
    // LOGICALLY under `as` (#2637 — an object item stays an object for the child);
    // `itemToInput`'s text form remains the `$ARGUMENTS`/item-hash channel.
    const childInputs: Record<string, JsonValue> = {
      ...fanOutStaticInputs,
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

  const unclaimed = (): number[] =>
    items.flatMap((_, i) => (settledByIndex.has(i) || heldByIndex.has(i) ? [] : [i]));
  for (
    let waiting = unclaimed();
    waiting.length > 0 && heldByIndex.size < fanOut.max_parallel;
    waiting = unclaimed()
  ) {
    const settled = await mapWithHeldSlots(
      waiting,
      fanOut.max_parallel - heldByIndex.size,
      spawn,
      outcome => outcome.status === 'paused'
    );
    const claimed = settled.flatMap((result, k) =>
      result === undefined ? [] : [{ index: waiting[k], result }]
    );
    const outcomes = settledValuesOrThrow(
      claimed.map(c => c.result),
      parentRun.id
    );
    claimed.forEach(({ index }, k) => {
      const outcome = outcomes[k];
      if (outcome.status === 'paused') heldByIndex.set(index, outcome.childRunId);
      else settledByIndex.set(index, outcome);
    });

    // A held child may have finished while this pass ran (answered and continued in
    // another process). Take its row's outcome so its slot frees for the next round.
    if (heldByIndex.size === 0) break;
    let rows: WorkflowRun[];
    try {
      rows = await findFanOutChildRuns(deps.store, parentRun.id, stepName);
    } catch (error) {
      const msg = `Failed to look up fan-out child runs for node '${node.id}': ${(error as Error).message}`;
      await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
      return failResult(msg, 'unknown');
    }
    for (const [index, childRunId] of heldByIndex) {
      const row = rows.find(r => r.id === childRunId);
      if (row !== undefined && isTerminalRunStatus(row.status)) {
        settledByIndex.set(index, childOutcomeFromRun(row));
        heldByIndex.delete(index);
      }
    }
  }

  // 6. Some children are unfinished: pause the parent on them. Each child is its own run
  //    and queue item, answered by its own run id; the engine never ends one for pausing.
  //    The parent continues through `maybeResumeParentRun` once `isFanOutBlockReleased`
  //    holds, re-enters here as a continuation, and joins when no child is held.
  if (heldByIndex.size > 0) {
    const held = [...heldByIndex.entries()].sort(([a], [b]) => a - b);
    const unspawnedItems = unclaimed().length;
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
    const paused = await pauseGateRespectingExternalTransition(
      deps,
      parentRun.id,
      {
        type: 'fan_out',
        nodeId: stepName,
        message,
        childRunIds: held.map(([, id]) => id),
        unspawnedItems,
      },
      { event: serializeNodeStateRecord(suspended) }
    );
    if (!paused) return serializeNodeOutput(execution);
    await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
    await notify(
      `⏸ **Waiting on sub-runs** (node \`${node.id}\`): ${message} ` +
        `See them with \`${spellWorkflowCommand(platform, 'status')}\`.`
    );
    return serializeNodeOutput(suspended);
  }

  const outcomes = items.map((_, i) => {
    const outcome = settledByIndex.get(i);
    if (outcome === undefined) {
      throw new Error(`fan_out node '${node.id}': item ${String(i)} has no settled outcome`);
    }
    return outcome;
  });

  const totalCostUsd = sumFanOutCost(outcomes);
  const totalTokens = sumFanOutTokens(outcomes);
  tokensUnknown = outcomes.some(outcome => outcome.tokensUnknown === true);

  // A completed child's aggregate ELEMENT (#2637): its terminal LOGICAL value via
  // {@link subrunLogicalValue}, so a structured child lands single-encoded
  // (`[{"v":1}]`, never `["{\"v\":1}"]`), a text-only child whose summary happens
  // to be JSON lands parsed, and any other child stays the exact string it always was.
  // Each child certified its own element against its own `returns:` contract (#2453);
  // the aggregate is engine-owned and asserts nothing further.
  // I3: parity with the 1:1 asCompleted path — a completed child with no terminal
  // output is indistinguishable downstream from an intentional empty result, so
  // leave a trace before falling back to ''. A structured child always has text too
  // (the canonical serialization), so this warn still covers every genuinely empty
  // completion.
  const childElement = (o: ChildWorkflowOutcome, index: number): JsonValue => {
    if (o.status === 'completed' && o.output === undefined) {
      getLog().warn(
        { parentRunId: parentRun.id, nodeId: node.id, childRunId: o.childRunId, childIndex: index },
        'workflow.subrun_completed_without_output'
      );
    }
    return o.structuredOutput !== undefined
      ? (o.structuredOutput as JsonValue)
      : (subrunLogicalValue(o) as JsonValue);
  };

  // 7. Join.
  if (fanOut.join === 'all_success') {
    // Every child ran to its own terminal state, so the lowest-index non-completed outcome
    // IS the causal one — nothing here is a casualty of another child's failure.
    const firstBad = outcomes.findIndex(o => o.status !== 'completed');
    if (firstBad !== -1) {
      const bad = outcomes[firstBad];
      const ref = bad.childRunId ? ` (run ${bad.childRunId.slice(0, 8)})` : '';
      await notify(
        `❌ **Fan-out failed** (node \`${node.id}\`): child ${String(firstBad)}${ref} ${bad.status}` +
          (bad.error ? ` — ${bad.error}` : '')
      );
      return failResult(
        `fan_out node '${node.id}' (join: all_success): child ${String(firstBad)}${ref} ${bad.status}` +
          (bad.error ? `: ${bad.error}` : ''),
        'child_failed',
        totalCostUsd,
        totalTokens
      );
    }
    // All completed → aggregate the child results in item order: a LOGICAL array
    // (#2637), serialized once for the text channel.
    const elements = outcomes.map((o, i) => childElement(o, i));
    const aggregate = JSON.stringify(elements);
    return writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
  }

  let children: WorkflowRun[];
  try {
    children = await findFanOutChildRuns(deps.store, parentRun.id, stepName);
  } catch (error) {
    const msg = `Failed to look up settled fan-out child runs for node '${node.id}': ${(error as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown', totalCostUsd, totalTokens);
  }
  const anyChildStarted = children.some(child => {
    const index = readSubrunMetadata(child.metadata).childIndex;
    return index !== undefined && index >= 0 && index < items.length;
  });
  if (!anyChildStarted) {
    const reason = outcomes[0].error ?? `child ${outcomes[0].status}`;
    const msg = `fan_out node '${node.id}' refused all ${String(items.length)} children at spawn: ${reason}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'child_failed', totalCostUsd, totalTokens);
  }

  // join: all_done — node succeeds once all children are terminal; a failed/cancelled
  // entry is represented as a failure-marker object in the aggregate array (so a
  // collector can reconcile partial results). Never fails the node on a partial failure.
  //
  // `archon_failed: true` is the marker's reserved discriminator (#2637): now that a
  // completed structured child's slot is its payload OBJECT, a child whose own schema
  // happens to carry `error` + `status` fields (a natural verifier shape) would be
  // indistinguishable from a failed slot by shape alone. No key can be made literally
  // unproducible through `output_format`, but no schema grows an `archon_failed`
  // field by accident — collectors check `r?.archon_failed === true`, nothing else.
  const elements = outcomes.map((o, i) =>
    o.status === 'completed'
      ? childElement(o, i)
      : { archon_failed: true, error: o.error ?? `child ${o.status}`, status: o.status }
  );
  const aggregate = JSON.stringify(elements);
  return writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
}
