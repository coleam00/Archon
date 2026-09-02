/**
 * Wait until one run needs someone.
 *
 * The durable row is always the answer. Database notifications and the local owner
 * endpoint only wake a re-read or prove that active execution no longer has a process.
 * This service never mutates run lifecycle state.
 */
import { createLogger } from '@archon/paths';
import { runAttention } from '@archon/workflows/schemas/workflow-run';
import type {
  RunAttention,
  WorkflowRun,
  WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import { WORKFLOW_EVENT_NOTIFY_CHANNEL } from '../db/adapters/types';
import { getDbNotificationListener } from '../db/connection';
import * as workflowDb from '../db/workflows';
import {
  RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS,
  watchRunLiveOwner,
  type RunLiveOwnerWatch,
  type RunLiveOwnerWatchEvent,
} from './run-live-owner';

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
  /** Give up after this long. Omitted means wait until the run says something. */
  deadlineMs?: number;
  /** Backstop re-read cadence. Defaults to `DEFAULT_ATTENTION_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  /** Called once after the required durable and live watches are attached. */
  onAttached?: (observedStatus: WorkflowRunStatus) => void | Promise<void>;
}

type RunResolution =
  | { kind: 'attention'; attention: RunAttention }
  | { kind: 'owner_required'; activeRun: WorkflowRun; executionChainIds: readonly string[] }
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

/** Resolve the child chain while retaining whether its current state needs a live process. */
async function resolveRun(run: WorkflowRun): Promise<RunResolution> {
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
    const child = await workflowDb.getWorkflowRun(attention.childRunId);
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
    if (childAttention?.kind === 'terminal') {
      return {
        kind: 'owner_required',
        activeRun: child,
        executionChainIds: executionChain.map(candidate => candidate.id).reverse(),
      };
    }
    attention = childAttention;
  }

  if (attention) return { kind: 'attention', attention };
  if (current.status === 'running' || (current !== run && current.status === 'pending')) {
    return {
      kind: 'owner_required',
      activeRun: current,
      executionChainIds: executionChain.map(candidate => candidate.id).reverse(),
    };
  }
  return { kind: 'ownerless' };
}

/** Prefer the active child, then walk toward the process-entry ancestor. */
async function ownerCandidates(
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
    const parent = await workflowDb.getWorkflowRun(parentId);
    if (!parent) break;
    current = parent;
  }
  return candidates;
}

async function subscribeToRunDoorbell(
  runId: string,
  onDoorbell: () => void
): Promise<(() => void) | null> {
  const listener = getDbNotificationListener();
  if (!listener) return null;
  try {
    return await listener.listen(
      WORKFLOW_EVENT_NOTIFY_CHANNEL,
      payload => {
        if (payload === runId) onDoorbell();
      },
      err => {
        getLog().debug({ err, runId }, 'run_attention.doorbell_dropped');
      }
    );
  } catch (err) {
    getLog().debug({ err, runId }, 'run_attention.doorbell_unavailable');
    return null;
  }
}

/** Block until durable attention, owner loss, deadline, or caller abort. */
export async function waitForRunAttention(
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
  const unsubscribeDoorbell = await subscribeToRunDoorbell(runId, () => {
    queueWake('notify');
  });

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
      controlHandoffUntil = Date.now() + RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS;
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
  ): Promise<boolean> => {
    const candidates = await ownerCandidates(resolution);
    if (ownerWatch && !ownerWatchEnded && candidates.includes(ownerWatch.runId)) return true;
    discardOwnerWatch();
    for (const candidate of candidates) {
      ownerWatchEnded = false;
      const handle = await watchRunLiveOwner(candidate, onOwnerEvent);
      if (handle) {
        ownerWatch = { runId: candidate, handle };
        return !ownerWatchEnded;
      }
    }
    return false;
  };

  try {
    let wakeSource: WakeSource = 'immediate';
    let attached = false;
    for (;;) {
      if (ownerWatchEnded) discardOwnerWatch();

      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return { kind: 'not_found', runId };
      let observedStatus = run.status;
      let resolution = await resolveRun(run);
      if (resolution.kind === 'attention') {
        getLog().debug(
          { runId, wakeSource, attention: resolution.attention.kind },
          'run_attention.resolved'
        );
        return { kind: 'attention', attention: resolution.attention };
      }

      if (resolution.kind === 'owner_required') {
        let liveOwnerAttached = await attachOwner(resolution);
        if (!liveOwnerAttached) {
          const latestRun = await workflowDb.getWorkflowRun(runId);
          if (!latestRun) return { kind: 'not_found', runId };
          observedStatus = latestRun.status;
          resolution = await resolveRun(latestRun);
          if (resolution.kind === 'attention') {
            return { kind: 'attention', attention: resolution.attention };
          }
          if (resolution.kind === 'owner_required') {
            liveOwnerAttached = await attachOwner(resolution);
            if (!liveOwnerAttached) {
              if (controlHandoffUntil !== undefined && Date.now() < controlHandoffUntil) {
                pendingWake = undefined;
              } else if (isNonTerminalStatus(latestRun.status)) {
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
        if (liveOwnerAttached && !attached) {
          const verifiedRun = await workflowDb.getWorkflowRun(runId);
          if (!verifiedRun) return { kind: 'not_found', runId };
          observedStatus = verifiedRun.status;
          const verified = await resolveRun(verifiedRun);
          if (verified.kind === 'attention') {
            return { kind: 'attention', attention: verified.attention };
          }
          if (verified.kind !== 'owner_required') {
            discardOwnerWatch();
          } else if ((await attachOwner(verified)) && !ownerWatchEnded) {
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
