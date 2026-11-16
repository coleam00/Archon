/**
 * Database connection management with auto-detection
 *
 * Strategy:
 * - If DATABASE_URL is set: Use PostgreSQL (shared with server)
 * - Otherwise: Use SQLite at ~/.archon/archon.db (standalone CLI)
 * - Either way, refuse when this build runs from inside the home's workspaces:
 *   that is code under work, and opening would migrate the live database.
 */
import { join } from 'path';
import { getArchonHome } from '@archon/paths';
import { runningBuildInsideWorkspacesOf } from '@archon/paths/source-tree-paths';
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
 * A build inside the home's workspaces is a run's worktree or a managed clone,
 * not the install that owns the home. Opening the home's database from there
 * would apply that unmerged code's schema migrations to the live database, and
 * an inherited `ARCHON_HOME` says nothing about whether anyone chose that home
 * for this work, so the refusal has no override.
 */
function refuseCodeUnderWork(): void {
  const home = getArchonHome();
  const build = runningBuildInsideWorkspacesOf(home);
  if (!build) return;
  const databaseHint = process.env.DATABASE_URL
    ? ' DATABASE_URL is set, so also point it at a scratch database you create and drop.'
    : '';
  throw new Error(
    `Refusing to open the database of Archon home ${home}. This build runs from ${build}, ` +
      "inside that home's workspaces, so it is code under work and not the install that owns " +
      "the home. Opening the database would apply this build's schema migrations to that " +
      'live database. Set ARCHON_HOME to a scratch directory, for example ' +
      `ARCHON_HOME="$(mktemp -d)".${databaseHint}`
  );
}

/**
 * Get or create the database connection
 * Auto-detects PostgreSQL vs SQLite based on DATABASE_URL
 */
export function getDatabase(): IDatabase {
  if (database) {
    return database;
  }

  refuseCodeUnderWork();

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
