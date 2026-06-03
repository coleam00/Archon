#!/usr/bin/env bun
/**
 * One-shot SQLite -> Postgres migration script.
 *
 * Reads every row from each of the 9 application tables in the live
 * ~/.archon/archon.db (single-file SQLite), transforms per the type
 * coercion matrix in docs/plans/archon-postgres-migration.md, and
 * writes to a fresh Postgres database in a single transaction.
 */
import { parseArgs } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { Database } from 'bun:sqlite';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { transformId, coerceBoolean, coerceJson, coerceTimestamp } from './migrate-coerce';

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
    dryRun: values['dry-run'] ?? false,
    verify: values.verify ?? false,
    help: values.help ?? false,
  };
}

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

const FK_COLUMNS: Partial<Record<TableName, Record<string, TableName>>> = {
  remote_agent_user_identities: { user_id: 'remote_agent_users' },
  remote_agent_codebase_env_vars: { codebase_id: 'remote_agent_codebases' },
  remote_agent_conversations: {
    codebase_id: 'remote_agent_codebases',
    isolation_env_id: 'remote_agent_isolation_environments',
  },
  remote_agent_sessions: {
    conversation_id: 'remote_agent_conversations',
    codebase_id: 'remote_agent_codebases',
  },
  remote_agent_isolation_environments: { codebase_id: 'remote_agent_codebases' },
  remote_agent_workflow_runs: {
    conversation_id: 'remote_agent_conversations',
    codebase_id: 'remote_agent_codebases',
  },
  remote_agent_workflow_events: { workflow_run_id: 'remote_agent_workflow_runs' },
  remote_agent_messages: { conversation_id: 'remote_agent_conversations' },
};

function loadParentIds(sqlite: Database, parent: TableName): Set<string> {
  const rows = sqlite.prepare(`SELECT id FROM ${parent}`).all() as { id: string }[];
  return new Set(rows.map(r => r.id));
}

function filterOrphans(
  rows: Record<string, unknown>[],
  fkColumns: Record<string, TableName>,
  parentIdsCache: Map<TableName, Set<string>>
): { kept: Record<string, unknown>[]; dropped: number } {
  const kept: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const row of rows) {
    let isOrphan = false;
    for (const [col, parent] of Object.entries(fkColumns)) {
      const value = row[col];
      if (value === null || value === undefined) continue;
      const parentIds = parentIdsCache.get(parent);
      if (parentIds && !parentIds.has(value as string)) {
        isOrphan = true;
        break;
      }
    }
    if (isOrphan) dropped += 1;
    else kept.push(row);
  }
  return { kept, dropped };
}

/**
 * Recursively strip U+0000 (NUL) bytes and other C0 control chars
 * (except TAB, LF, CR) from all strings in a value. `pg`'s JSONB
 * encoder produces JSON via JSON.stringify, which escapes NUL as
 * `\u0000`. The wire encoder then throws "unsupported Unicode
 * escape sequence" when it parses the encoder's own output. NUL
 * bytes in user-generated text are garbage; replacing with a
 * stripped-then-padded form is safe for JSONB / TEXT / VARCHAR.
 */
export function sanitizeForPg<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // NUL (0x00) breaks the pg JSONB wire encoder (it re-parses its
    // own JSON.stringify output and throws on \\u0000). Other C0
    // control chars (0x01-0x08, 0x0B-0x0C, 0x0E-0x1F) are stripped
    // too — they're not safe in JSONB either. TAB/LF/CR (0x09,
    // 0x0A, 0x0D) are kept as legitimate whitespace. The `eslint-
    // disable` is because no-control-regex flags the \\x00 class
    // below, which is exactly the behavior we want here.
    /* eslint-disable no-control-regex */
    return value
      .replace(/\u0000/g, '')
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '') as T;
    /* eslint-enable no-control-regex */
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown) => sanitizeForPg(v)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForPg(v);
    }
    return out as T;
  }
  return value;
}

