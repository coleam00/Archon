import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import * as paths from '@archon/paths';
import * as connection from './connection';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

import { getCodebaseEnvVars, setCodebaseEnvVar, deleteCodebaseEnvVar } from './env-vars';

// Spy variable declarations
let spyPathsCreateLogger: ReturnType<typeof spyOn>;
let spyConnectionPoolQuery: ReturnType<typeof spyOn>;
let spyConnectionGetDialect: ReturnType<typeof spyOn>;

describe('env-vars', () => {
  beforeEach(() => {
    spyPathsCreateLogger = spyOn(paths, 'createLogger').mockReturnValue({
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      trace: mock(() => {}),
      fatal: mock(() => {}),
    } as ReturnType<typeof paths.createLogger>);
    spyConnectionPoolQuery = spyOn(connection.pool, 'query').mockImplementation(mockQuery);
    spyConnectionGetDialect = spyOn(connection, 'getDialect').mockReturnValue(mockPostgresDialect);
    mockQuery.mockClear();
  });

  afterEach(() => {
    spyPathsCreateLogger.mockRestore();
    spyConnectionPoolQuery.mockRestore();
    spyConnectionGetDialect.mockRestore();
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
