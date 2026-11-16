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
});