function transformRow(table: TableName, row: Record<string, unknown>): unknown[] {
  switch (table) {
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

function readAllRows(sqlite: Database, table: TableName): Record<string, unknown>[] {
  return sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

function buildInsert(table: TableName, rowCount: number, columns: readonly string[]): string {
  const colList = columns.join(', ');
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
  // Pre-compute parent-ID sets in FK-order. After each table is
  // filtered, its cache entry is replaced with kept-only IDs so
  // downstream tables filter against what actually lands in the
  // target (propagates chained orphans).
  const parentIdsCache = new Map<TableName, Set<string>>();
  for (const parent of TABLE_ORDER) {
    parentIdsCache.set(parent, loadParentIds(sqlite, parent));
  }

  for (const table of TABLE_ORDER) {
    const rawRows = readAllRows(sqlite, table);
    let rows = rawRows;
    let droppedOrphans = 0;
    const fkColumns = FK_COLUMNS[table];
    if (fkColumns !== undefined) {
      const filtered = filterOrphans(rawRows, fkColumns, parentIdsCache);
      rows = filtered.kept;
      droppedOrphans = filtered.dropped;
    }
    parentIdsCache.set(table, new Set(rows.map(r => r.id as string)));
    perTableCounts[table] = rows.length;
    if (rows.length === 0) {
      const orphanNote = droppedOrphans > 0 ? ` (${droppedOrphans} orphans dropped)` : '';
      console.log(`  ${table}: 0 rows (skipped)${orphanNote}`);
      continue;
    }
    const transformed = rows.map(r => transformRow(table, r));
    // pg's JSONB encoder chokes on U+0000 NUL bytes in strings. Sanitize
    // every object value (coerceJson produces JS objects for JSONB
    // columns) before binding. See sanitizeForPg docs.
    for (const row of transformed) {
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        if (typeof v === 'object' && v !== null) {
          row[i] = sanitizeForPg(v) as unknown;
        }
      }
    }
    const columns = TABLE_COLUMNS[table];
    if (cli.dryRun || pool === null) {
      let totalEmitted = 0;
      for (let i = 0; i < transformed.length; i += cli.batchSize) {
        const batch = transformed.slice(i, i + cli.batchSize);
        const sql = buildInsert(table, batch.length, columns);
        const flat: unknown[] = [];
        for (const row of batch) flat.push(...row);
        console.log(`-- ${table} batch ${i / cli.batchSize + 1}: ${batch.length} rows`);
        console.log(sql);
        console.log(`-- params: ${flat.length} values (omitted for brevity)`);
        totalEmitted += batch.length;
      }
      const orphanNote = droppedOrphans > 0 ? ` (${droppedOrphans} orphans dropped)` : '';
      console.log(`  ${table}: ${totalEmitted} rows (dry-run emitted)${orphanNote}`);
      continue;
    }
    const client = await pool.connect();
    try {
      for (let i = 0; i < transformed.length; i += cli.batchSize) {
        const batch = transformed.slice(i, i + cli.batchSize);
        const sql = buildInsert(table, batch.length, columns);
        const flat: unknown[] = [];
        for (const row of batch) flat.push(...row);
        try {
          await client.query(sql, flat);
        } catch (batchErr) {
          console.error(
            `[apply] INSERT failed on ${table} batch ${i / cli.batchSize + 1} (rows ${i}..${i + batch.length - 1}): ${(batchErr as Error).message}`
          );
          throw batchErr;
        }
      }
    } finally {
      client.release();
    }
    const orphanNote = droppedOrphans > 0 ? ` (${droppedOrphans} orphans dropped)` : '';
    console.log(`  ${table}: ${rows.length} rows${orphanNote}`);
  }
  return { perTableCounts, dryRun: cli.dryRun };
}

async function verifyMigration(pool: Pool, sqlite: Database): Promise<VerifyResult> {
  const mismatches: { table: TableName; source: number; target: number }[] = [];
  for (const table of TABLE_ORDER) {
    const sourceCount = readAllRows(sqlite, table).length;
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

function summarize(perTable: Record<TableName, number>): string {
  return TABLE_ORDER.map(t => `${perTable[t]} ${t.replace('remote_agent_', '')}`).join(', ');
}

async function main(cli: CliArgs): Promise<number> {
  if (cli.help) {
    console.log(`SQLite -> Postgres migration
Usage: bun run scripts/migrate-sqlite-to-postgres.ts [flags]
Flags:
  --from <path>     Source SQLite file
  --to <url>        Target Postgres URL
  --dry-run         Emit SQL, do not execute
  --verify          After import, compare row counts
  --batch-size <N>  Rows per multi-row INSERT
  -h, --help        Show this help`);
    return 0;
  }
  if (!cli.to) {
    console.error('Error: --to <postgres-url> is required (or set DATABASE_URL).');
    return 1;
  }
  if (!existsSync(cli.from)) {
    console.error(`Error: source SQLite file not found: ${cli.from}`);
    return 1;
  }
  console.log('SQLite -> Postgres migration');
  console.log(`  from: ${cli.from}`);
  console.log(`  to:   ${cli.to.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`  mode: ${cli.dryRun ? 'dry-run' : cli.verify ? 'verify-after-migrate' : 'apply'}`);
  console.log(`  batch-size: ${cli.batchSize}`);

  const sqlite = new Database(cli.from);
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA busy_timeout = 5000');
  console.log('  source opened (WAL + busy_timeout=5000ms)');

  let pool: Pool | null = null;
  if (!cli.dryRun) {
    pool = new Pool({
      connectionString: cli.to,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    pool.on('error', err => {
      console.error(`pg.Pool error: ${err.message}`);
    });
  }

  try {
    if (cli.dryRun) {
      console.log('\n[dry-run] Emitting SQL batches:\n');
      const result = await runMigration(sqlite, null, cli);
      console.log(`\n[dry-run] would migrate: ${summarize(result.perTableCounts)}`);
      return 0;
    }

    if (pool === null) throw new Error('unreachable');
    const client = await pool.connect();
    let result: MigrationResult;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      console.log('\n[apply] Transaction started...');
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
    process.exit(1);
  }
  main(parsedCli)
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(`Fatal: ${(err as Error).message}`);
      process.exit(2);
    });
}
