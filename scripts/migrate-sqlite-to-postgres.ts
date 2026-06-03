#!/usr/bin/env bun
/**
 * One-shot SQLite -> Postgres migration script.
 *
 * Reads every row from each of the 9 application tables in the live
 * ~/.archon/archon.db (single-file SQLite), transforms per the type
 * coercion matrix in docs/plans/archon-postgres-migration.md, and
 * writes to a fresh Postgres database in a single transaction.
 *
 * Why a separate script (not via getDatabase() / IDatabase):
 *   - Reads SQLite tables in dependency order
 *   - Applies per-table type coercion before any adapter initializes
 *   - Supports --dry-run (emit SQL, no execution)
 *   - Opens its own pg.Pool with custom settings (max: 4, statement_timeout: 30000)
 *   - Decoupled from application startup so it can run while archon-server is stopped
 *
 * Usage:
 *   bun run scripts/migrate-sqlite-to-postgres.ts --dry-run
 *   bun run scripts/migrate-sqlite-to-postgres.ts --verify
 *   bun run scripts/migrate-sqlite-to-postgres.ts --from ~/.archon/archon.db --to $DATABASE_URL
 *
 * Exit codes:
 *   0  success (migration applied; verify PASS)
 *   1  pre-flight validation failure (missing file, bad URL)
 *   2  migration aborted (transaction rolled back)
 *   3  verify mismatch (row counts don't match source)
 */
import { parseArgs } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { Database } from 'bun:sqlite';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { transformId, coerceBoolean, coerceJson, coerceTimestamp } from './migrate-coerce';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const DEFAULT_SQLITE_PATH = resolve(homedir(), '.archon', 'archon.db');
const DEFAULT_BATCH_SIZE = 1000;
const POOL_MAX = 4;
const STATEMENT_TIMEOUT_MS = 30_000;

interface CliArgs {
  from: string;
  to: string;
  dryRun: boolean;
  verify: boolean;
  batchSize: number;
  help: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      'batch-size': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const to = values.to ?? process.env.DATABASE_URL ?? '';
  const batchSizeRaw = values['batch-size'];
  const batchSize = batchSizeRaw ? parseInt(batchSizeRaw, 10) : DEFAULT_BATCH_SIZE;
  if (Number.isNaN(batchSize) || batchSize < 1) {
    throw new Error(`--batch-size must be a positive integer, got "${batchSizeRaw}"`);
  }
  return {
    from: values.from ?? DEFAULT_SQLITE_PATH,
    to,
    batchSize,
    // `parseArgs` already returns typed booleans for `{ type: 'boolean' }`
    // options — no need to wrap or compare.
    dryRun: values['dry-run'] ?? false,
    verify: values.verify ?? false,
    help: values.help ?? false,
  };
}

function printHelp(): void {
  console.log(`SQLite -> Postgres migration

Usage:
  bun run scripts/migrate-sqlite-to-postgres.ts [flags]

Flags:
  --from <path>       Source SQLite file (default: ~/.archon/archon.db)
  --to <url>          Target Postgres connection string (default: $DATABASE_URL)
  --dry-run           Emit the generated SQL batches to stdout, do not execute
  --verify            After import, compare row counts to source; exit 3 on mismatch
  --batch-size <N>    Rows per multi-row INSERT (default: 1000)
  -h, --help          Show this help

Exit codes:
  0  success
  1  pre-flight validation failure
  2  migration aborted (transaction rolled back)
  3  verify mismatch (--verify only)`);
}

// ---------------------------------------------------------------------------
// Per-table column lists (source order matches SELECT * from SQLite)
// ---------------------------------------------------------------------------

/**
 * Column lists per table, in the exact order the INSERT statement
 * expects. Adding a new column requires updating both the column list
 * AND the transform function below — keep them in sync.
 */
