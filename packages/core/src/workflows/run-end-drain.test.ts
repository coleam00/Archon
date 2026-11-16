import { describe, expect, test } from 'bun:test';
import { drainAfterRunEnds, serializedDrain, type TerminalWriters } from './run-end-drain';

function terminalStore(wins: boolean): TerminalWriters {
  const store = {
    completeWorkflowRun: async (): Promise<void> => {
      if (!wins) throw new Error('Workflow run not found or not in running state');
    },
    failWorkflowRun: async () => ({ failed: wins }),
    cancelWorkflowRun: async () => ({ cancelled: wins }),
    cancelFanOutRun: async () => ({ cancelled: wins }),
    resolveAndCancelApprovalGate: async () => ({ resolved: wins }),
    cancelResumableRunsForConversation: async () => [],
  };
  // Only the terminal writers are exercised; their real arguments are irrelevant here.
  return store as unknown as TerminalWriters;
}

describe('the drain after a run ends', () => {
  test('follows only a terminal write that won, and never fails the write', async () => {
    const ended: string[] = [];
    const won = drainAfterRunEnds(terminalStore(true), async runId => {
      ended.push(runId);
      throw new Error('host unavailable');
    });
    await won.completeWorkflowRun('a', { duration_ms: 1 });
    expect(await won.failWorkflowRun('b', 'boom')).toEqual({ failed: true });
    expect(await won.cancelWorkflowRun('c')).toEqual({ cancelled: true });
    expect(ended).toEqual(['a', 'b', 'c']);

    const lost = drainAfterRunEnds(terminalStore(false), async runId => {
      ended.push(runId);
    });
    await expect(lost.completeWorkflowRun('d', { duration_ms: 1 })).rejects.toThrow();
    expect(await lost.failWorkflowRun('e', 'boom')).toEqual({ failed: false });
    expect(await lost.cancelWorkflowRun('f')).toEqual({ cancelled: false });
    expect(ended).toEqual(['a', 'b', 'c']);
  });

  test('a close of an ask is followed only when its settlement caused starts', async () => {
    const caused = [{ receipt: { id: 'receipt-1' } }];
    const closes = [
      { kind: 'closed', ask: { runId: 'asking-run' }, settled: false, startReceipts: [] },
      { kind: 'closed', ask: { runId: 'asking-run' }, settled: true, startReceipts: caused },
      { kind: 'unchanged', ask: { runId: 'asking-run' } },
    ];
    const store = {
      ...terminalStore(true),
      answerItemAsk: async () => closes.shift(),
      withdrawItemAsk: async () => closes.shift(),
    } as unknown as TerminalWriters;
    const followed: [string, unknown][] = [];
    const wrapped = drainAfterRunEnds(store, async (runId, receipts) => {
      followed.push([runId, receipts]);
    });
    const input = { askId: 'a', via: 'cli', by: null, fromRun: null } as const;
    await wrapped.answerItemAsk({ ...input, answer: { text: '' } });
    await wrapped.withdrawItemAsk(input);
    await wrapped.answerItemAsk({ ...input, answer: { text: '' } });
    expect(followed).toEqual([['asking-run', caused]]);
  });

  test('a run ended inside a drain schedules one more pass instead of a nested one', async () => {
    let passes = 0;
    let depth = 0;
    let deepest = 0;
    const drain: () => Promise<void> = serializedDrain(async () => {
      passes++;
      depth++;
      deepest = Math.max(deepest, depth);
      // The first pass ends a run (a launch that failed), which asks for a drain again.
      if (passes === 1) await drain();
      depth--;
    });
    await drain();
    expect(passes).toBe(2);
    expect(deepest).toBe(1);
  });

  test('a pass that fails still runs the pass requested during it, then throws', async () => {
    let passes = 0;
    const drain: () => Promise<void> = serializedDrain(async () => {
      passes++;
      if (passes === 1) {
        // A run ended during this pass asked for another, and was told it was covered.
        await drain();
        throw new Error('host unavailable');
      }
    });
    await expect(drain()).rejects.toThrow('host unavailable');
    expect(passes).toBe(2);
  });
});
