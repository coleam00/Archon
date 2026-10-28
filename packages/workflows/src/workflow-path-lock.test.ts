import { expect, test } from 'bun:test';
import { workflowRunStatusSchema } from './schemas/workflow-run';
import { holdsWorkflowPath, STALE_PENDING_AGE_MS } from './workflow-path-lock';

test('path occupancy expires only pending rows at the dispatch-window boundary', () => {
  const now = 1_000_000;
  for (const status of workflowRunStatusSchema.options) {
    for (const age of [STALE_PENDING_AGE_MS - 1, STALE_PENDING_AGE_MS, STALE_PENDING_AGE_MS + 1]) {
      expect(holdsWorkflowPath({ status, started_at: new Date(now - age) }, now)).toBe(
        status === 'running' ||
          status === 'paused' ||
          (status === 'pending' && age < STALE_PENDING_AGE_MS)
      );
    }
  }
});