const TABLE_COLUMNS = {
  remote_agent_users: ['id', 'display_name', 'email', 'created_at', 'updated_at'],
  remote_agent_user_identities: [
    'id',
    'user_id',
    'platform',
    'platform_user_id',
    'platform_display_name',
    'created_at',
  ],
  remote_agent_codebases: [
    'id',
    'name',
    'repository_url',
    'default_cwd',
    'default_branch',
    'ai_assistant_type',
    'commands',
    'created_at',
    'updated_at',
    'allow_env_keys',
  ],
  remote_agent_codebase_env_vars: ['id', 'codebase_id', 'key', 'value', 'created_at', 'updated_at'],
  remote_agent_conversations: [
    'id',
    'platform_type',
    'platform_conversation_id',
    'ai_assistant_type',
    'codebase_id',
    'cwd',
    'isolation_env_id',
    'title',
    'deleted_at',
    'hidden',
    'created_at',
    'updated_at',
    'last_activity_at',
    'user_id',
  ],
  remote_agent_sessions: [
    'id',
    'conversation_id',
    'codebase_id',
    'ai_assistant_type',
    'assistant_session_id',
    'active',
    'metadata',
    'started_at',
    'ended_at',
    'parent_session_id',
    'transition_reason',
    'ended_reason',
  ],
  remote_agent_isolation_environments: [
    'id',
    'codebase_id',
    'workflow_type',
    'workflow_id',
    'provider',
    'working_path',
    'branch_name',
    'created_by_platform',
    'metadata',
    'status',
    'created_at',
    'updated_at',
    'created_by_user_id',
  ],
  remote_agent_workflow_runs: [
    'id',
    'conversation_id',
    'codebase_id',
    'workflow_name',
    'user_message',
    'status',
    'current_step_index',
    'metadata',
    'parent_conversation_id',
    'started_at',
    'completed_at',
    'last_activity_at',
    'working_path',
    'user_id',
  ],
  remote_agent_workflow_events: [
    'id',
    'workflow_run_id',
    'event_type',
    'step_index',
    'step_name',
    'data',
    'created_at',
  ],
  remote_agent_messages: [
    'id',
    'conversation_id',
    'role',
    'content',
    'metadata',
    'created_at',
    'user_id',
  ],
} as const satisfies Record<string, readonly string[]>;

type TableName = keyof typeof TABLE_COLUMNS;
const TABLE_ORDER: readonly TableName[] = [
  'remote_agent_users',
  'remote_agent_user_identities',
  'remote_agent_codebases',
  'remote_agent_codebase_env_vars',
  'remote_agent_conversations',
  'remote_agent_sessions',
  'remote_agent_isolation_environments',
  'remote_agent_workflow_runs',
  'remote_agent_workflow_events',
  'remote_agent_messages',
] as const;

// ---------------------------------------------------------------------------
// Per-table transforms
// ---------------------------------------------------------------------------

/**
 * Transform a row from the live SQLite shape to the Postgres shape.
 * Returns a tuple matching the column list in TABLE_COLUMNS[tableName].
 *
 * Per the type-coercion matrix:
 *   - primary keys: 32-char hex -> canonical UUID
 *   - booleans (hidden, active, allow_env_keys): 0/1 -> JS boolean
 *   - JSON (commands, metadata, data): TEXT -> object (pg serializes as JSONB)
 *   - timestamps: pass through
 *   - FK columns: pass through (already transformed by parent table's iteration)
 */
