/**
 * The moment a run ends, the process that ended it starts the starts that end caused, on
 * the host each binding names, and drains its own trigger host when it serves one, so a
 * start queued behind the slot it released is admitted with no other command. A close of
 * an ask that settles its set is followed the same way when the settlement caused starts,
 * under the id of the run that left the asks.
 *
 * It never drains a host it does not serve beyond its own run's starts: another host's
 * queue is that host's to drain. Nothing here is needed for correctness: the starts are
 * durable, and a crash before this leaves them for their host's next drain.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';

const log = createLogger('run-end-drain');

export type TerminalWriters = Pick<
  IWorkflowStore,
  | 'completeWorkflowRun'
  | 'failWorkflowRun'
  | 'cancelWorkflowRun'
  | 'cancelFanOutRun'
  | 'resolveAndCancelApprovalGate'
  | 'cancelResumableRunsForConversation'
  | 'answerItemAsk'
  | 'withdrawItemAsk'
>;

/**
 * `store` with every terminal writer followed, when it won, by `afterRunEnded`, given the
 * starts a completion wrote (none for any other end), and every close of an ask whose
 * settlement wrote starts followed by it, given those starts. The end is already durable when it
 * is called, so a failure there is logged with the run and never thrown: the caller's run
 * did end.
 */
export function drainAfterRunEnds<S extends TerminalWriters>(
  store: S,
  afterRunEnded: (runId: string, caused: readonly SourceReceiptAcceptance[]) => Promise<void>
): S {
  const after = async (
    runId: string,
    caused: readonly SourceReceiptAcceptance[] = []
  ): Promise<void> => {
    try {
      await afterRunEnded(runId, caused);
    } catch (error) {
      log.error({ err: error as Error, workflowRunId: runId }, 'run_end_drain.failed');
    }
  };
  return {
    ...store,
    completeWorkflowRun: async (id, completion, metadata, result) => {
      // A completion that lost throws, so only a won one writes and starts its receipts.
      await store.completeWorkflowRun(id, completion, metadata, result);
      await after(id, result?.startReceipts);
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
    // An answer frees no slot, so only a settlement that caused starts is followed.
    answerItemAsk: async input => {
      const result = await store.answerItemAsk(input);
      if (result.kind === 'closed' && result.startReceipts.length > 0)
        await after(result.ask.runId, result.startReceipts);
      return result;
    },
    withdrawItemAsk: async input => {
      const result = await store.withdrawItemAsk(input);
      if (result.kind === 'closed' && result.startReceipts.length > 0)
        await after(result.ask.runId, result.startReceipts);
      return result;
    },
  };
}

/**
 * One drain at a time per process: a request while a pass runs schedules exactly one
 * more, which covers it. A drain can itself end a run (a launch that fails before its
 * first node), and that end must not start a second drain inside the first. A failed
 * pass does not cancel the one requested meanwhile, whose caller was already told it
 * was covered: that pass still runs, and the first failure is thrown after it.
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
    let failure: { error: unknown } | undefined;
    try {
      do {
        again = false;
        try {
          await pass();
        } catch (error) {
          failure ??= { error };
        }
      } while (again);
    } finally {
      active = false;
    }
    if (failure) throw failure.error;
  };
}
