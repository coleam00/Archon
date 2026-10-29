/**
 * PostgreSQL adapter using pg Pool
 */
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { DbNotificationListener, IDatabase, QueryResult, SqlDialect } from './types';
import { WORKFLOW_EVENT_NOTIFY_CHANNEL } from './types';
import { createLogger } from '@archon/paths';
import { LEGACY_VENDOR_ALIASES } from '@archon/providers/credential-catalog';
import { getSchemaSQL } from '../bundled-schema';
import { APP_VERSION } from '../schema-version';

const SCHEMA_LOCK_SQL = 'SELECT pg_advisory_xact_lock(1796)';
const SCHEMA_CURRENT_SAVEPOINT = 'schema_current';
const NOTIFY_TRIGGER_SAVEPOINT = 'notify_trigger';

/**
 * Postgres-only: NOTIFY `archon_dashboard_event` on every workflow_events insert, so
 * the server's PgNotifyListener can wake the dashboard poller to stream events from
 * out-of-process (CLI) runs in real time. Idempotent (CREATE OR REPLACE + DROP IF
 * EXISTS) — applied on every convergence. Deliberately NOT in the shared bundled schema:
 * SQLite has no triggers/NOTIFY, and this syntax would break its schema init.
 */
const WORKFLOW_EVENT_NOTIFY_SQL = `
CREATE OR REPLACE FUNCTION archon_notify_workflow_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${WORKFLOW_EVENT_NOTIFY_CHANNEL}', NEW.workflow_run_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS archon_workflow_event_notify ON remote_agent_workflow_events;
CREATE TRIGGER archon_workflow_event_notify
  AFTER INSERT ON remote_agent_workflow_events
  FOR EACH ROW EXECUTE FUNCTION archon_notify_workflow_event();
`;

/**
 * Fingerprint of everything a boot converges: the bundled schema, the notify trigger
 * and the app version the vintage row records. A boot that finds this fingerprint
 * already recorded skips convergence entirely. Running the DDL on every boot is not
 * free: DROP/CREATE TRIGGER takes an exclusive lock on remote_agent_workflow_events,
 * and every short-lived CLI process (a status query, a timer tick) used to take it
 * while live runs were inserting node events, which deadlocked those inserts.
 */
function schemaFingerprint(schemaSql: string): string {
  return createHash('sha256')
    .update(schemaSql)
    .update('\0')
    .update(WORKFLOW_EVENT_NOTIFY_SQL)
    .update('\0')
    .update(APP_VERSION)
    .digest('hex');
}

/**
 * True only when this build's fingerprint is recorded, the recorded applied build is
 * this build, and no data repair in the bundled schema has work left: legacy provider
 * ids an older build wrote, or an event-sequence head behind the events. The
 * app_version check catches an older released build that converged since and may have
 * replaced functions this build defines. It cannot catch a source checkout that
 * predates this fingerprint: every checkout stamps 'dev' and that one leaves the
 * fingerprint alone, so this build skips and the older function bodies stay until
 * this build's schema SQL changes or schema_fingerprint is cleared.
 * The SQLite adapter checks the same repairs before skipping its convergence.
 */
const SCHEMA_CURRENT_SQL = `
SELECT
  EXISTS (SELECT 1 FROM remote_agent_schema_version
          WHERE id = 1 AND schema_fingerprint = $1 AND app_version = $2)
  AND NOT EXISTS (SELECT 1 FROM remote_agent_user_provider_keys WHERE provider = ANY($3))
  AND EXISTS (SELECT 1 FROM remote_agent_workflow_event_sequence
              WHERE id = 1 AND value >= (SELECT COALESCE(MAX(event_order), 0)
                                         FROM remote_agent_workflow_events))
  AS current`;

/** SQLSTATEs Postgres asks the client to retry: deadlock victim, serialization failure. */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const RETRY_ATTEMPTS = 4;