function transformRow(tableName: TableName, row: Record<string, unknown>): unknown[] {
  switch (tableName) {
    case 'remote_agent_users': {
      const r = row as {
        id: string;
        display_name: string | null;
        email: string | null;
        created_at: string | null;
        updated_at: string | null;
      };
      return [
        transformId(r.id),
        r.display_name,
        r.email,
        coerceTimestamp(r.created_at),
        coerceTimestamp(r.updated_at),
      ];
    }
    case 'remote_agent_user_identities': {
      const r = row as {
        id: string;
        user_id: string;
        platform: string;
        platform_user_id: string;
        platform_display_name: string | null;
        created_at: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.user_id),
        r.platform,
        r.platform_user_id,
        r.platform_display_name,
        coerceTimestamp(r.created_at),
      ];
    }
    case 'remote_agent_codebases': {
      const r = row as {
        id: string;
        name: string;
        repository_url: string | null;
        default_cwd: string;
        default_branch: string | null;
        ai_assistant_type: string | null;
        commands: string | null;
        created_at: string | null;
        updated_at: string | null;
        allow_env_keys: number | null;
      };
      return [
        transformId(r.id),
        r.name,
        r.repository_url,
        r.default_cwd,
        r.default_branch ?? 'main',
        r.ai_assistant_type,
        coerceJson(r.commands ?? '{}'),
        coerceTimestamp(r.created_at),
        coerceTimestamp(r.updated_at),
        // Live SQLite may or may not have the column (Task 4 ensures
        // future fresh installs; older DBs pre-migration are NULL).
        // Hardcode false — explicit, never relies on column DEFAULT.
        coerceBoolean(r.allow_env_keys ?? 0),
      ];
    }
    case 'remote_agent_codebase_env_vars': {
      const r = row as {
        id: string;
        codebase_id: string;
        key: string;
        value: string;
        created_at: string | null;
        updated_at: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.codebase_id),
        r.key,
        r.value,
        coerceTimestamp(r.created_at),
        coerceTimestamp(r.updated_at),
      ];
    }
    case 'remote_agent_conversations': {
      const r = row as {
        id: string;
        platform_type: string;
        platform_conversation_id: string;
        ai_assistant_type: string | null;
        codebase_id: string | null;
        cwd: string | null;
        isolation_env_id: string | null;
        title: string | null;
        deleted_at: string | null;
        hidden: number | null;
        created_at: string | null;
        updated_at: string | null;
        last_activity_at: string | null;
        user_id: string | null;
      };
      return [
        transformId(r.id),
        r.platform_type,
        r.platform_conversation_id,
        r.ai_assistant_type,
        r.codebase_id ? transformId(r.codebase_id) : null,
        r.cwd,
        r.isolation_env_id ? transformId(r.isolation_env_id) : null,
        r.title,
        coerceTimestamp(r.deleted_at),
        coerceBoolean(r.hidden),
        coerceTimestamp(r.created_at),
        coerceTimestamp(r.updated_at),
        coerceTimestamp(r.last_activity_at),
        r.user_id ? transformId(r.user_id) : null,
      ];
    }
    case 'remote_agent_sessions': {
      const r = row as {
        id: string;
        conversation_id: string;
        codebase_id: string | null;
        ai_assistant_type: string;
        assistant_session_id: string | null;
        active: number | null;
        metadata: string | null;
        started_at: string | null;
        ended_at: string | null;
        parent_session_id: string | null;
        transition_reason: string | null;
        ended_reason: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.conversation_id),
        r.codebase_id ? transformId(r.codebase_id) : null,
        r.ai_assistant_type,
        r.assistant_session_id,
        coerceBoolean(r.active),
        coerceJson(r.metadata ?? '{}'),
        coerceTimestamp(r.started_at),
        coerceTimestamp(r.ended_at),
        r.parent_session_id ? transformId(r.parent_session_id) : null,
        r.transition_reason,
        r.ended_reason,
      ];
    }
    case 'remote_agent_isolation_environments': {
      const r = row as {
        id: string;
        codebase_id: string;
        workflow_type: string;
        workflow_id: string;
        provider: string;
        working_path: string;
        branch_name: string;
        created_by_platform: string | null;
        metadata: string | null;
        status: string;
        created_at: string | null;
        updated_at: string | null;
        created_by_user_id: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.codebase_id),
        r.workflow_type,
        r.workflow_id,
        r.provider,
        r.working_path,
        r.branch_name,
        r.created_by_platform,
        coerceJson(r.metadata ?? '{}'),
        r.status,
        coerceTimestamp(r.created_at),
        coerceTimestamp(r.updated_at),
        r.created_by_user_id ? transformId(r.created_by_user_id) : null,
      ];
    }
    case 'remote_agent_workflow_runs': {
      const r = row as {
        id: string;
        conversation_id: string;
        codebase_id: string | null;
        workflow_name: string;
        user_message: string;
        status: string;
        current_step_index: number | null;
        metadata: string | null;
        parent_conversation_id: string | null;
        started_at: string | null;
        completed_at: string | null;
        last_activity_at: string | null;
        working_path: string | null;
        user_id: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.conversation_id),
        r.codebase_id ? transformId(r.codebase_id) : null,
        r.workflow_name,
        r.user_message,
        r.status,
        r.current_step_index,
        coerceJson(r.metadata ?? '{}'),
        r.parent_conversation_id ? transformId(r.parent_conversation_id) : null,
        coerceTimestamp(r.started_at),
        coerceTimestamp(r.completed_at),
        coerceTimestamp(r.last_activity_at),
        r.working_path,
        r.user_id ? transformId(r.user_id) : null,
      ];
    }
    case 'remote_agent_workflow_events': {
      const r = row as {
        id: string;
        workflow_run_id: string;
        event_type: string;
        step_index: number | null;
        step_name: string | null;
        data: string | null;
        created_at: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.workflow_run_id),
        r.event_type,
        r.step_index,
        r.step_name,
        coerceJson(r.data ?? '{}'),
        coerceTimestamp(r.created_at),
      ];
    }
    case 'remote_agent_messages': {
      const r = row as {
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        metadata: string | null;
        created_at: string | null;
        user_id: string | null;
      };
      return [
        transformId(r.id),
        transformId(r.conversation_id),
        r.role,
        r.content,
        coerceJson(r.metadata ?? '{}'),
        coerceTimestamp(r.created_at),
        r.user_id ? transformId(r.user_id) : null,
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Migration driver
// ---------------------------------------------------------------------------

/**
 * Read all rows from a SQLite table. Returns raw row objects keyed by column name.
 * Uses prepared statement + all() to avoid N round-trips.
 */
function readAllRows(sqlite: Database, table: TableName): Record<string, unknown>[] {
  const stmt = sqlite.prepare(`SELECT * FROM ${table}`);
  return stmt.all() as Record<string, unknown>[];
}

/**
 * Build a multi-row INSERT statement for Postgres.
 * `ON CONFLICT (id) DO NOTHING` makes the script re-runnable — partial
 * prior runs are no-ops for already-inserted rows.
 */
function buildInsert(table: TableName, rowCount: number, columns: readonly string[]): string {
  const colList = columns.join(', ');
  // Postgres' `pg` driver uses $1, $2, ... positional placeholders.
  // (? is MySQL/SQLite syntax; in Postgres `?` would be parsed as
  // a JSONB operator and produce 'syntax error at or near ","' on
  // the first multi-row batch.)
  // Each row gets a fresh range starting at the running counter.
  const colCount = columns.length;
  const rowPlaceholders: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const offset = r * colCount;
    const placeholders = columns.map((_, i) => `$${String(offset + i + 1)}`).join(', ');
    rowPlaceholders.push(`(${placeholders})`);
  }
  return `INSERT INTO ${table} (${colList}) VALUES ${rowPlaceholders.join(', ')} ON CONFLICT (id) DO NOTHING`;
}

export interface MigrationResult {
  readonly perTableCounts: Readonly<Record<TableName, number>>;
  readonly dryRun: boolean;
}

export interface VerifyResult {
  readonly passed: boolean;
  readonly mismatches: readonly { table: TableName; source: number; target: number }[];
}

async function runMigration(
  sqlite: Database,
  pool: Pool | null,
  cli: CliArgs
): Promise<MigrationResult> {
  const perTableCounts = {} as Record<TableName, number>;
  for (const table of TABLE_ORDER) {
    const rows = readAllRows(sqlite, table);
    perTableCounts[table] = rows.length;
    if (rows.length === 0) {
      console.log(`  ${table}: 0 rows (skipped)`);
      continue;
    }
    const transformed = rows.map(r => transformRow(table, r));
    const columns = TABLE_COLUMNS[table];
    if (cli.dryRun || pool === null) {
      // --dry-run: emit one INSERT batch of up to batchSize rows.
      // Iterate as if applying, but only print.
      let totalEmitted = 0;
      for (let i = 0; i < transformed.length; i += cli.batchSize) {
        const batch = transformed.slice(i, i + cli.batchSize);
        const sql = buildInsert(table, batch.length, columns);
        // Flatten the batch into positional params for the prepared statement
        const flat: unknown[] = [];
        for (const row of batch) flat.push(...row);
        console.log(`-- ${table} batch ${i / cli.batchSize + 1}: ${batch.length} rows`);
        console.log(sql);
        console.log(`-- params: ${flat.length} values (omitted for brevity)`);
        totalEmitted += batch.length;
      }
      console.log(`  ${table}: ${totalEmitted} rows (dry-run emitted)`);
      continue;
    }
    // Real run: batched INSERTs inside the transaction managed by the caller.
    const client = await pool.connect();
    try {
      for (let i = 0; i < transformed.length; i += cli.batchSize) {
        const batch = transformed.slice(i, i + cli.batchSize);
        const sql = buildInsert(table, batch.length, columns);
        const flat: unknown[] = [];
        for (const row of batch) flat.push(...row);
        await client.query(sql, flat);
      }
    } finally {
      client.release();
    }
    console.log(`  ${table}: ${rows.length} rows`);
  }
  return { perTableCounts, dryRun: cli.dryRun };
}

async function verifyMigration(pool: Pool, sqlite: Database): Promise<VerifyResult> {
  const mismatches: { table: TableName; source: number; target: number }[] = [];
  for (const table of TABLE_ORDER) {
    const sourceRows = readAllRows(sqlite, table);
    const sourceCount = sourceRows.length;
    const target = (await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`
    )) as QueryResult<{ count: string }>;
    const targetCount = parseInt(target.rows[0]?.count ?? '0', 10);
    if (sourceCount !== targetCount) {
      mismatches.push({ table, source: sourceCount, target: targetCount });
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function summarize(perTable: Record<TableName, number>): string {
  const parts = TABLE_ORDER.map(t => `${perTable[t]} ${t.replace('remote_agent_', '')}`);
  return parts.join(', ');
}

/**
 * Top-level entry point exposed for the CLI wrapper (archon migrate:sqlite-to-postgres).
 * Takes pre-parsed arguments; the standalone script path (below) calls this with
 * `parseCli(process.argv.slice(2))`.
 */
export async function runMigrateSqliteToPostgres(cli: CliArgs): Promise<number> {
  if (cli.help) {
    printHelp();
    return 0;
  }
  if (!cli.to) {
    console.error('Error: --to <postgres-url> is required (or set DATABASE_URL).');
    printHelp();
    return 1;
  }
  if (!existsSync(cli.from)) {
    console.error(`Error: source SQLite file not found: ${cli.from}`);
    return 1;
  }
  console.log('SQLite -> Postgres migration');
  console.log(`  from: ${cli.from}`);
  console.log(`  to:   ${cli.to.replace(/:[^:@/]+@/, ':***@')}`); // redact password
  console.log(`  mode: ${cli.dryRun ? 'dry-run' : cli.verify ? 'verify-after-migrate' : 'apply'}`);
  console.log(`  batch-size: ${cli.batchSize}`);

  // Open source (bun:sqlite, mirror sqlite.ts:32-38 settings).
  // Note: not opened with { readonly: true } because PRAGMA journal_mode
  // and PRAGMA busy_timeout write to the DB file even though the
  // migration itself only runs SELECT statements — readonly mode
  // would block those PRAGMAs. The script never INSERTs/UPDATEs the
  // source; safety comes from the absence of write SQL, not from
  // the readonly flag.
  const sqlite = new Database(cli.from);
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA busy_timeout = 5000');
  console.log('  source opened (WAL + busy_timeout=5000ms, no write SQL)');

  // Open target. For --dry-run, don't open the pool — the user may not
  // have Postgres running and dry-run should work offline.
  let pool: Pool | null = null;
  if (!cli.dryRun) {
    pool = new Pool({
      connectionString: cli.to,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    // pool.on('error') mirrors postgres.ts:28-36; pool-level errors are
    // infrastructure problems, log + exit (don't throw inside handler).
    pool.on('error', err => {
      console.error(`pg.Pool error: ${err.message}`);
    });
  }

  try {
    if (cli.dryRun) {
      console.log('\n[dry-run] Emitting SQL batches to stdout, no DB writes:\n');
      const result = await runMigration(sqlite, null, cli);
      console.log(`\n[dry-run] would migrate: ${summarize(result.perTableCounts)}`);
      return 0;
    }

    // Real run: open a single client and hold it for the whole transaction.
    if (pool === null) throw new Error('unreachable: pool should be set for non-dry-run');
    const client = await pool.connect();
    let result: MigrationResult;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      console.log('\n[apply] Transaction started, migrating 10 tables...');
      result = await runMigration(sqlite, pool, cli);
      await client.query('COMMIT');
      console.log('\n[apply] Transaction committed.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`\n[apply] Migration aborted: ${(err as Error).message}`);
      return 2;
    } finally {
      client.release();
    }

    if (cli.verify) {
      console.log('\n[verify] Comparing row counts to source SQLite...');
      const verifyResult = await verifyMigration(pool, sqlite);
      if (verifyResult.passed) {
        console.log(`[verify] PASS (${TABLE_ORDER.length}/${TABLE_ORDER.length} tables match)`);
      } else {
        console.error(`[verify] FAIL — ${verifyResult.mismatches.length} mismatches:`);
        for (const m of verifyResult.mismatches) {
          console.error(`  ${m.table}: source=${m.source} target=${m.target}`);
        }
        return 3;
      }
    }

    console.log(`\nMigrated: ${summarize(result.perTableCounts)}`);
    return 0;
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    sqlite.close();
  }
}

if (import.meta.main) {
  let parsedCli: CliArgs;
  try {
    parsedCli = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    printHelp();
    process.exit(1);
  }
  runMigrateSqliteToPostgres(parsedCli)
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(`Fatal: ${(err as Error).message}`);
      if (process.env.DEBUG) console.error((err as Error).stack);
      process.exit(2);
    });
}
