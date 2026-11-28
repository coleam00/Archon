import { expect, test, mock } from 'bun:test';
import type { ItemEnd } from '@archon/workflows/schemas/item-end';
import { mockWorkflowRun } from '../test/mocks/workflow-run';
import { readOpenWorkRuns } from './open-work';

test('open work reuses reads per run and item only within one listing', async () => {
  const parent = {
    ...mockWorkflowRun,
    id: 'parent',
    status: 'completed' as const,
    item_id: 'item',
    parent_run_id: null,
  };
  const candidates = Array.from({ length: 200 }, (_, index) => ({
    ...mockWorkflowRun,
    id: `child-${index}`,
    status: 'failed' as const,
    item_id: null,
    parent_run_id: parent.id,
  }));
  const healthy = {
    ...mockWorkflowRun,
    id: 'healthy',
    status: 'failed' as const,
    item_id: 'open-item',
    parent_run_id: null,
  };
  const end: ItemEnd = {
    kind: 'ended',
    id: 'end',
    reason: 'Done elsewhere.',
    at: new Date().toISOString(),
    via: 'cli',
    by: { declared: 'operator' },
    fromRun: null,
  };
  const store = {
    findOpenWorkRuns: async () => [...candidates, healthy],
    getWorkflowRunForAttention: mock(async () => parent),
    getHoldingItemEnd: mock(
      async (id: string): Promise<ItemEnd | null> => (id === parent.item_id ? end : null)
    ),
    listItemStarts: mock(async () => []),
  };
  expect(await readOpenWorkRuns(store, { limit: 1 })).toEqual([healthy]);
  expect(store.getWorkflowRunForAttention).toHaveBeenCalledTimes(1);
  expect(store.getHoldingItemEnd).toHaveBeenCalledTimes(2);
  expect(store.listItemStarts).toHaveBeenCalledTimes(1);

  store.getHoldingItemEnd.mockResolvedValue(null);
  expect(await readOpenWorkRuns(store, { limit: 1 })).toEqual([candidates[0]]);
  expect(store.getWorkflowRunForAttention).toHaveBeenCalledTimes(2);
  expect(store.getHoldingItemEnd).toHaveBeenCalledTimes(3);
});

test.each(['self', 'two-run'])(
  'open work isolates %s cycles before applying the limit',
  async mode => {
    const cyclic = {
      ...mockWorkflowRun,
      id: 'cyclic',
      status: 'failed' as const,
      parent_run_id: mode === 'self' ? 'cyclic' : 'other',
    };
    const other = { ...cyclic, id: 'other', parent_run_id: cyclic.id };
    const healthy = {
      ...mockWorkflowRun,
      id: 'healthy',
      status: 'failed' as const,
      item_id: null,
      parent_run_id: null,
    };
    const ancestry = mock(async () => other);
    const result = await readOpenWorkRuns(
      {
        findOpenWorkRuns: async () => [cyclic, healthy],
        getWorkflowRunForAttention: ancestry,
        getHoldingItemEnd: async () => null,
        listItemStarts: async () => [],
      },
      { limit: 1 }
    );
    expect(result).toEqual([healthy]);
    expect(ancestry).toHaveBeenCalledTimes(mode === 'self' ? 0 : 1);
  }
);

test('open work propagates an ancestor query failure', async () => {
  // Matching prose must not turn a store failure into structural-corruption containment.
  const failure = new Error('Cyclic workflow run ancestry at parent');
  await expect(
    readOpenWorkRuns(
      {
        findOpenWorkRuns: async () => [
          { ...mockWorkflowRun, status: 'failed', parent_run_id: 'parent' },
        ],
        getWorkflowRunForAttention: async () => {
          throw failure;
        },
        getHoldingItemEnd: async () => null,
        listItemStarts: async () => [],
      },
      { limit: 50 }
    )
  ).rejects.toBe(failure);
});
