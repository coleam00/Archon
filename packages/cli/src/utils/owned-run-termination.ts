import {
  deferRunSlotRelease,
  finishForcedRunSlotCleanup,
  holdRunSlotRelease,
  withRunSlotReleaseScope,
} from '@archon/workflows/run-slot-release';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { RunLiveOwner } from '@archon/core/services/run-live-owner';
import type { RunStopSignal } from '@archon/workflows/schemas/run-terminal-reason';
import { isExecNodeRecord, readNodeRecordEvent } from '@archon/workflows/node-record-reader';
import { COMPLETED_HOST_COMMAND_WARNING } from '@archon/workflows/host-command-cleanup';
import { isContainerRun } from '@archon/workflows/schemas/workflow-run';
import { recordNodeProcessTrees } from '@archon/workflows/subprocess';
import { createLogger } from '@archon/paths';
import { exitWithDrain, trackRunTerminationCleanup } from './exit-with-drain';

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
   * `finally`. A rejection defers immediate admission until operator recovery.
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
          advisories: priorHostCommands(runId).then(hasPriorCommands =>
            hasPriorCommands ? [COMPLETED_HOST_COMMAND_WARNING] : prepared.advisories
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
    let ownedSettlement = false;
    log.info({ runId, signal }, 'workflow.process_terminating');
    const cleanup = withRunSlotReleaseScope(async () => {
      const releaseHold = holdRunSlotRelease(input.store, runId);
      try {
        if (liveOwner.isStopRequested()) {
          log.info({ runId, signal }, 'workflow.operator_stop_leaves_lifecycle_to_controller');
          return;
        }
        if (input.isExecutionSettled?.()) ownedSettlement = true;
        else {
          const expectedExecutionClaim = input.getExecutionClaim();
          if (expectedExecutionClaim !== undefined) {
            cleanupAllowed = false;
            const { failed } = await input.store.failWorkflowRun(
              runId,
              `Process terminated (${signal})`,
              { exitReason: 'process_terminated', signal, expectedExecutionClaim }
            );
            cleanupAllowed = failed;
            ownedSettlement = failed;
          }
        }
        if (!registered && !ownedSettlement) return;
        if (!cleanupAllowed) {
          deferRunSlotRelease();
          console.error(
            `\nWARNING: run ${runId} could not be confirmed as owned on ${signal}; ` +
              'cleanup was skipped, so subprocesses and any isolation container may still be running. ' +
              `Inspect ownership before stopping them: archon workflow get ${runId}. ` +
              'Inspect containers with: docker ps -a --filter label=diy.archon.managed=true'
          );
          return;
        }
        // The terminal write must win before ending node trees, or the executor can
        // record an ordinary node failure and lose the signal's stop reason.
        await nodeTrees?.end();
        await input.teardown?.(signal);
        await liveOwner.close();
        if (ownedSettlement) await finishForcedRunSlotCleanup(input.store, runId);
      } catch (err) {
        deferRunSlotRelease();
        log.error({ err, runId }, 'workflow.termination_cleanup_failed');
        console.error(
          (cleanupAllowed
            ? `\nWARNING: run ${runId} cleanup failed on ${signal}: ${String(err)}. `
            : `\nWARNING: run ${runId} could not be confirmed as owned on ${signal}: ${String(err)}. `) +
            `Stop remaining processes and containers before draining; inspect with archon workflow get ${runId}.`
        );
      } finally {
        await releaseHold();
      }
    });
    trackRunTerminationCleanup(cleanup);
    void cleanup.finally(() => {
      // A forced exit skips the executor finalizer; only confirmed cleanup above
      // can finish its hold. The killed-owner backstop handles all other cases.
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
