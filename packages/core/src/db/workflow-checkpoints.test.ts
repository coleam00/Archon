import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowCheckpointRow } from '../schemas/workflow-checkpoint';
import { createQueryResult } from '../test/mocks/database';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: { query: mockQuery },
}));

import { findLatestCheckpointForRetry } from './workflow-checkpoints';

function makeCheckpoint(overrides: Partial<WorkflowCheckpointRow> = {}): WorkflowCheckpointRow {
  return {
    workflow_run_id: 'run-1',
    node_id: 'target',
    retry_epoch: 1,
    checkpoint_ref: 'refs/archon/checkpoints/run-1/1/target',
    commit_sha: 'abc123',
    created_commit: false,
    fallback_from_node_id: null,
    created_at: '2026-06-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('workflow checkpoint DB helpers', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  describe('findLatestCheckpointForRetry', () => {
    test('returns the latest target checkpoint before checking upstream fallbacks', async () => {
      const target = makeCheckpoint({
        node_id: 'target',
        retry_epoch: 2,
        checkpoint_ref: 'refs/archon/checkpoints/run-1/2/target',
      });
      mockQuery.mockResolvedValueOnce(createQueryResult([target]));

      const result = await findLatestCheckpointForRetry('run-1', 'target', ['upstream'], 3);

      expect(result).toEqual(target);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ORDER BY retry_epoch DESC'), [
        'run-1',
        'target',
        3,
      ]);
    });

    test('falls back to the first upstream dependency with a checkpoint when target has none', async () => {
      const upstream = makeCheckpoint({
        node_id: 'build',
        checkpoint_ref: 'refs/archon/checkpoints/run-1/1/build',
      });
      mockQuery
        .mockResolvedValueOnce(createQueryResult([]))
        .mockResolvedValueOnce(createQueryResult([upstream]));

      const result = await findLatestCheckpointForRetry('run-1', 'target', ['build', 'setup'], 1);

      expect(result).toEqual({ ...upstream, fallback_from_node_id: 'build' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('WHERE workflow_run_id = $1 AND node_id = $2'),
        ['run-1', 'target', 1]
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('WHERE workflow_run_id = $1 AND node_id = $2'),
        ['run-1', 'build', 1]
      );
    });
  });
});
