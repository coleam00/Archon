/**
 * Wait until one run needs someone.
 *
 * The durable row is always the answer. Database notifications and the local owner
 * endpoint only wake a re-read or prove that active execution no longer has a process.
 * This service never mutates run lifecycle state.
 */
import { hostname } from 'node:os';
import { createLogger } from '@archon/paths';
import {
  isApprovalContext,
  isFanOutBlockReleased,
  isTerminalRunStatus,
  readExecutionOwner,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type {
  ExecutionOwnerRecord,
  RunAttention,
  WorkflowRun,
  WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';

import {
  watchRunLiveOwner,
  type RunLiveOwnerWatch,
  type RunLiveOwnerWatchEvent,
  type RunLiveOwnerWatchResult,
} from './run-live-owner';
import { DETACHED_RUN_STOP_HANDOFF_GRACE_MS } from './run-stop-bounds';

export type RunAttentionReadStore = Pick<IWorkflowStore, 'getWorkflowRun'>;
export type RunDoorbell = (runId: string, onDoorbell: () => void) => Promise<(() => void) | null>;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('run-attention');
  return cachedLog;
}

export const DEFAULT_ATTENTION_POLL_INTERVAL_MS = 1000;
// Persisted child and parent links are not trusted to be acyclic. Bounds the rows one
// sub-run tree walk visits, and the parent walk toward the process-entry ancestor.
const MAX_CHAIN_RUNS = 500;

export type NonTerminalWorkflowRunStatus = Exclude<
  WorkflowRunStatus,
  'completed' | 'failed' | 'cancelled'
>;

export type RunWaitResult =
  | { kind: 'attention'; attention: RunAttention }
  | { kind: 'owner_lost'; runId: string; observedStatus: NonTerminalWorkflowRunStatus }
  | { kind: 'deadline'; runId: string; observedStatus: WorkflowRunStatus }
  | { kind: 'aborted'; runId: string }
  | { kind: 'not_found'; runId: string };

export interface RunAttentionWaitOptions {
  /** Stop waiting when this aborts. The run row is left untouched. */
  signal?: AbortSignal;
  doorbell?: RunDoorbell;
  /** Give up after this long. Omitted means wait until the run says something. */
  deadlineMs?: number;
  /** Backstop re-read cadence. Defaults to `DEFAULT_ATTENTION_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  /**
   * Called once after the required durable and live watches are attached. `ownerLiveness`
   * is set when the run needs an owner whose endpoint this host and user cannot reach, so
   * the wait watches only the durable row.
   */
  onAttached?: (
    observedStatus: WorkflowRunStatus,
    ownerLiveness?: UnknownOwnerLiveness
  ) => void | Promise<void>;
}

export interface UnknownOwnerLiveness {
  kind: 'unknown';
  /** The run's `execution_owner` record; undefined on runs that predate it. */
  recordedOwner: ExecutionOwnerRecord | undefined;
}

type RunResolution =
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

type WakeSource =
  | 'immediate'
  | 'notify'
  | 'interval'
  | 'deadline'
  | 'owner_attention'
  | 'owner_disconnect'
  | 'owner_handoff';

function unreadable(
  runId: string,
  reason: 'child_run_missing' | 'child_chain_too_deep',
  detail: string
): RunAttention {
  return { kind: 'unreadable', runId, reason, detail };
}

function isNonTerminalStatus(status: WorkflowRunStatus): status is NonTerminalWorkflowRunStatus {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

/**
 * The live-owner endpoint sits in a host-local, per-uid directory, so a missing endpoint
 * proves the owner gone only when the recorded owner shares this host and user.
 */
function isOwnerEndpointLocal(owner: ExecutionOwnerRecord | undefined): boolean {
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
 * live process. A parent blocked on children is never its own item: the walk goes depth
 * first through the children in item order. The first child that has attention wins;
 * failing that, the first that needs an owner; otherwise nobody is needed.
 */
async function resolveRun(store: RunAttentionReadStore, run: WorkflowRun): Promise<RunResolution> {
  return resolveFrom(store, run, [run], new Set([run.id]));
}

async function resolveFrom(
  store: RunAttentionReadStore,
  current: WorkflowRun,
  executionChain: readonly WorkflowRun[],
  visited: Set<string>
): Promise<RunResolution> {
  const attention = runAttention(current);
  const isRoot = executionChain.length === 1;
  if (attention?.kind === 'blocked_on_child' || attention?.kind === 'blocked_on_children') {
    const childRunIds =
      attention.kind === 'blocked_on_child' ? [attention.childRunId] : attention.childRunIds;
    const children: WorkflowRun[] = [];
    for (const childRunId of childRunIds) {
      if (visited.has(childRunId) || visited.size >= MAX_CHAIN_RUNS) {
        return {
          kind: 'attention',
          attention: unreadable(
            attention.runId,
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
    let ownerNeeded: RunResolution | undefined;
    for (const child of children) {
      if (!released && isTerminalRunStatus(child.status)) continue;
      const resolution = await resolveFrom(store, child, [...executionChain, child], visited);
      if (resolution.kind === 'attention') return resolution;
      if (resolution.kind === 'owner_required') ownerNeeded ??= resolution;
    }
    return ownerNeeded ?? { kind: 'ownerless' };
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

/** Block until durable attention, owner loss, deadline, or caller abort. */
export async function waitForRunAttention(
  store: RunAttentionReadStore,
  runId: string,
  opts: RunAttentionWaitOptions = {}
): Promise<RunWaitResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_ATTENTION_POLL_INTERVAL_MS;
  const deadlineAt = opts.deadlineMs === undefined ? undefined : Date.now() + opts.deadlineMs;
  const signal = opts.signal;
  if (signal?.aborted) return { kind: 'aborted', runId };

  let pendingWake: WakeSource | undefined;
  let wake: ((source: WakeSource) => void) | null = null;
  let ownerWatch: { runId: string; handle: RunLiveOwnerWatch } | undefined;
  let ownerWatchEnded = false;
  let controlHandoffUntil: number | undefined;

  const queueWake = (source: WakeSource): void => {
    if (wake) wake(source);
    else pendingWake = source;
  };
  let unsubscribeDoorbell: (() => void) | null | undefined;
  try {
    unsubscribeDoorbell = await opts.doorbell?.(runId, () => {
      queueWake('notify');
    });
  } catch (err) {
    // Notifications only reduce latency; durable polling must survive subscription failure.
    getLog().debug({ err, runId }, 'run_attention.doorbell_unavailable');
  }

  const nextWake = (): Promise<WakeSource> => {
    if (pendingWake) {
      const source = pendingWake;
      pendingWake = undefined;
      return Promise.resolve(source);
    }
    return new Promise<WakeSource>(resolve => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (source: WakeSource): void => {
        if (wake === null) return;
        wake = null;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(source);
      };
      const onAbort = (): void => {
        finish('interval');
      };
      wake = finish;
      timers.push(
        setTimeout(() => {
          finish('interval');
        }, pollIntervalMs)
      );
      if (deadlineAt !== undefined) {
        timers.push(
          setTimeout(
            () => {
              finish('deadline');
            },
            Math.max(0, deadlineAt - Date.now())
          )
        );
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const onOwnerEvent = (event: RunLiveOwnerWatchEvent): void => {
    if (event === 'control_handoff') {
      controlHandoffUntil = Date.now() + DETACHED_RUN_STOP_HANDOFF_GRACE_MS;
      queueWake('owner_handoff');
      return;
    }
    ownerWatchEnded = true;
    queueWake(event === 'attention' ? 'owner_attention' : 'owner_disconnect');
  };

  const discardOwnerWatch = (): void => {
    ownerWatch?.handle.unsubscribe();
    ownerWatch = undefined;
    ownerWatchEnded = false;
  };

  const attachOwner = async (
    resolution: Extract<RunResolution, { kind: 'owner_required' }>
  ): Promise<RunLiveOwnerWatchResult['kind'] | 'unknown'> => {
    const candidates = resolution.ownerCandidateIds;
    if (ownerWatch && !ownerWatchEnded && candidates.includes(ownerWatch.runId)) return 'attached';
    discardOwnerWatch();
    let attachment: Exclude<RunLiveOwnerWatchResult['kind'], 'attached'> = 'unreachable';
    for (const candidate of candidates) {
      ownerWatchEnded = false;
      const result = await watchRunLiveOwner(candidate, onOwnerEvent);
      if (result.kind === 'attached') {
        ownerWatch = { runId: candidate, handle: result.handle };
        return ownerWatchEnded ? 'unproven' : 'attached';
      }
      if (result.kind === 'unproven') attachment = 'unproven';
    }
    return attachment === 'unreachable' && !isOwnerEndpointLocal(resolution.recordedOwner)
      ? 'unknown'
      : attachment;
  };

  try {
    let wakeSource: WakeSource = 'immediate';
    let attached = false;
    for (;;) {
      if (ownerWatchEnded) discardOwnerWatch();

      const run = await store.getWorkflowRun(runId);
      if (!run) return { kind: 'not_found', runId };
      let observedStatus = run.status;
      let resolution = await resolveRun(store, run);
      if (resolution.kind === 'attention') {
        getLog().debug(
          { runId, wakeSource, attention: resolution.attention.kind },
          'run_attention.resolved'
        );
        return { kind: 'attention', attention: resolution.attention };
      }

      if (resolution.kind === 'owner_required') {
        let ownerAttachment = await attachOwner(resolution);
        if (ownerAttachment !== 'attached') {
          const latestRun = await store.getWorkflowRun(runId);
          if (!latestRun) return { kind: 'not_found', runId };
          observedStatus = latestRun.status;
          resolution = await resolveRun(store, latestRun);
          if (resolution.kind === 'attention') {
            return { kind: 'attention', attention: resolution.attention };
          }
          if (resolution.kind === 'owner_required') {
            ownerAttachment = await attachOwner(resolution);
            if (ownerAttachment !== 'attached') {
              if (controlHandoffUntil !== undefined && Date.now() < controlHandoffUntil) {
                pendingWake = undefined;
              } else if (
                ownerAttachment === 'unreachable' &&
                isNonTerminalStatus(latestRun.status)
              ) {
                controlHandoffUntil = undefined;
                return {
                  kind: 'owner_lost',
                  runId,
                  observedStatus: latestRun.status,
                };
              }
            }
          } else {
            discardOwnerWatch();
          }
        }
        if (ownerAttachment === 'unknown' && resolution.kind === 'owner_required' && !attached) {
          attached = true;
          await opts.onAttached?.(observedStatus, {
            kind: 'unknown',
            recordedOwner: resolution.recordedOwner,
          });
        }
        if (ownerAttachment === 'attached' && !attached) {
          const verifiedRun = await store.getWorkflowRun(runId);
          if (!verifiedRun) return { kind: 'not_found', runId };
          observedStatus = verifiedRun.status;
          const verified = await resolveRun(store, verifiedRun);
          if (verified.kind === 'attention') {
            return { kind: 'attention', attention: verified.attention };
          }
          if (verified.kind !== 'owner_required') {
            discardOwnerWatch();
          } else if ((await attachOwner(verified)) === 'attached' && !ownerWatchEnded) {
            attached = true;
            await opts.onAttached?.(verifiedRun.status);
          }
        }
      } else {
        controlHandoffUntil = undefined;
        discardOwnerWatch();
        if (!attached) {
          attached = true;
          await opts.onAttached?.(run.status);
        }
      }

      if (signal?.aborted) return { kind: 'aborted', runId };
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return { kind: 'deadline', runId, observedStatus };
      }
      wakeSource = await nextWake();
    }
  } finally {
    discardOwnerWatch();
    unsubscribeDoorbell?.();
  }
}
