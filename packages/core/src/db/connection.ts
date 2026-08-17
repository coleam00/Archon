/**
 * Database connection management with auto-detection
 *
 * Strategy:
 * - If DATABASE_URL is set: Use PostgreSQL (shared with server)
 * - Otherwise: Use SQLite at ~/.archon/archon.db (standalone CLI)
 */
import { join } from 'path';
import { getArchonHome } from '@archon/paths';
import type { DbNotificationListener, IDatabase, SqlDialect, QueryResult } from './adapters/types';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { readSchemaVersion, type SchemaVersionInfo } from './schema-version';
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
 * Where the SQLite registry lives when DATABASE_URL is unset.
 *
 * Exported because a caller that needs to know whether the registry EXISTS must
 * test the same path this module opens — deriving it independently means a future
 * relocation silently answers about the wrong file. `scripts/migrate-state-dir.ts`
 * is that caller: it skips a read-only lookup when the file is absent, and a stale
 * path there would send a migration to the wrong destination without erroring.
 */
export function getSqliteDbPath(): string {
  return join(getArchonHome(), 'archon.db');
}

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
    const dbPath = getSqliteDbPath();
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
 * Read the recorded schema vintage (#2316): which Archon build created this database
 * and which last applied schema to it. Returns null when no row was ever written.
 * Diagnostic only — no caller gates on it.
 */
export async function getSchemaVersion(): Promise<SchemaVersionInfo | null> {
  return readSchemaVersion(getDatabase());
}

/** Type guard: does this database implement the optional notification-listener capability? */
function isDbNotificationListener(db: IDatabase): db is IDatabase & DbNotificationListener {
  return typeof (db as Partial<DbNotificationListener>).listen === 'function';
}

/**
 * Return the active database as a notification listener (Postgres `LISTEN/NOTIFY`),
 * or null when the backend doesn't support it (SQLite). Feature-detection seam so
 * the server can opt into real-time push only when available.
 */
export function getDbNotificationListener(): DbNotificationListener | null {
  if (getDatabaseType() !== 'postgresql') return null;
  const db = getDatabase();
  return isDbNotificationListener(db) ? db : null;
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
