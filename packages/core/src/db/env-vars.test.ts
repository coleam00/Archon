import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

mock.module('@archon/paths', () => ({
  createLogger: mock(() => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
    fatal: mock(() => {}),
  })),
}));

import { getCodebaseEnvVars, setCodebaseEnvVar, deleteCodebaseEnvVar } from './env-vars';

describe('env-vars', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('getCodebaseEnvVars', () => {
    test('returns flat Record from rows', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { key: 'FOO', value: 'bar' },
          { key: 'BAZ', value: 'qux' },
        ])
      );
      const result = await getCodebaseEnvVars('codebase-1');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
      expect(mockQuery.mock.calls[0][1]).toEqual(['codebase-1']);
    });

    test('returns empty object when no rows', async () => {
      const result = await getCodebaseEnvVars('codebase-1');
      expect(result).toEqual({});
    });
  });

  describe('setCodebaseEnvVar', () => {
    test('issues upsert with correct params', async () => {
      await setCodebaseEnvVar('codebase-1', 'MY_KEY', 'my_value');
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('DO UPDATE SET value');
      expect(params[1]).toBe('codebase-1');
      expect(params[2]).toBe('MY_KEY');
      expect(params[3]).toBe('my_value');
    });
  });

  describe('deleteCodebaseEnvVar', () => {
    test('issues DELETE with codebaseId and key', async () => {
      await deleteCodebaseEnvVar('codebase-1', 'MY_KEY');
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('DELETE FROM remote_agent_codebase_env_vars');
      expect(params).toEqual(['codebase-1', 'MY_KEY']);
    });
  });
});
