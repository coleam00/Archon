import { expect, test } from 'bun:test';
import { latestResultsOnItem } from './run-result';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';

const item: WorkflowItem = { id: 'item-row', projectKey: 'acme/web', key: 'issue-7' };

const older: WorkflowRun = {
  origin: null,
  id: 'older-build',
  workflow_name: 'build',
  conversation_id: null,
  parent_conversation_id: null,
  codebase_id: null,
  status: 'completed',
  outcome: null,
  completed_outcome: null,
  user_message: '',
  metadata: {},
  active_phase_started_at: null,
  started_at: new Date('2026-11-01T10:00:00.000Z'),
  completed_at: new Date('2026-11-01T10:05:00.000Z'),
  last_activity_at: null,
  working_path: null,
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
  item_id: item.id,
};

test('an unreadable item run fails the read instead of yielding an older run as the latest', async () => {
  let eventsRead = false;
  const read = latestResultsOnItem(
    {
      getItemRuns: async () => ({
        item,
        runs: [older, { type: 'degraded', reason: 'run_unreadable', runId: 'lost-run' }],
        descendantIds: [],
      }),
      listEventsForRuns: async () => {
        eventsRead = true;
        return new Map();
      },
    },
    item,
    new Map([['build', { workflow: 'build' }]])
  );
  await expect(read).rejects.toThrow('item runs lost-run did not read');
  expect(eventsRead).toBe(false);
});
