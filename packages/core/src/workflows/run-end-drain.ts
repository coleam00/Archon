/**
 * The moment a run ends, the process that ended it drains its own trigger host, so a
 * start that end caused, or one queued behind the slot it released, is admitted with no
 * other command.
 *
 * Only the process's own host: a binding names the host it executes on, and starting
 * another host's work here would run it where its binding did not ask. Another host's
 * queue is that host's to drain. Nothing here is needed for correctness: the starts are
 * durable, and a crash before the drain leaves them for the host's next drain.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from '@archon/workflows/store';

const log = createLogger('run-end-drain');

export type TerminalWriters = Pick<
  IWorkflowStore,
  | 'completeWorkflowRun'
  | 'failWorkflowRun'
  | 'cancelWorkflowRun'
  | 'cancelFanOutRun'
  | 'resolveAndCancelApprovalGate'
  | 'cancelResumableRunsForConversation'
>;

/**
 * `store` with every terminal writer followed, when it won, by `afterRunEnded`. The end
 * is already durable when it is called, so a failure there is logged with the run and
 * never thrown: the caller's run did end.
 */
export function drainAfterRunEnds<S extends TerminalWriters>(
  store: S,
  afterRunEnded: (runId: string) => Promise<void>
): S {
  const after = async (runId: string): Promise<void> => {
    try {
      await afterRunEnded(runId);
    } catch (error) {
      log.error({ err: error as Error, workflowRunId: runId }, 'run_end_drain.failed');
    }
  };
  return {
    ...store,
    completeWorkflowRun: async (id, ...rest) => {
      await store.completeWorkflowRun(id, ...rest);
      await after(id);
    },
    failWorkflowRun: async (id, ...rest) => {
      const result = await store.failWorkflowRun(id, ...rest);
      if (result.failed) await after(id);
      return result;
    },
    cancelWorkflowRun: async (id, ...rest) => {
      const result = await store.cancelWorkflowRun(id, ...rest);
      if (result.cancelled) await after(id);
      return result;
    },
    cancelFanOutRun: async (id, ...rest) => {
      const result = await store.cancelFanOutRun(id, ...rest);
      if (result.cancelled) await after(id);
      return result;
    },
    resolveAndCancelApprovalGate: async (id, ...rest) => {
      const result = await store.resolveAndCancelApprovalGate(id, ...rest);
      if (result.resolved) await after(id);
      return result;
    },
    cancelResumableRunsForConversation: async (...args) => {
      const cancelled = await store.cancelResumableRunsForConversation(...args);
      for (const run of cancelled) await after(run.id);
      return cancelled;
    },
  };
}

/**
 * One drain at a time per process: a request while a pass runs schedules exactly one
 * more, which covers it. A drain can itself end a run (a launch that fails before its
 * first node), and that end must not start a second drain inside the first.
 */
export function serializedDrain(pass: () => Promise<void>): () => Promise<void> {
  let active = false;
  let again = false;
  return async () => {
    if (active) {
      again = true;
      return;
    }
    active = true;
    try {
      do {
        again = false;
        await pass();
      } while (again);
    } finally {
      active = false;
    }
  };
}
