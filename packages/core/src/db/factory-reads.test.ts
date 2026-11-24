// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = createMockQuery();
// The rest of the connection module stays real on purpose: the read only touches `pool`.
const connection = { ...(await import('./connection')) };

// Mock the connection module before importing the module under test.
mock.module('./connection', () => ({
  ...connection,
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import { listRunWorkflowNames } from './factory-reads';

describe('listRunWorkflowNames', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  test('asks for the given names in one codebase, each once', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ workflow_name: 'acme/kit:plan' }]));

    const result = await listRunWorkflowNames('cb-1', ['acme/kit:plan', 'deliver', 'deliver']);

    expect(result).toEqual(['acme/kit:plan']);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT DISTINCT workflow_name FROM remote_agent_workflow_runs WHERE codebase_id = $1 AND workflow_name IN ($2, $3)',
      ['cb-1', 'acme/kit:plan', 'deliver']
    );
  });

  test('no names asks nothing', async () => {
    expect(await listRunWorkflowNames('cb-1', [])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a query failure is rethrown with its cause', async () => {
    mockQuery.mockRejectedValueOnce(new Error('offline'));
    // The original error is kept as evidence; the wrapping sentence is not asserted.
    await expect(listRunWorkflowNames('cb-1', ['plan'])).rejects.toThrow('offline');
  });
});
