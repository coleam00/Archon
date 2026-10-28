import type { WorkflowRunStatus } from '../schemas';
import type { WorkflowDeps } from '../deps';
import { runSubprocess } from '../subprocess';
import { getLog } from './log';

/** Throttle state for cancel checks (reads — no write contention in WAL mode) */
export const lastNodeCancelCheck = new Map<string, number>();

export const CANCEL_CHECK_INTERVAL_MS = 10_000;

/**
 * Policy for the during-streaming cancel check: should the currently-streaming
 * node be allowed to continue for a given observed run status?
 *
 * - `running`: the normal case → continue.
 * - `paused`: a concurrent approval node in the same topological layer has
 *   transitioned the run to paused. The streaming node should finish its own
 *   output; workflow progression is gated by the approval node, not by tearing
 *   down unrelated in-flight streams. See the doc comment on
 *   `workflowRunStatusSchema` (schemas/run-status.ts), where this contract is
 *   also stated on the status type itself.
 * - `null` (run deleted), `cancelled`, `failed`, `completed`, or any other
 *   state → abort the stream.
 *
 * Exported for unit testing; the agent node's streaming-cancel check
 * (`dag/nodes/agent/agent-stream.ts`) only fires once per 10s (CANCEL_CHECK_INTERVAL_MS), so
 * integration-level coverage of the policy is timing-sensitive and flaky.
 */
export function shouldContinueStreamingForStatus(status: WorkflowRunStatus | null): boolean {
  return status === 'running' || status === 'paused';
}

export async function waitForNodeRetry(
  store: Pick<WorkflowDeps['store'], 'getWorkflowRunStatus'>,
  runId: string,
  nodeId: string,
  delayMs: number
): Promise<void> {
  for (let remaining = delayMs; remaining > 0; ) {
    // A failed status read is not a stop signal: keep waiting, as the streaming check does.
    try {
      if (!shouldContinueStreamingForStatus(await store.getWorkflowRunStatus(runId))) return;
    } catch (statusErr) {
      getLog().warn(
        { err: statusErr as Error, workflowRunId: runId, nodeId },
        'dag.status_check_failed'
      );
    }
    const sliceMs = Math.min(remaining, CANCEL_CHECK_INTERVAL_MS);
    await new Promise(resolve => setTimeout(resolve, sliceMs));
    remaining -= sliceMs;
  }
}

// A subprocess has no message stream to piggyback a check on, so it polls on its own timer,
// short enough that a cancel stops its tree within about a second.
export const SUBPROCESS_STOP_CHECK_INTERVAL_MS = 1_000;

/**
 * `runSubprocess` for a node of `runId`, ending its tree when that run stops; the
 * rejection is then marked `cancelled`. Only this run's status aborts it, so another
 * run's subprocess is never signalled.
 */
export async function runSubprocessUntilRunStops(
  store: Pick<WorkflowDeps['store'], 'getWorkflowRunStatus'>,
  runId: string,
  nodeId: string,
  ...[execContext, cmd, args, options]: Parameters<typeof runSubprocess>
): ReturnType<typeof runSubprocess> {
  const controller = new AbortController();
  let reading = false;
  const poll = setInterval(() => {
    if (reading) return;
    reading = true;
    store
      .getWorkflowRunStatus(runId)
      .then(status => {
        if (controller.signal.aborted || shouldContinueStreamingForStatus(status)) return;
        clearInterval(poll);
        getLog().info(
          { workflowRunId: runId, nodeId, status },
          'dag.stop_detected_during_subprocess'
        );
        controller.abort();
      })
      // A failed status read is not a stop signal: keep polling, as the streaming check does.
      .catch((statusErr: unknown) => {
        getLog().warn(
          { err: statusErr as Error, workflowRunId: runId, nodeId },
          'dag.status_check_failed'
        );
      })
      .finally(() => {
        reading = false;
      });
  }, SUBPROCESS_STOP_CHECK_INTERVAL_MS);
  try {
    return await runSubprocess(execContext, cmd, args, {
      ...options,
      abortSignal: controller.signal,
    });
  } finally {
    clearInterval(poll);
  }
}

/** Throttle state for activity heartbeat writes (only used for stale/zombie detection) */
export const lastNodeActivityUpdate = new Map<string, number>();

export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;
