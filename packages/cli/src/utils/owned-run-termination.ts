import type { IWorkflowStore } from '@archon/workflows/store';
import type { RunLiveOwner } from '@archon/core/services/run-live-owner';
import type { RunStopSignal } from '@archon/workflows/schemas/run-terminal-reason';
import { isExecNodeRecord, readNodeRecordEvent } from '@archon/workflows/node-record-reader';
import { COMPLETED_HOST_COMMAND_WARNING } from '@archon/workflows/host-command-cleanup';
import { isContainerRun } from '@archon/workflows/schemas/workflow-run';
import { recordNodeProcessTrees } from '@archon/workflows/subprocess';
import { createLogger } from '@archon/paths';
import { exitWithDrain } from './exit-with-drain';

// The signals this handler settles a run on are the ones it records as the stop
// reason's `signal`, so the set is derived from that contract, never re-listed.
type TerminationSignal = RunStopSignal;

export interface OwnedRunTerminationInput {
  store: Pick<
    IWorkflowStore,
    'failWorkflowRun' | 'getWorkflowRun' | 'listWorkflowEvents' | 'findChildRuns'
  >;
  /** The one run this process proved it executes. Never a conversation-wide lookup. */
  runId: string;
  /** The engine supplies this execution's claim; undefined until admission. */
  getExecutionClaim: () => string | null | undefined;
  /** A result settled by this process retains resource cleanup authority after the status write. */
  isExecutionSettled?: () => boolean;
  /** Logger module of the command that owns the run, so its lines name that command. */
  logModule: string;
  liveOwner: Pick<RunLiveOwner, 'close' | 'isStopRequested' | 'registerTerminationPreparation'>;
  /** Detached POSIX commands use separate, parent-owned process groups. */
  detachedProcessOwner: boolean;
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
  const detached = input.detachedProcessOwner && process.platform !== 'win32';
  const detachedTrees = detached ? recordNodeProcessTrees({ mode: 'detached-posix' }) : undefined;
  const nodeTrees =
    detachedTrees ?? (input.detachedProcessOwner ? undefined : recordNodeProcessTrees());
  const unregisterPreparation = detachedTrees
    ? liveOwner.registerTerminationPreparation(() => {
        const prepared = detachedTrees.prepareTermination();
        return {
          ...prepared,
          ready: Promise.all([prepared.ready, priorHostCommands(runId)]).then(
            ([warnings, hasPriorCommands]) =>
              hasPriorCommands && !warnings.includes(COMPLETED_HOST_COMMAND_WARNING)
                ? [...warnings, COMPLETED_HOST_COMMAND_WARNING]
                : warnings
          ),
        };
      })
    : undefined;
  async function priorHostCommands(id: string): Promise<boolean> {
    const run = await input.store.getWorkflowRun(id);
    if (run && !isContainerRun(run)) {
      const events = await input.store.listWorkflowEvents(id);
      if (
        events.some(event => {
          const record = readNodeRecordEvent(event);
          return record?.eventType === 'node_started' && isExecNodeRecord(record);
        })
      )
        return true;
    }
    for (const child of await input.store.findChildRuns(id)) {
      if (await priorHostCommands(child.id)) return true;
    }
    return false;
  }
  let registered = true;
  let terminating = false;
  const cleanup = (signal: TerminationSignal): void => {
    if (!registered || terminating) return;
    terminating = true;
    let cleanupAllowed = true;
    log.info({ runId, signal }, 'workflow.process_terminating');
    (async (): Promise<void> => {
      if (liveOwner.isStopRequested()) {
        // The exact-run controller has proved ownership and is terminating this
        // process tree. It records `cancelled` only after termination succeeds;
        // do not race it by translating the operator's stop into generic failure.
        log.info({ runId, signal }, 'workflow.operator_stop_leaves_lifecycle_to_controller');
        return;
      }
      if (input.isExecutionSettled?.()) return;
      const expectedExecutionClaim = input.getExecutionClaim();
      if (expectedExecutionClaim === undefined) return;
      cleanupAllowed = false;
      const { failed } = await input.store.failWorkflowRun(
        runId,
        `Process terminated (${signal})`,
        {
          exitReason: 'process_terminated',
          signal,
          expectedExecutionClaim,
        }
      );
      cleanupAllowed = failed;
    })()
      .catch((err: unknown) => {
        const e = err as Error;
        log.error(
          { err: e, errorType: e.constructor.name, runId },
          'workflow.termination_cleanup_failed'
        );
      })
      // After the failed status write: ending a tree first lets the executor fail the
      // run through its own path and win the status write, losing stop_reason.
      .then(() => {
        if (!registered) return;
        if (cleanupAllowed) return nodeTrees?.end();
        return console.error(
          `\nWARNING: run ${runId} could not be confirmed as owned on ${signal}; ` +
            'cleanup was skipped, so subprocesses and any isolation container may still be running. ' +
            `Inspect ownership before stopping them: archon workflow get ${runId}. ` +
            'Inspect containers with: docker ps -a --filter label=diy.archon.managed=true'
        );
      })
      .catch((error: unknown) => {
        console.error(
          `\nWARNING: ${(error as Error).message} on ${signal}. Stop them before resuming this run.`
        );
      })
      .then(() => (registered && cleanupAllowed ? input.teardown?.(signal) : undefined))
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
    registered = false;
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
    unregisterPreparation?.();
    nodeTrees?.release();
  };
}

/**
 * Let in-flight setup settle before failing the run. Exiting or racing setup
 * would leave Docker work running after the claim becomes available to a successor.
 */
export function registerResumePreparationTermination(): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const interrupt = (signal: TerminationSignal): void => {
    controller.abort(new Error(`Resume preparation interrupted (${signal})`));
  };
  const sigint = (): void => interrupt('SIGINT');
  const sigterm = (): void => interrupt('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
    },
  };
}
