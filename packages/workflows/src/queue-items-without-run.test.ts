import { describe, expect, test } from 'bun:test';
import { askQueueItem } from './queue-items-without-run';
import type { StoredItemAsk } from './schemas/item-ask';

describe('an ask as a queue item', () => {
  test("carries each declared option's label, so Needs you shows the option's words", async () => {
    const stored: StoredItemAsk = {
      id: 'a1',
      itemId: 'item-1',
      runId: 'run-gone',
      workflowName: 'landgate',
      position: 0,
      ask: {
        question: 'Merge it?',
        context: 'Checks passed.',
        options: [
          { id: 'land', label: 'merge it', does: 'Merges it.', cost: 'None.' },
          { id: 'drop', does: 'Drops it.', cost: 'The work.' },
        ],
        recommendation: null,
        artifacts: [],
      },
      openedAt: '2026-06-03T10:00:00.000Z',
      closed: null,
    };
    const item = await askQueueItem(
      {
        getItem: async () => null,
        getItemPriority: async () => null,
        getWorkflowRun: async () => null,
        getCodebase: async () => null,
      },
      stored
    );
    expect(item.options.map(option => [option.id, option.label])).toEqual([
      ['land', 'merge it'],
      ['drop', undefined],
      ['other', 'Other'],
    ]);
  });
});
