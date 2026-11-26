import { expect, test } from 'bun:test';
import { mockWorkflowRun } from '../test/mocks/workflow-run';
import { readOpenWorkRuns } from './open-work';

test('open work propagates an ancestor query failure', async () => {
  const failure = new Error('Ancestor query failed');
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
