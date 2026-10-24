import { describe, test, expect, afterEach } from 'bun:test';
import { SqliteAdapter } from './sqlite';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Upgrade-convergence check against REAL released schema vintages.
 *
 * Each fixture in ../fixtures/sqlite-vintages/ is the exact DDL a released tag's
 * createSchema() executed (regenerate with `bun run generate:sqlite-vintages`).
 * Fixtures are checked in — rather than extracted from tags at test time —
 * because this test must also run in the shallow CI checkout, where tags do not
 * exist.
 *
 * For every vintage: build an empty database from the fixture, open it with the
 * CURRENT SqliteAdapter (the constructor completing is the "upgrade does not
 * throw" assertion), then require the resulting catalog to equal a fresh
 * install's. Comparisons are semantic, not raw sqlite_master text, because
 * SQLite cannot ALTER a NOT NULL constraint onto an existing column — table
 * definitions are compared by name and column name:type only, which is exactly
 * the sanctioned divergence class documented in createSchema(). Index and
 * trigger definitions carry full whitespace-normalized SQL, so a lost index or
 * trigger still fails.
 */

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'sqlite-vintages');

const tempDbPaths: string[] = [];

function tempDbPath(): string {
  const path = join(
    import.meta.dir,
    `.test-sqlite-vintage-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  tempDbPaths.push(path);
  return path;
}

/** Whitespace-normalized SQL, so formatting differences between vintages don't count. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface Catalog {
  // table name → column "name:TYPE" set. NOT NULL / defaults are deliberately
  // absent: they are the one sanctioned fresh-vs-upgraded divergence class.
  tables: Map<string, Set<string>>;
  // index/trigger name → "tbl_name|sql", compared on full normalized SQL.
  objects: Map<string, string>;
}

/**
 * The one divergence between a fresh install and an upgrade that is expected.
 *
 * remote_agent_codebases.allow_env_keys shipped in the v0.3.1 SQLite schema and
 * was dropped from sqlite.ts afterwards (#2318); existing v0.3.1 databases keep
 * it because CREATE TABLE IF NOT EXISTS cannot remove a column and Archon's
 * schema evolution is additive-only. The parity check in sqlite.test.ts tracks
 * the same column as its documented Postgres-only exception.
 *
 * Deliberately not a general allowlist, and consulted in one direction only:
 * an upgraded database GAINING any other column the fresh schema lacks still
 * fails, as does every missing table/column and every index/trigger difference.
 */
const EXPECTED_EXTRA_COLUMNS = new Set(['remote_agent_codebases.allow_env_keys']);

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  name: string;
  type: string;
}

function readCatalog(path: string): Catalog {
  const raw = new Database(path);
  // close() is sqlite3_close_v2, so the connection keeps its file open until
  // every prepared statement is finalized. Track them and finalize explicitly.
  const statements: { finalize(): void }[] = [];
  const prepare = (sql: string) => {
    const stmt = raw.prepare(sql);
    statements.push(stmt);
    return stmt;
  };

  try {
    const objects = prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ).all() as MasterRow[];

    const tables = new Map<string, Set<string>>();
    for (const table of objects.filter(o => o.type === 'table')) {
      const cols = prepare(`PRAGMA table_info('${table.name}')`).all() as TableInfoRow[];
      tables.set(table.name, new Set(cols.map(c => `${c.name}:${c.type}`)));
    }

    const indexedObjects = new Map<string, string>();
    for (const o of objects.filter(o => o.type === 'index' || o.type === 'trigger')) {
      indexedObjects.set(o.name, `${o.tbl_name}|${normalizeSql(o.sql ?? '')}`);
    }

    return { tables, objects: indexedObjects };
  } finally {
    for (const stmt of statements) stmt.finalize();
    raw.close();
  }
}

/**
 * Delete one temp file, tolerating a database handle this test cannot close.
 *
 * SqliteAdapter prepares statements in initSchema() that it never finalizes, so
 * sqlite3_close_v2 leaves each vintage database open after `await close()`
 * until garbage collection finalizes them; Bun.gc(true) forces that pass. POSIX
 * unlink ignores an open handle, Windows rejects it with EBUSY, so retry with
 * another finalization pass between attempts. A temp file surviving all of that
 * is not a failure of what this test asserts, but it should stay visible.
 */
function removeTempFile(path: string): void {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (existsSync(path)) unlinkSync(path);
      return;
    } catch (error) {
      if (attempt === 3) {
        console.warn(`[sqlite-vintages] could not remove ${path}: ${String(error)}`);
        return;
      }
      Bun.gc(true);
    }
  }
}

/** Differences between `upgraded` and a fresh install, split by expectation. */
interface CatalogDiff {
  diffs: string[];
  excused: string[];
}

function diffColumns(
  name: string,
  cols: Set<string>,
  got: Set<string>,
  { diffs, excused }: CatalogDiff
): void {
  for (const col of cols) {
    if (!got.has(col)) diffs.push(`missing after upgrade [column]: ${name}.${col}`);
  }
  for (const col of got) {
    if (!cols.has(col)) {
      const colName = col.slice(0, col.indexOf(':'));
      const qualified = `${name}.${colName}`;
      if (EXPECTED_EXTRA_COLUMNS.has(qualified)) excused.push(`[column]: ${qualified}`);
      else diffs.push(`extra after upgrade [column]: ${qualified}`);
    }
  }
}

function diffObjects(fresh: Map<string, string>, upgraded: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [name, def] of fresh) {
    const got = upgraded.get(name);
    if (got === undefined) diffs.push(`missing after upgrade [index/trigger]: ${name} (${def})`);
    else if (got !== def)
      diffs.push(`changed after upgrade [index/trigger]: ${name}: fresh=${def} upgraded=${got}`);
  }
  for (const [name, def] of upgraded) {
    if (!fresh.has(name)) diffs.push(`extra after upgrade [index/trigger]: ${name} (${def})`);
  }
  return diffs;
}

function diffCatalogs(fresh: Catalog, upgraded: Catalog): CatalogDiff {
  const diffs: string[] = [];
  const excused: string[] = [];
  for (const [name, cols] of fresh.tables) {
    const got = upgraded.tables.get(name);
    if (!got) {
      diffs.push(`missing after upgrade [table]: ${name}`);
      continue;
    }
    diffColumns(name, cols, got, { diffs, excused });
  }
  for (const name of upgraded.tables.keys()) {
    if (!fresh.tables.has(name)) diffs.push(`extra after upgrade [table]: ${name}`);
  }
  diffs.push(...diffObjects(fresh.objects, upgraded.objects));
  return { diffs, excused };
}

describe('SqliteAdapter upgrades from released schema vintages', () => {
  afterEach(() => {
    // Finalizes the statements SqliteAdapter left behind, which is what releases
    // its hold on each database file. See removeTempFile().
    Bun.gc(true);
    // -wal/-shm sidecars exist while a connection is open; sweep them in case
    // a failure leaves one behind alongside its database.
    for (const base of tempDbPaths) {
      for (const path of [base, `${base}-wal`, `${base}-shm`]) removeTempFile(path);
    }
    tempDbPaths.length = 0;
  });

  test('every released vintage converges on the fresh-install schema', async () => {
    const freshObjects: Catalog = {
      tables: new Map(),
      objects: new Map([
        ['missing_index', 'items|CREATE INDEX missing_index ON items (id)'],
        ['changed_trigger', 'items|CREATE TRIGGER changed_trigger BEFORE INSERT ON items'],
      ]),
    };
    const upgradedObjects: Catalog = {
      tables: new Map(),
      objects: new Map([
        ['changed_trigger', 'items|CREATE TRIGGER changed_trigger AFTER INSERT ON items'],
        ['extra_index', 'items|CREATE INDEX extra_index ON items (name)'],
      ]),
    };
    expect(diffCatalogs(freshObjects, upgradedObjects)).toEqual({
      diffs: [
        'missing after upgrade [index/trigger]: missing_index (items|CREATE INDEX missing_index ON items (id))',
        'changed after upgrade [index/trigger]: changed_trigger: fresh=items|CREATE TRIGGER changed_trigger BEFORE INSERT ON items upgraded=items|CREATE TRIGGER changed_trigger AFTER INSERT ON items',
        'extra after upgrade [index/trigger]: extra_index (items|CREATE INDEX extra_index ON items (name))',
      ],
      excused: [],
    });

    const fixtureFiles = existsSync(FIXTURES_DIR)
      ? readdirSync(FIXTURES_DIR)
          .filter(f => f.endsWith('.sql'))
          .sort()
      : [];
    expect(fixtureFiles.length).toBeGreaterThan(0);

    const freshPath = tempDbPath();
    const fresh = new SqliteAdapter(freshPath);
    await fresh.close();
    const freshCatalog = readCatalog(freshPath);

    const excusedSeen: string[] = [];
    for (const file of fixtureFiles) {
      const vintage = file.replace(/\.sql$/, '');
      const dbPath = tempDbPath();
      const raw = new Database(dbPath);
      try {
        raw.exec(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
      } finally {
        raw.close();
      }

      // Constructor completion IS the assertion: the #2552 failure mode was a
      // throw from inside this call, leaving the database permanently unopenable.
      const upgraded = new SqliteAdapter(dbPath);
      await upgraded.close();

      // Prefix with the vintage so a failure names which released schema broke.
      const { diffs, excused } = diffCatalogs(freshCatalog, readCatalog(dbPath));
      expect(diffs.map(d => `[${vintage}] ${d}`)).toEqual([]);
      excusedSeen.push(...excused.map(d => `[${vintage}] ${d}`));
    }

    // Self-expiring guard, mirroring EXPECTED_MISSING_CONSTRAINT in
    // check-schema-upgrades.ts: the exception must keep describing real drift.
    // If the v0.3.1 vintage ever stops carrying the column (fixture removed or
    // extraction changed), this fails until the exception is deleted.
    expect(excusedSeen).toEqual(['[v0.3.1] [column]: remote_agent_codebases.allow_env_keys']);
  }, 120_000);
});
