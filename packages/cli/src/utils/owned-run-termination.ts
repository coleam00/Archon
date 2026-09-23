import * as workflowDb from '@archon/core/db/workflows';
import type { RunLiveOwner } from '@archon/core/services/run-live-owner';
import { createLogger } from '@archon/paths';
import { exitWithDrain } from './exit-with-drain';

type TerminationSignal = 'SIGTERM' | 'SIGINT';

export interface OwnedRunTerminationInput {
  /** The one run this process proved it executes. Never a conversation-wide lookup. */
  runId: string;
  /** Logger module of the command that owns the run, so its lines name that command. */
  logModule: string;
  liveOwner: Pick<RunLiveOwner, 'close' | 'isStopRequested'>;
  /**
   * Resources the forced exit would otherwise strand, because it skips the caller's
   * `finally`. Report its own failures; a rejection is dropped.
   */
  teardown?: (signal: TerminationSignal) => Promise<void>;
}

/**
 * Settle the owned run on SIGTERM/SIGINT, then exit (#1123). Returns the function that
 * removes the handlers; call it once the run's lifecycle is settled, so a late signal
 * never touches a settled run and repeated runs in one process do not stack handlers.
 *
 * Only a CLI process that executes exactly one run may install this: the handlers are
 * process-wide and end the process. A long-lived host running many runs must not.
 */
export function registerOwnedRunTermination(input: OwnedRunTerminationInput): () => void {
  const { runId, liveOwner } = input;
  const log = createLogger(input.logModule);
  let terminating = false;
  const cleanup = (signal: TerminationSignal): void => {
    if (terminating) return;
    terminating = true;
    log.info({ runId, signal }, 'workflow.process_terminating');
    (async (): Promise<void> => {
      if (liveOwner.isStopRequested()) {
        // The exact-run controller has proved ownership and is terminating this
        // process tree. It records `cancelled` only after termination succeeds;
        // do not race it by translating the operator's stop into generic failure.
        log.info({ runId, signal }, 'workflow.operator_stop_leaves_lifecycle_to_controller');
        return;
      }
      const status = await workflowDb.getWorkflowRunStatus(runId);
      if (status !== 'running') {
        // Externally transitioned (paused at a new gate, completed, cancelled,
        // failed) or never claimed (still pending) — not this handler's to mutate.
        log.info({ runId, status, signal }, 'workflow.termination_skip_not_running');
        return;
      }
      // Genuine interrupt of the run this process is driving. failWorkflowRun's
      // status CAS closes the read-then-write window: if the executor commits a gate
      // pause between the read above and this write, the CAS misses and the run
      // stays paused.
      await workflowDb.failWorkflowRun(runId, `Process terminated (${signal})`);
    })()
      .catch((err: unknown) => {
        const e = err as Error;
        log.error(
          { err: e, errorType: e.constructor.name, runId },
          'workflow.termination_cleanup_failed'
        );
      })
      .then(() => input.teardown?.(signal))
      .catch(() => undefined)
      .then(async () => {
        // A detached cancel already rang the handoff frame and must keep its lease
        // open while the controller terminates this process tree. Every other
        // graceful signal rings ordinary attention before the forced exit.
        if (!liveOwner.isStopRequested()) await liveOwner.close();
      })
      .catch((error: unknown) => {
        log.error({ err: error as Error, runId }, 'workflow.live_owner_close_failed');
      })
      .finally(() => {
        // Drain queued output before exiting; a bare process.exit truncates it (#2400).
        void exitWithDrain(1);
      });
  };
  const sigtermHandler = (): void => {
    cleanup('SIGTERM');
  };
  const sigintHandler = (): void => {
    cleanup('SIGINT');
  };
  process.once('SIGTERM', sigtermHandler);
  process.once('SIGINT', sigintHandler);
  return () => {
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
  };
}
