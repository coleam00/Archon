import type { WorkflowDeps } from '../../../deps';
import type { WorkflowNode, WorkflowRun } from '../../../schemas';
import { readSubrunMetadata, isTerminalRunStatus } from '../../../schemas';
import { FAN_OUT_CANCEL_REASONS } from '../../../store';
import { canonicalValueText } from '../../../output-ref';
import { getLog } from '../../log';
import { childOutcomeFromRun, type ChildWorkflowOutcome } from '../../child-run';

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
 * Item → child input/$ARGUMENTS (canonical value text: strings raw, objects JSON).
 * Also the pre-image for the resume item-hash (S2) — identity unchanged by #2637,
 * since canonicalValueText is byte-identical to the previous inline mapping.
 */
export function fanOutItemInput(item: unknown): string {
  return canonicalValueText(item);
}

/**
 * Cheap, dependency-free content hash (djb2) of a fan-out child's input string, stamped
 * at spawn so resume can detect a non-deterministic items producer (same index, changed
 * content) and WARN (never re-key). Collision-tolerant: a warn-only signal, not identity.
 */
export function hashFanOutItem(input: string): string {
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

function isLive(child: WorkflowRun): boolean {
  return child.status === 'running' || child.status === 'pending' || child.status === 'paused';
}

/**
 * S2: a non-deterministic items producer may have changed the item at this index between
 * attempts. Resume still re-keys by index (safe under the cached-output invariant), but
 * WARN so the content drift is visible.
 */
function warnOnItemDrift(
  child: WorkflowRun,
  index: number,
  priorHash: string | undefined,
  item: unknown,
  parentRunId: string,
  nodeId: string
): void {
  if (priorHash !== undefined && priorHash !== hashFanOutItem(fanOutItemInput(item))) {
    getLog().warn(
      { parentRunId, nodeId, childIndex: index, childRunId: child.id },
      'workflow.fan_out_item_content_changed'
    );
  }
}

/**
 * Re-entry: find THIS node's existing children (a parent may run several workflow nodes →
 * filter by parent_node_id) and index them by metadata.child_index. Empty on the first
 * run; carries the ordered instance set on resume. A child that cannot belong to an item
 * is never silently dropped: it is logged, and cancelled through `cancelOrphan` while live.
 */
export async function indexExistingChildren(
  store: WorkflowDeps['store'],
  parentRunId: string,
  node: WorkflowNode,
  stepName: string,
  items: readonly unknown[],
  cancelOrphan: (childId: string) => Promise<void>
): Promise<Map<number, WorkflowRun>> {
  const existingByIndex = new Map<number, WorkflowRun>();
  const children = await findFanOutChildRuns(store, parentRunId, stepName);
  for (const child of children) {
    const meta = readSubrunMetadata(child.metadata as Record<string, unknown> | undefined);
    const idx = meta.childIndex;
    // A child of THIS node with no `child_index`: it was spawned when the node was a 1:1
    // sub-run (that path stamps `parent_node_id` and no index), and the node has since
    // grown a `fan_out:`. Dropping it silently left a live, billing, untracked child that
    // nothing would ever cancel — so it gets the same treatment as an out-of-range index.
    if (idx === undefined) {
      getLog().warn(
        { parentRunId, nodeId: node.id, childRunId: child.id, status: child.status },
        'workflow.fan_out_child_missing_index'
      );
      if (isLive(child)) await cancelOrphan(child.id);
      continue;
    }
    // I2: a child_index beyond the (now-shorter) item list — the items producer shrank
    // between attempts. Never silently dropped: WARN for visibility, and cancel a
    // still-live orphan (tagged) so it stops billing (a terminal one no-ops).
    if (idx < 0 || idx >= items.length) {
      getLog().warn(
        {
          parentRunId,
          nodeId: node.id,
          childRunId: child.id,
          childIndex: idx,
          itemCount: items.length,
        },
        'workflow.fan_out_child_index_out_of_range'
      );
      if (isLive(child)) await cancelOrphan(child.id);
      continue;
    }
    // S4: a duplicate child_index (two rows for one index) is anomalous — last write
    // wins (as the 1:1 precedent does), but log it rather than swallow it silently.
    if (existingByIndex.has(idx)) {
      getLog().debug(
        { parentRunId, nodeId: node.id, childIndex: idx, childRunId: child.id },
        'workflow.fan_out_duplicate_child_index'
      );
    }
    warnOnItemDrift(child, idx, meta.fanOutItemHash, items[idx], parentRunId, node.id);
    existingByIndex.set(idx, child);
  }
  return existingByIndex;
}

/**
 * The first `running`/`pending` child found on a recovery, with the failure message that
 * names it. Such a child is a crash-orphan or a live run in another process, so the node
 * fails WITHOUT cancelling it.
 */
export function findAmbiguousChild(
  existingByIndex: ReadonlyMap<number, WorkflowRun>,
  parentRunId: string,
  node: WorkflowNode
): { child: WorkflowRun; message: string } | undefined {
  const ambiguous = [...existingByIndex.entries()].find(
    ([, c]) => c.status === 'running' || c.status === 'pending'
  );
  if (ambiguous === undefined) return undefined;
  const [index, child] = ambiguous;
  const stale = isFanOutChildStale(child);
  getLog().warn(
    {
      parentRunId,
      nodeId: node.id,
      childRunId: child.id,
      childIndex: index,
      status: child.status,
      stale,
    },
    'workflow.fan_out_child_nonterminal_on_resume'
  );
  return { child, message: fanOutAmbiguousChildMessage(node, child, index, stale) };
}

/** The children a fan-out pass starts from, by item index. */
export interface FanOutChildState {
  settledByIndex: Map<number, ChildWorkflowOutcome>;
  /** Child run id of every held (non-terminal) child, by item index. */
  heldByIndex: Map<number, string>;
}

/**
 * Sort existing children into settled and held. A continuation threads every settled
 * child as it is; a recovery leaves failed and fan-out-cancelled children unsettled so
 * they are re-driven. A non-terminal child is held in either mode.
 */
export function classifyExistingChildren(
  existingByIndex: ReadonlyMap<number, WorkflowRun>,
  continuing: boolean
): FanOutChildState {
  const settledByIndex = new Map<number, ChildWorkflowOutcome>();
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
  return { settledByIndex, heldByIndex };
}

/** Indices with neither a settled outcome nor a held child: the ones still to spawn. */
export function unclaimedIndices(itemCount: number, state: FanOutChildState): number[] {
  return Array.from({ length: itemCount }, (_, i) => i).filter(
    i => !state.settledByIndex.has(i) && !state.heldByIndex.has(i)
  );
}

/**
 * A held child may have finished while this pass ran (answered and continued in another
 * process). Take its row's outcome so its slot frees for the next round.
 */
export function settleFinishedHeldChildren(
  rows: readonly WorkflowRun[],
  state: FanOutChildState
): void {
  for (const [index, childRunId] of state.heldByIndex) {
    const row = rows.find(r => r.id === childRunId);
    if (row !== undefined && isTerminalRunStatus(row.status)) {
      state.settledByIndex.set(index, childOutcomeFromRun(row));
      state.heldByIndex.delete(index);
    }
  }
}
