/**
 * Wait until one run needs someone.
 *
 * The durable row is always the answer. Database notifications and the local owner
 * endpoint only wake a re-read or prove that active execution no longer has a process.
 * This service never mutates run lifecycle state.
 */
import { hostname } from 'node:os';
import { createLogger } from '@archon/paths';
import { readExecutionOwner, runAttention } from '@archon/workflows/schemas/workflow-run';
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
// Persisted child and parent links are not trusted to be acyclic.
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
      executionChainIds: readonly string[];
      /** Nearest stamp from the active run back; an unclaimed child runs in its parent's process. */
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

function ownerRequired(
  activeRun: WorkflowRun,
  executionChain: readonly WorkflowRun[]
): Extract<RunResolution, { kind: 'owner_required' }> {
  const newestFirst = [...executionChain].reverse();
  return {
    kind: 'owner_required',
    activeRun,
    executionChainIds: newestFirst.map(candidate => candidate.id),
    recordedOwner: newestFirst
      .map(candidate => readExecutionOwner(candidate.metadata))
      .find(owner => owner !== undefined),
  };
}

/** Resolve the child chain while retaining whether its current state needs a live process. */
async function resolveRun(store: RunAttentionReadStore, run: WorkflowRun): Promise<RunResolution> {
  const executionChain = [run];
  let current = run;
  let attention = runAttention(current);
  let steps = 0;

  while (attention?.kind === 'blocked_on_child') {
    steps += 1;
    if (steps > MAX_CHAIN_RUNS) {
      return {
        kind: 'attention',
        attention: unreadable(
          attention.runId,
          'child_chain_too_deep',
          `sub-run chain is deeper than ${String(MAX_CHAIN_RUNS)} runs`
        ),
      };
    }
    const child = await store.getWorkflowRun(attention.childRunId);
    if (!child) {
      return {
        kind: 'attention',
        attention: unreadable(
          attention.runId,
          'child_run_missing',
          `blocked on sub-run ${attention.childRunId}, which has no row`
        ),
      };
    }
    executionChain.push(child);
    current = child;
    const childAttention = runAttention(child);
    if (childAttention?.kind === 'terminal') return ownerRequired(child, executionChain);
    attention = childAttention;
  }

  if (attention) return { kind: 'attention', attention };
  if (current.status === 'running' || (current !== run && current.status === 'pending')) {
    return ownerRequired(current, executionChain);
  }
  return { kind: 'ownerless' };
}

/** Prefer the active child, then walk toward the process-entry ancestor. */
async function ownerCandidates(
  store: RunAttentionReadStore,
  resolution: Extract<RunResolution, { kind: 'owner_required' }>
): Promise<string[]> {
  const candidates = [...resolution.executionChainIds];
  const seen = new Set(candidates);
  let current = resolution.activeRun;
  let steps = 0;
  while (current.parent_run_id) {
    steps += 1;
    if (steps > MAX_CHAIN_RUNS) break;
    const parentId = current.parent_run_id;
    if (!seen.has(parentId)) {
      seen.add(parentId);
      candidates.push(parentId);
    }
    const parent = await store.getWorkflowRun(parentId);
    if (!parent) break;
    current = parent;
  }
  return candidates;
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
    const candidates = await ownerCandidates(store, resolution);
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
