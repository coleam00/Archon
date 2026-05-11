/**
 * Database connection management with auto-detection
 *
 * Strategy:
 * - If DATABASE_URL is set: Use PostgreSQL (shared with server)
 * - Otherwise: Use SQLite at ~/.archon/archon.db (standalone CLI)
 */
import { join } from 'path';
import { getArchonHome } from '@archon/paths';
import type { IDatabase, SqlDialect, QueryResult } from './adapters/types';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.connection');
  return cachedLog;
}

// Singleton database instance
let database: IDatabase | null = null;
let dialect: SqlDialect | null = null;

/**
 * Get or create the database connection
 * Auto-detects PostgreSQL vs SQLite based on DATABASE_URL
 */
export function getDatabase(): IDatabase {
  if (database) {
    return database;
  }

  if (process.env.DATABASE_URL) {
    getLog().info('db.connection_postgresql_selected');
    database = new PostgresAdapter(process.env.DATABASE_URL);
    dialect = postgresDialect;
  } else {
    const dbPath = join(getArchonHome(), 'archon.db');
    getLog().info({ dbPath }, 'db.connection_sqlite_selected');
    database = new SqliteAdapter(dbPath);
    dialect = sqliteDialect;

    // Warn if running in Docker without DATABASE_URL — the postgres container
    // from --profile with-db is running but the app is silently using SQLite
    if (process.env.ARCHON_DOCKER === 'true') {
      getLog().warn(
        {
          hint: 'Add DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent to .env to use PostgreSQL',
          current: dbPath,
        },
        'db.docker_using_sqlite'
      );
    }
  }

  return database;
}

/**
 * Get the SQL dialect for the current database
 */
export function getDialect(): SqlDialect {
  if (!dialect) {
    // Initialize database to set dialect
    getDatabase();
  }

  if (!dialect) {
    throw new Error(
      'Database dialect not initialized. This indicates the database connection failed during initialization. ' +
        'Check logs for database connection errors.'
    );
  }

  return dialect;
}

/**
 * Get the current database type without initializing the database
 * Useful for version/info commands that don't need a connection
 */
export function getDatabaseType(): 'postgresql' | 'sqlite' {
  return process.env.DATABASE_URL ? 'postgresql' : 'sqlite';
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.close();
    database = null;
    dialect = null;
  }
}

/**
 * Reset database for testing
 */
export function resetDatabase(): void {
  database = null;
  dialect = null;
}

// Legacy export for backward compatibility during migration
// This provides a pool-like interface that forwards to getDatabase()
export const pool = {
  query: async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    return getDatabase().query<T>(sql, params);
  },
  end: async (): Promise<void> => {
    await closeDatabase();
  },
};