function isRetryable(error: unknown): error is { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Runs `operation` again, up to RETRY_ATTEMPTS in all, while it fails as a deadlock
 * victim or serialization failure. Postgres rolled the failed attempt back whole, so
 * the caller must pass a unit it rolls back whole: one statement or one transaction.
 * Backoff is 50, 100, 200 ms plus jitter, so two victims of one deadlock do not
 * collide again.
 */
async function retryConflicts<T>(operation: () => Promise<T>, event: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (e) {
      if (!isRetryable(e) || attempt + 1 >= RETRY_ATTEMPTS) throw e;
      getLog().warn({ code: e.code, attempt: attempt + 1 }, event);
      const ms = 50 * 2 ** attempt + Math.floor(Math.random() * 50);
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  }
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.postgres');
  return cachedLog;
}

export class PostgresAdapter implements IDatabase, DbNotificationListener {
  private pool: Pool;
  // Schema convergence runs once on construction; every query() and
  // withTransaction() awaits this promise so the first DB op cannot race init.
  // After init resolves, the await is a no-op.
  private readonly schemaInitPromise: Promise<void>;
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

    this.schemaInitPromise = this.initSchema();
  }

  private async initSchema(): Promise<void> {
    const sql = getSchemaSQL();
    const fingerprint = schemaFingerprint(sql);
    try {
      await this.initSchemaOnce(sql, fingerprint);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getLog().fatal({ err }, 'db.postgres_schema_init_failed');
      throw err;
    }
  }

  private async initSchemaOnce(sql: string, fingerprint: string): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      // Advisory lock serializes schema convergence across concurrent boots
      // (e.g. two app containers starting at once against a fresh DB).
      // Key 1796 is arbitrary — just needs to be stable across processes.
      await client.query('BEGIN');
      await client.query(SCHEMA_LOCK_SQL);
      // Take no relation locks before the advisory lock: fingerprint reads otherwise
      // lock version then events, opposite to the bundled DDL's lock order.
      if (await this.schemaIsCurrent(client, fingerprint)) {
        await client.query('COMMIT');
        getLog().debug('db.postgres_schema_current');
        return;
      }
      // Probe before applying: afterwards every table exists, and a database that
      // predates schema-version tracking is indistinguishable from a fresh one.
      const probe = await client.query<{ exists: boolean; version_exists: boolean }>(
        `SELECT to_regclass('remote_agent_codebases') IS NOT NULL AS exists,
                to_regclass('remote_agent_schema_version') IS NOT NULL AS version_exists`
      );
      const preExisting = probe.rows[0]?.exists ?? false;
      if (probe.rows[0]?.version_exists) {
        // Readers can hold version while requesting events. Take version's DDL
        // lock first, before the bundled SQL can exclusively lock events.
        await client.query('LOCK TABLE remote_agent_schema_version IN ACCESS EXCLUSIVE MODE');
      }
      // The SQL is fully idempotent (CREATE TABLE IF NOT EXISTS,
      // ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
      await client.query(sql);
      await this.completeSchema(client, preExisting, fingerprint);
      await client.query('COMMIT');
      getLog().info('db.postgres_schema_init_completed');
    } catch (e) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          getLog().error(
            {
              err:
                rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
            },
            'db.postgres_schema_init_rollback_failed'
          );
        }
      }
      throw e;
    } finally {
      client?.release();
    }
  }

  private async recoverSavepoint(
    client: PoolClient,
    savepoint: typeof SCHEMA_CURRENT_SAVEPOINT | typeof NOTIFY_TRIGGER_SAVEPOINT,
    originalError: unknown
  ): Promise<void> {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      getLog().error(
        { err: error instanceof Error ? error : new Error(String(error)), savepoint },
        'db.postgres_savepoint_recovery_failed'
      );
      throw originalError;
    }
  }

  private async schemaIsCurrent(client: PoolClient, fingerprint: string): Promise<boolean> {
    await client.query(`SAVEPOINT ${SCHEMA_CURRENT_SAVEPOINT}`);
    try {
      const result = await client.query<{ current: boolean }>(SCHEMA_CURRENT_SQL, [
        fingerprint,
        APP_VERSION,
        Object.keys(LEGACY_VENDOR_ALIASES),
      ]);
      await client.query(`RELEASE SAVEPOINT ${SCHEMA_CURRENT_SAVEPOINT}`);
      return result.rows[0]?.current === true;
    } catch (error) {
      await this.recoverSavepoint(client, SCHEMA_CURRENT_SAVEPOINT, error);
      // Fresh and older databases can lack the fingerprint's tables or column.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '42P01' || code === '42703') return false;
      throw error;
    }
  }

  /**
   * Record which Archon build created this database and which last applied schema
   * to it (#2316). Runs inside the caller's advisory-locked schema transaction so
   * concurrent boots stay serialized. ON CONFLICT never touches created_app_version,
   * so the creation vintage is written once and never revised; the DO UPDATE is a
   * no-op when the app version has not changed.
   */
  private async completeSchema(
    client: PoolClient,
    preExisting: boolean,
    fingerprint: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO remote_agent_schema_version (id, created_app_version, app_version)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE
         SET app_version = EXCLUDED.app_version, applied_at = NOW()
         WHERE remote_agent_schema_version.app_version IS DISTINCT FROM EXCLUDED.app_version`,
      [preExisting ? null : APP_VERSION, APP_VERSION]
    );
    if (await this.installNotifyTrigger(client)) {
      const completion = await client.query(
        'UPDATE remote_agent_schema_version SET schema_fingerprint = $1 WHERE id = 1',
        [fingerprint]
      );
      if (completion.rowCount !== 1) {
        throw new Error('Schema completion requires exactly one version row');
      }
    }
  }

  /** Trigger permissions are optional: retain polling without publishing completion. */
  private async installNotifyTrigger(client: PoolClient): Promise<boolean> {
    await client.query(`SAVEPOINT ${NOTIFY_TRIGGER_SAVEPOINT}`);
    try {
      await client.query(WORKFLOW_EVENT_NOTIFY_SQL);
      await client.query(`RELEASE SAVEPOINT ${NOTIFY_TRIGGER_SAVEPOINT}`);
      return true;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== '42501') throw e;
      await this.recoverSavepoint(client, NOTIFY_TRIGGER_SAVEPOINT, e);
      getLog().warn(
        { err: e instanceof Error ? e : new Error(String(e)) },
        'db.postgres_notify_trigger_install_failed'
      );
      return false;
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    await this.schemaInitPromise;
    // Cast to satisfy pg's QueryResultRow constraint while keeping our generic interface
    const result = await retryConflicts(
      () => this.pool.query(sql, params),
      'db.postgres_query_retry'
    );
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async withTransaction<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T> {
    await this.schemaInitPromise;
    return retryConflicts(() => this.transactionOnce(fn), 'db.postgres_transaction_retry');
  }

  private async transactionOnce<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    // Remembered even when the callback catches or wraps it: the transaction is
    // aborted either way, and only the conflict itself tells the caller to rerun it.
    let conflict: unknown;
    try {
      await client.query('BEGIN');
      const txQuery = async <U>(sql: string, params?: unknown[]): Promise<QueryResult<U>> => {
        try {
          const result = await client.query(sql, params);
          return {
            rows: result.rows as U[],
            rowCount: result.rowCount ?? 0,
          };
        } catch (e) {
          if (isRetryable(e)) conflict = e;
          throw e;
        }
      };
      const result = await fn(txQuery);
      if (conflict) throw conflict;
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        const code =
          typeof rollbackError === 'object' && rollbackError !== null && 'code' in rollbackError
            ? rollbackError.code
            : undefined;
        getLog().error(
          {
            code:
              typeof code === 'string' && code.length === 5 && !/[^0-9A-Z]/.test(code)
                ? code
                : undefined,
          },
          'db.postgres_transaction_rollback_failed'
        );
      }
      throw conflict ?? e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Subscribe to a Postgres `LISTEN` channel on a dedicated, held connection.
   * The client is never returned to the pool's normal rotation — it stays
   * checked out so it keeps receiving notifications, and is destroyed (not
   * recycled) on unsubscribe or error.
   */
  async listen(
    channel: string,
    onNotify: (payload: string) => void,
    onError: (err: Error) => void
  ): Promise<() => void> {
    await this.schemaInitPromise;
    // `LISTEN` cannot be parameterized — validate the channel name to keep it
    // out of injection territory (we only ever pass a fixed constant).
    if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
      throw new Error(`Invalid LISTEN channel name: ${channel}`);
    }
    const client = await this.pool.connect();
    let released = false;
    const release = (destroy: boolean | Error): void => {
      if (released) return;
      released = true;
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      // Destroy rather than return to the pool — a LISTEN client must not be reused.
      client.release(destroy);
    };
    try {
      client.on('notification', msg => {
        if (msg.channel === channel) onNotify(msg.payload ?? '');
      });
      client.on('error', err => {
        const e = err instanceof Error ? err : new Error(String(err));
        getLog().warn({ err: e, channel }, 'db.postgres_listen_client_error');
        release(e);
        onError(e);
      });
      // If LISTEN setup throws, release the checked-out client so a flaky reconnect
      // loop can't exhaust the pool (max 10) and stall all DB work.
      await client.query(`LISTEN ${channel}`);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      release(e);
      throw e;
    }
    return () => {
      release(true);
    };
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
    // `||` alone stores a patch's null values. Subtracting the null-valued top-level
    // keys makes `{ key: null }` remove the key, as SQLite's json_patch does, so both
    // databases hold the same shape after a clear.
    const patch = `$${String(paramIndex)}::jsonb`;
    return `(${column} || ${patch}) - ARRAY(SELECT key FROM jsonb_each(${patch}) WHERE jsonb_typeof(value) = 'null')`;
  },

  nowMinusDays(paramIndex: number): string {
    return `NOW() - ($${String(paramIndex)} || ' days')::INTERVAL`;
  },

  daysSince(column: string): string {
    return `EXTRACT(EPOCH FROM (NOW() - ${column})) / 86400`;
  },

  jsonText(column: string, path: string): string {
    const keys = path.split('.');
    const last = keys.length - 1;
    return column + keys.map((key, i) => `${i === last ? '->>' : '->'}'${key}'`).join('');
  },

  jsonRemove(column: string, ...keys: string[]): string {
    return [column, ...keys.map(key => `'${key}'`)].join(' - ');
  },

  rowLock(table?: string): string {
    return table === undefined ? ' FOR UPDATE' : ` FOR UPDATE OF ${table}`;
  },
};
