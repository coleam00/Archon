/**
 * Resolve what a run's sub-run tree needs now, without waiting: the attention a waiter
 * would report, or whether the tree still needs a live owner. A parent with stalled
 * siblings reports its own work first; otherwise the walk reports the child. Shared by
 * `workflow wait` (`waitForRunAttention`, @archon/core) and the attention queue's list and
 * single read, so they cannot disagree about which run an answer belongs to.
 */
import { hostname } from 'node:os';
import {
  isApprovalContext,
  isFanOutBlockReleased,
  isTerminalRunStatus,
  readExecutionOwner,
  runAttention,
  queuedRunAttention,
  type ExecutionOwnerRecord,
  type RunAttention,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

export type RunAttentionReadStore = Pick<IWorkflowStore, 'getWorkflowRun'>;

// Persisted child and parent links are not trusted to be acyclic. Bounds the rows one
// sub-run tree walk visits, and the parent walk toward the process-entry ancestor.
const MAX_CHAIN_RUNS = 500;

export type RunResolution =
  | { kind: 'attention'; attention: RunAttention }
  | {
      kind: 'owner_required';
      activeRun: WorkflowRun;
      /** Endpoints to try: the active child first, then toward the process-entry ancestor. */
      ownerCandidateIds: readonly string[];
      /** Nearest stamp in candidate order; an unclaimed child runs in its parent's process. */
      recordedOwner: ExecutionOwnerRecord | undefined;
    }
  | { kind: 'ownerless' };

function unreadable(
  runId: string,
  reason: 'child_run_missing' | 'child_chain_too_deep',
  detail: string
): RunAttention {
  return { kind: 'unreadable', runId, reason, detail };
}

/**
 * The live-owner endpoint sits in a host-local, per-uid directory, so a missing endpoint
 * proves the owner gone only when the recorded owner shares this host and user.
 */
export function isOwnerEndpointLocal(owner: ExecutionOwnerRecord | undefined): boolean {
  if (!owner || owner.host !== hostname()) return false;
  const uid = process.getuid?.();
  return uid === undefined || owner.uid === uid;
}

async function ownerRequired(
  store: RunAttentionReadStore,
  activeRun: WorkflowRun,
  executionChain: readonly WorkflowRun[]
): Promise<Extract<RunResolution, { kind: 'owner_required' }>> {
  const newestFirst = [...executionChain].reverse();
  const ownerCandidateIds = newestFirst.map(candidate => candidate.id);
  let recordedOwner = newestFirst
    .map(candidate => readExecutionOwner(candidate.metadata))
    .find(owner => owner !== undefined);
  const seen = new Set(ownerCandidateIds);
  let current = activeRun;
  let steps = 0;
  while (current.parent_run_id) {
    steps += 1;
    if (steps > MAX_CHAIN_RUNS) break;
    const parentId = current.parent_run_id;
    if (!seen.has(parentId)) {
      seen.add(parentId);
      ownerCandidateIds.push(parentId);
    }
    const parent = await store.getWorkflowRun(parentId);
    if (!parent) break;
    recordedOwner ??= readExecutionOwner(parent.metadata);
    current = parent;
  }
  return { kind: 'owner_required', activeRun, ownerCandidateIds, recordedOwner };
}

/**
 * Resolve the sub-run tree under `run` while retaining whether its current state needs a
 * live process. After checking the parent's own stalled siblings, the walk goes depth
 * first through the children in item order. The first child that has attention wins;
 * failing that, the first that needs an owner (any finished child's, once the gate is
 * released); otherwise nobody is needed.
 */
export async function resolveRunAttention(
  store: RunAttentionReadStore,
  run: WorkflowRun
): Promise<RunResolution> {
  return resolveFrom(store, run, [run], new Set([run.id]));
}

function ownRunAttention(run: WorkflowRun): RunAttention | null {
  const projected = runAttention(run);
  return queuedRunAttention(run, projected) ?? projected;
}

async function resolveFrom(
  store: RunAttentionReadStore,
  current: WorkflowRun,
  executionChain: readonly WorkflowRun[],
  visited: Set<string>
): Promise<RunResolution> {
  const attention = ownRunAttention(current);
  const isRoot = executionChain.length === 1;
  if (attention?.kind === 'blocked_on_child' || attention?.kind === 'blocked_on_children') {
    const childRunIds =
      attention.kind === 'blocked_on_child' ? [attention.childRunId] : attention.childRunIds;
    const children: WorkflowRun[] = [];
    for (const childRunId of childRunIds) {
      if (visited.has(childRunId) || visited.size >= MAX_CHAIN_RUNS) {
        // Names the walk's root: the budget and the revisit are properties of this walk,
        // and a walk started from the run below would read that run's tree fine.
        return {
          kind: 'attention',
          attention: unreadable(
            executionChain[0].id,
            'child_chain_too_deep',
            `sub-run tree is larger than ${String(MAX_CHAIN_RUNS)} runs or revisits a run`
          ),
        };
      }
      visited.add(childRunId);
      const child = await store.getWorkflowRun(childRunId);
      if (!child) {
        return {
          kind: 'attention',
          attention: unreadable(
            attention.runId,
            'child_run_missing',
            `blocked on sub-run ${childRunId}, which has no row`
          ),
        };
      }
      children.push(child);
    }
    // A finished fan-out child's hook stands down until the gate is released, so until
    // then nothing owns that child.
    const approval = current.metadata?.approval;
    const released =
      attention.kind === 'blocked_on_child' ||
      (isApprovalContext(approval) &&
        isFanOutBlockReleased(approval, id => children.find(child => child.id === id)?.status));
    const ownerNeeded: Extract<RunResolution, { kind: 'owner_required' }>[] = [];
    for (const child of children) {
      if (!released && isTerminalRunStatus(child.status)) continue;
      const resolution = await resolveFrom(store, child, [...executionChain, child], visited);
      if (resolution.kind === 'attention') return resolution;
      if (resolution.kind === 'owner_required') ownerNeeded.push(resolution);
    }
    const [first] = ownerNeeded;
    if (!first) return { kind: 'ownerless' };
    // Once released, whichever child finished last continues the parent and the rows do
    // not record which one that is, so any of their owners proves the parent owned, and
    // the parent is proven lost only when every recorded owner is checkable from here.
    if (!released || ownerNeeded.length === 1) return first;
    return {
      ...first,
      ownerCandidateIds: [...new Set(ownerNeeded.flatMap(r => r.ownerCandidateIds))],
      recordedOwner: (ownerNeeded.find(r => !isOwnerEndpointLocal(r.recordedOwner)) ?? first)
        .recordedOwner,
    };
  }

  // A terminal child's hook is expected to continue its parent, in the child's process.
  if (attention?.kind === 'terminal' && !isRoot) {
    return ownerRequired(store, current, executionChain);
  }
  if (attention) return { kind: 'attention', attention };
  if (current.status === 'running' || (!isRoot && current.status === 'pending')) {
    return ownerRequired(store, current, executionChain);
  }
  return { kind: 'ownerless' };
}
