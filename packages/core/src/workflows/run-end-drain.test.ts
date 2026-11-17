import { describe, expect, test } from 'bun:test';
import type { ItemAskCloseResult, StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import { drainAfterRunEnds, serializedDrain, type TerminalWriters } from './run-end-drain';

/** Terminal writers whose writes win or lose, and whose ask closes return `closes` in order. */
function terminalStore(wins: boolean, closes: ItemAskCloseResult[] = []): TerminalWriters {
  const nextClose = async (): Promise<ItemAskCloseResult> => {
    const close = closes.shift();
    if (close === undefined) throw new Error('no ask close left in the fixture');
    return close;
  };
  return {
    completeWorkflowRun: async () => {
      if (!wins) throw new Error('Workflow run not found or not in running state');
    },
    failWorkflowRun: async () => ({ failed: wins }),
    cancelWorkflowRun: async () => ({ cancelled: wins }),
    cancelFanOutRun: async () => ({ cancelled: wins }),
    resolveAndCancelApprovalGate: async () => ({ resolved: wins }),
    cancelResumableRunsForConversation: async () => [],
    answerItemAsk: nextClose,
    withdrawItemAsk: nextClose,
  };
}

const ASK: StoredItemAsk = {
  id: 'ask-1',
  itemId: 'item-1',
  runId: 'asking-run',
  workflowName: 'plan',
  position: 0,
  ask: {
    question: 'Keep the flag?',
    context: 'The plan can go two ways.',
    options: [
      { id: 'keep', does: 'Keep the flag.', cost: 'None.' },
      { id: 'drop', does: 'Drop the flag.', cost: 'A migration.' },
    ],
    recommendation: { option: 'keep', why: 'Least change.' },
    artifacts: [],
  },
  openedAt: '2026-11-16T10:00:00.000Z',
  closed: null,
};

const CAUSED: SourceReceiptAcceptance = {
  outcome: 'unmatched',
  reason: 'no binding matched',
  bindings: [],
  receipt: {
    id: '00000000-0000-4000-8000-000000000001',
    sourceInstanceId: 'build-after-answers',
    deliveryId: 'asking-run',
    contentDigest: 'digest',
    receivedAt: '2026-11-16T10:00:00.000Z',
    occurredAt: null,
    sourceActor: null,
  },
};

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
    const store = terminalStore(true, [
      { kind: 'closed', ask: ASK, settled: false, startReceipts: [] },
      { kind: 'closed', ask: ASK, settled: true, startReceipts: [CAUSED] },
      { kind: 'unchanged', ask: ASK },
    ]);
    const followed: [string, readonly SourceReceiptAcceptance[]][] = [];
    const wrapped = drainAfterRunEnds(store, async (runId, receipts) => {
      followed.push([runId, receipts]);
    });
    const input = { askId: 'a', via: 'cli', by: null, fromRun: null } as const;
    await wrapped.answerItemAsk({ ...input, answer: { text: '' } });
    await wrapped.withdrawItemAsk(input);
    await wrapped.answerItemAsk({ ...input, answer: { text: '' } });
    expect(followed).toEqual([['asking-run', [CAUSED]]]);
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
