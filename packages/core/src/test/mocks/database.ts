import type { QueryResult, QueryResultRow } from 'pg';
import { mock, type Mock } from 'bun:test';
import type { SqlDialect } from '../../db/adapters/types';

export interface MockPool {
  query: Mock<(...args: unknown[]) => Promise<QueryResult<QueryResultRow>>>;
}

export const createMockQuery = (): MockPool['query'] =>
  mock<(...args: unknown[]) => Promise<QueryResult<QueryResultRow>>>(() =>
    Promise.resolve(createQueryResult<QueryResultRow>([]))
  );

export const createMockPool = (): MockPool => ({
  query: createMockQuery(),
});

export const mockPool = createMockPool();

export const resetMockPool = (): void => {
  mockPool.query.mockReset();
};

// Helper to create mock query results
export function createQueryResult<T extends QueryResultRow>(
  rows: T[],
  rowCount?: number
): QueryResult<T> {
  return {
    rows,
    rowCount: rowCount ?? rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

/**
 * Mock PostgreSQL dialect for tests
 * Tests were written expecting PostgreSQL SQL syntax
 */
export const mockPostgresDialect: SqlDialect = {
  generateUuid(): string {
    return crypto.randomUUID();
  },
  now(): string {
    return 'NOW()';
  },
  jsonMerge(column: string, paramIndex: number): string {
    return `${column} || $${String(paramIndex)}::jsonb`;
  },
  jsonArrayContains(column: string, path: string, paramIndex: number): string {
    return `${column}->'${path}' ? $${String(paramIndex)}`;
  },
  nowMinusDays(paramIndex: number): string {
    return `NOW() - ($${String(paramIndex)} || ' days')::INTERVAL`;
  },
  daysSince(column: string): string {
    return `EXTRACT(EPOCH FROM (NOW() - ${column})) / 86400`;
  },
};
