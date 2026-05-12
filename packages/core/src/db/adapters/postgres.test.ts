import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---- pg mock setup --------------------------------------------------------
// Must be declared before importing the module under test so that the mock
// is in place when PostgresAdapter's constructor calls `new Pool(...)`.

type MockQueryFn = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: unknown[]; rowCount: number }>;

interface MockClient {
  query: MockQueryFn;
  release: () => void;
}

// Mutable state shared between the mock factory and individual tests
let mockPoolQuery: MockQueryFn = async () => ({ rows: [], rowCount: 0 });
let mockClient: MockClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
  release: () => {},
};
let poolErrorHandler: ((err: Error) => void) | undefined;

const MockPool = mock(function MockPool(_config: unknown) {
  return {
    query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params),
    connect: async () => mockClient,
    on: (event: string, handler: (err: Error) => void) => {
      if (event === 'error') {
        poolErrorHandler = handler;
      }
    },
    end: async () => {},
  };
});

mock.module('pg', () => ({
  Pool: MockPool,
}));

// ---- also mock @archon/paths so logger calls don't blow up ----------------
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    debug: () => {},
    trace: () => {},
  }),
}));

// ---- import after mocks are registered ------------------------------------
import { PostgresAdapter, postgresDialect } from './postgres';

// ---------------------------------------------------------------------------

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    // Reset shared mock state before each test
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    mockClient = {
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    };
    poolErrorHandler = undefined;

    adapter = new PostgresAdapter('postgresql://localhost:5432/testdb');
  });

  // -------------------------------------------------------------------------
  // Static properties
  // -------------------------------------------------------------------------

  describe('properties', () => {
    test('dialect is "postgres"', () => {
      expect(adapter.dialect).toBe('postgres');
    });

    test('sql dialect is postgresDialect', () => {
      expect(adapter.sql).toBe(postgresDialect);
    });
  });

  // -------------------------------------------------------------------------
  // query()
  // -------------------------------------------------------------------------

  describe('query()', () => {
    test('delegates to pool.query and returns rows and rowCount', async () => {
      const fakeRows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      mockPoolQuery = async () => ({ rows: fakeRows, rowCount: 2 });

      const result = await adapter.query<{ id: number; name: string }>('SELECT * FROM users');
      expect(result.rows).toEqual(fakeRows);
      expect(result.rowCount).toBe(2);
    });

    test('forwards sql and params to pool.query', async () => {
      let capturedSql = '';
      let capturedParams: unknown[] | undefined;

      mockPoolQuery = async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [], rowCount: 0 };
      };

      await adapter.query('SELECT * FROM users WHERE id = $1', [42]);
      expect(capturedSql).toBe('SELECT * FROM users WHERE id = $1');
      expect(capturedParams).toEqual([42]);
    });

    test('returns rowCount 0 when pool returns null rowCount', async () => {
      // pg can return rowCount: null for some query types
      mockPoolQuery = async () => ({ rows: [], rowCount: null as unknown as number });

      const result = await adapter.query('SELECT 1');
      expect(result.rowCount).toBe(0);
    });

    test('returns empty rows array when pool returns no rows', async () => {
      mockPoolQuery = async () => ({ rows: [], rowCount: 0 });

      const result = await adapter.query('DELETE FROM users WHERE id = $1', [99]);
      expect(result.rows).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });

    test('propagates errors thrown by pool.query', async () => {
      mockPoolQuery = async () => {
        throw new Error('connection lost');
      };

      await expect(adapter.query('SELECT 1')).rejects.toThrow('connection lost');
    });

    test('query without params passes undefined to pool', async () => {
      let capturedParams: unknown[] | undefined = ['sentinel'];

      mockPoolQuery = async (_sql, params) => {
        capturedParams = params;
        return { rows: [], rowCount: 0 };
      };

      await adapter.query('SELECT NOW()');
      expect(capturedParams).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // withTransaction()
  // -------------------------------------------------------------------------

  describe('withTransaction()', () => {
    test('issues BEGIN and COMMIT on success', async () => {
      const issued: string[] = [];
      mockClient = {
        query: async sql => {
          issued.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      await adapter.withTransaction(async () => 'ok');

      expect(issued[0]).toBe('BEGIN');
      expect(issued[issued.length - 1]).toBe('COMMIT');
      expect(issued).not.toContain('ROLLBACK');
    });

    test('issues BEGIN and ROLLBACK on error, then re-throws', async () => {
      const issued: string[] = [];
      mockClient = {
        query: async sql => {
          issued.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      const boom = new Error('query failed inside tx');
      await expect(
        adapter.withTransaction(async () => {
          throw boom;
        })
      ).rejects.toThrow('query failed inside tx');

      expect(issued[0]).toBe('BEGIN');
      expect(issued).toContain('ROLLBACK');
      expect(issued).not.toContain('COMMIT');
    });

    test('always releases client on success', async () => {
      let released = false;
      mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {
          released = true;
        },
      };

      await adapter.withTransaction(async () => 'done');
      expect(released).toBe(true);
    });

    test('always releases client on error', async () => {
      let released = false;
      mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {
          released = true;
        },
      };

      await expect(
        adapter.withTransaction(async () => {
          throw new Error('tx error');
        })
      ).rejects.toThrow('tx error');

      expect(released).toBe(true);
    });

    test('txQuery returns rows and rowCount from client', async () => {
      const fakeRows = [{ x: 42 }];
      mockClient = {
        query: async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
          return { rows: fakeRows, rowCount: 1 };
        },
        release: () => {},
      };

      const result = await adapter.withTransaction(async txQuery => {
        return txQuery<{ x: number }>('SELECT 42 AS x');
      });

      expect(result.rows).toEqual(fakeRows);
      expect(result.rowCount).toBe(1);
    });

    test('txQuery forwards sql and params to client.query', async () => {
      let capturedSql = '';
      let capturedParams: unknown[] | undefined;

      mockClient = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql !== 'BEGIN' && sql !== 'COMMIT') {
            capturedSql = sql;
            capturedParams = params;
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };

      await adapter.withTransaction(async txQuery => {
        await txQuery('UPDATE users SET name = $1 WHERE id = $2', ['Bob', 7]);
        return undefined;
      });

      expect(capturedSql).toBe('UPDATE users SET name = $1 WHERE id = $2');
      expect(capturedParams).toEqual(['Bob', 7]);
    });

    test('txQuery rowCount defaults to 0 when client returns null rowCount', async () => {
      mockClient = {
        query: async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: null as unknown as number };
        },
        release: () => {},
      };

      const result = await adapter.withTransaction(async txQuery => {
        return txQuery('DELETE FROM users WHERE 1=0');
      });

      expect(result.rowCount).toBe(0);
    });

    test('returns value from callback on success', async () => {
      mockClient = {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      };

      const value = await adapter.withTransaction(async () => 'transaction-result');
      expect(value).toBe('transaction-result');
    });

    test('still releases client when ROLLBACK itself throws', async () => {
      let released = false;
      let callCount = 0;

      mockClient = {
        query: async (sql: string) => {
          callCount++;
          if (sql === 'ROLLBACK') throw new Error('rollback failed');
          return { rows: [], rowCount: 0 };
        },
        release: () => {
          released = true;
        },
      };

      await expect(
        adapter.withTransaction(async () => {
          throw new Error('original error');
        })
      ).rejects.toThrow('original error');

      expect(released).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close()', () => {
    test('calls pool.end() without throwing', async () => {
      await expect(adapter.close()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Pool error handler
  // -------------------------------------------------------------------------

  describe('pool error event', () => {
    test('registers an error event handler on the pool', () => {
      // poolErrorHandler is captured by MockPool.on() during constructor
      expect(typeof poolErrorHandler).toBe('function');
    });

    test('error handler does not throw when called', () => {
      // The handler should log, not rethrow (event handlers cannot throw usefully)
      expect(() => {
        if (poolErrorHandler) poolErrorHandler(new Error('pool went away'));
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------

describe('postgresDialect', () => {
  describe('generateUuid()', () => {
    test('returns a valid UUID v4 string', () => {
      const uuid = postgresDialect.generateUuid();
      // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    test('generates unique UUIDs on successive calls', () => {
      const a = postgresDialect.generateUuid();
      const b = postgresDialect.generateUuid();
      expect(a).not.toBe(b);
    });
  });

  describe('now()', () => {
    test('returns "NOW()"', () => {
      expect(postgresDialect.now()).toBe('NOW()');
    });
  });

  describe('jsonMerge()', () => {
    test('returns correct merge expression', () => {
      expect(postgresDialect.jsonMerge('metadata', 1)).toBe('metadata || $1::jsonb');
    });

    test('uses provided param index', () => {
      expect(postgresDialect.jsonMerge('data', 3)).toBe('data || $3::jsonb');
    });

    test('uses provided column name', () => {
      expect(postgresDialect.jsonMerge('extra_fields', 2)).toBe('extra_fields || $2::jsonb');
    });
  });

  describe('jsonArrayContains()', () => {
    test('returns correct containment expression', () => {
      expect(postgresDialect.jsonArrayContains('tags', 'labels', 1)).toBe("tags->'labels' ? $1");
    });

    test('uses provided param index', () => {
      expect(postgresDialect.jsonArrayContains('data', 'ids', 5)).toBe("data->'ids' ? $5");
    });

    test('uses provided column and path', () => {
      expect(postgresDialect.jsonArrayContains('meta', 'related_issues', 2)).toBe(
        "meta->'related_issues' ? $2"
      );
    });
  });

  describe('nowMinusDays()', () => {
    test('returns correct interval expression', () => {
      expect(postgresDialect.nowMinusDays(1)).toBe("NOW() - ($1 || ' days')::INTERVAL");
    });

    test('uses provided param index', () => {
      expect(postgresDialect.nowMinusDays(4)).toBe("NOW() - ($4 || ' days')::INTERVAL");
    });
  });

  describe('daysSince()', () => {
    test('returns correct epoch extraction expression', () => {
      expect(postgresDialect.daysSince('created_at')).toBe(
        'EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400'
      );
    });

    test('uses provided column name', () => {
      expect(postgresDialect.daysSince('updated_at')).toBe(
        'EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400'
      );
    });
  });
});
