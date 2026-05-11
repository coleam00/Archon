/**
 * PostgreSQL adapter using pg Pool
 */
import { Pool } from 'pg';
import type { IDatabase, QueryResult, SqlDialect } from './types';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.postgres');
  return cachedLog;
}

export class PostgresAdapter implements IDatabase {
  private pool: Pool;
  readonly dialect = 'postgres' as const;
  readonly sql: SqlDialect = postgresDialect;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 10000,
    });

    this.pool.on('error', err => {
      getLog().fatal(
        { err, code: (err as NodeJS.ErrnoException).code },
        'db.postgres_pool_connection_failed'
      );
      // Pool-level errors indicate infrastructure problems (DB unreachable, auth failed, etc.)
      // We don't throw here as this is an event handler, but the error is now properly logged
      // with enough context to diagnose. Individual queries will fail with their own errors.
    });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Cast to satisfy pg's QueryResultRow constraint while keeping our generic interface
    const result = await this.pool.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async withTransaction<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txQuery = async <U>(sql: string, params?: unknown[]): Promise<QueryResult<U>> => {
        const result = await client.query(sql, params);
        return {
          rows: result.rows as U[],
          rowCount: result.rowCount ?? 0,
        };
      };
      const result = await fn(txQuery);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        getLog().error({ err: rollbackError as Error }, 'db.postgres_transaction_rollback_failed');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * PostgreSQL SQL dialect helpers
 */
export const postgresDialect: SqlDialect = {
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
