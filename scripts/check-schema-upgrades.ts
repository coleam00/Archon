#!/usr/bin/env bun
/**
 * Applies `migrations/000_combined.sql` to databases created by OLDER Archon
 * releases and asserts the upgrade converges on the fresh-install schema.
 *
 * This exists because the whole class of schema-apply bugs is invisible to a
 * fresh database. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table,
 * so any statement that names a column added later by the additive ALTER block
 * succeeds on a fresh install and fails on an upgrade — and since initSchema()
 * applies the file in ONE transaction and re-throws at fatal, that one statement
 * rolls the apply back and crash-loops every boot. #2508 shipped green through
 * unit tests, type checks and a docker smoke test for exactly this reason: every
 * one of them starts from an empty database.
 *
 * Baselines are real release tags, so "can an install from version X upgrade?"
 * is answered by evidence rather than by reading the SQL. Verified to have teeth:
 * with v0.7.0 as the baseline, v0.8.0's schema reproduces #2508 (exit 3,
 * `column "event_order" does not exist`).
 *
 * Usage:
 *   bun run check:schema-upgrades              # default baselines (see below)
 *   bun run check:schema-upgrades v0.7.0 HEAD~50
 *
 * Connection: standard psql env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD), or a
 * DATABASE_URL whose database name is ignored — this script creates and drops
 * its own scratch databases.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCHEMA_PATH = resolve(import.meta.dir, '..', 'migrations', '000_combined.sql');
const SCHEMA_REPO_PATH = 'migrations/000_combined.sql';

/** How many of the most recent release tags to test upgrades from. */
const RECENT_BASELINES = 5;

interface Baseline {
  ref: string;
  sql: string;
}

function git(...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

/** psql env, with DATABASE_URL decomposed into PG* vars when present. */
function psqlEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const url = process.env.DATABASE_URL;
  if (url) {
    const u = new URL(url);
    if (u.hostname) env.PGHOST = u.hostname;
    if (u.port) env.PGPORT = u.port;
    if (u.username) env.PGUSER = decodeURIComponent(u.username);
    if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  }
  return env;
}

/** Run psql against `db`. `file` applies a script transactionally; `sql` runs one query. */
function psql(db: string, opts: { file?: string; sql?: string }): { code: number; out: string } {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db];
  if (opts.file) args.push('--single-transaction', '-f', opts.file);
  if (opts.sql) args.push('-A', '-t', '-c', opts.sql);
  const r = spawnSync('psql', args, { encoding: 'utf8', env: psqlEnv() });
  if (r.error) {
    console.error(`\npsql could not be executed: ${r.error.message}`);
    console.error('Install the PostgreSQL client and point PGHOST/PGPORT/PGUSER at a server.');
    process.exit(1);
  }
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function admin(sql: string): { code: number; out: string } {
  return psql('postgres', { sql });
}

/** Release tags to upgrade from: the oldest that carries the schema, plus the most recent ones. */
function defaultBaselines(): string[] {
  const tags = git('tag', '--sort=-creatordate').stdout.split('\n').filter(Boolean);
  const withSchema = tags.filter(t => git('cat-file', '-e', `${t}:${SCHEMA_REPO_PATH}`).ok);
  const skipped = tags.length - withSchema.length;
  if (skipped > 0) {
    console.log(`note: ${skipped} tag(s) predate ${SCHEMA_REPO_PATH} and cannot be a baseline`);
  }
  const recent = withSchema.slice(0, RECENT_BASELINES);
  const oldest = withSchema[withSchema.length - 1];
  return oldest && !recent.includes(oldest) ? [...recent, oldest] : recent;
}

function loadBaselines(refs: string[], dir: string): Baseline[] {
  const out: Baseline[] = [];
  for (const ref of refs) {
    const show = git('show', `${ref}:${SCHEMA_REPO_PATH}`);
    if (!show.ok) {
      console.log(`skip ${ref}: no ${SCHEMA_REPO_PATH} at that ref`);
      continue;
    }
    const file = join(dir, `${ref.replace(/[^\w.-]/g, '_')}.sql`);
    writeFileSync(file, show.stdout);
    out.push({ ref, sql: file });
  }
  return out;
}

const CATALOG_QUERIES: Record<string, string> = {
  columns: `SELECT table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||COALESCE(column_default,'-')
            FROM information_schema.columns WHERE table_schema='public' ORDER BY 1`,
  indexes: "SELECT indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1",
  comments: `SELECT COALESCE(c.relname,'')||'.'||COALESCE(a.attname,'')||' = '||d.description
             FROM pg_description d
             LEFT JOIN pg_class c ON c.oid = d.objoid
             LEFT JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
             ORDER BY 1`,
};

function catalog(db: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
    const r = psql(db, { sql });
    if (r.code !== 0) throw new Error(`catalog query '${name}' failed on ${db}: ${r.out}`);
    snapshot[name] = r.out.trim();
  }
  return snapshot;
}

function recreate(db: string): void {
  admin(`DROP DATABASE IF EXISTS ${db}`);
  const r = admin(`CREATE DATABASE ${db}`);
  if (r.code !== 0) {
    console.error(`could not create ${db}: ${r.out}`);
    process.exit(1);
  }
}

function dbNameFor(ref: string): string {
  return `archon_upgrade_${ref.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
}

const requested = process.argv.slice(2).filter(a => !a.startsWith('-'));
const refs = requested.length > 0 ? requested : defaultBaselines();
if (refs.length === 0) {
  console.error('no baseline refs to test (no release tags carry the schema file)');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'archon-schema-upgrade-'));
let failures = 0;

try {
  const baselines = loadBaselines(refs, workDir);
  if (baselines.length === 0) {
    console.error('none of the requested refs carry the schema file');
    process.exit(1);
  }

  // Reference: what a fresh install of the CURRENT schema looks like.
  const freshDb = 'archon_upgrade_fresh';
  recreate(freshDb);
  const fresh = psql(freshDb, { file: SCHEMA_PATH });
  if (fresh.code !== 0) {
    console.error(`FAIL fresh install of the current schema:\n${fresh.out}`);
    process.exit(1);
  }
  const freshCatalog = catalog(freshDb);
  console.log(`fresh install OK (${freshCatalog.indexes.split('\n').length} indexes)\n`);

  for (const { ref, sql } of baselines) {
    const db = dbNameFor(ref);
    recreate(db);

    const base = psql(db, { file: sql });
    if (base.code !== 0) {
      // The old file itself will not apply — a broken baseline, not an upgrade bug,
      // but still a real "you cannot stand this version up" signal worth failing on.
      console.error(`FAIL ${ref}: the baseline schema itself did not apply\n${base.out}`);
      failures++;
      admin(`DROP DATABASE IF EXISTS ${db}`);
      continue;
    }

    const upgrade = psql(db, { file: SCHEMA_PATH });
    if (upgrade.code !== 0) {
      console.error(`FAIL ${ref}: upgrading to the current schema aborted\n${upgrade.out}`);
      failures++;
      admin(`DROP DATABASE IF EXISTS ${db}`);
      continue;
    }

    // Applied twice on purpose: every boot and every CLI invocation re-applies.
    const again = psql(db, { file: SCHEMA_PATH });
    if (again.code !== 0) {
      console.error(`FAIL ${ref}: re-applying the current schema is not idempotent\n${again.out}`);
      failures++;
      admin(`DROP DATABASE IF EXISTS ${db}`);
      continue;
    }

    const upgraded = catalog(db);
    const drift = Object.keys(CATALOG_QUERIES).filter(k => upgraded[k] !== freshCatalog[k]);
    if (drift.length > 0) {
      // An upgrade that survives but lands somewhere else is the other half of
      // this failure mode: the crash is gone and an index quietly is too.
      console.error(
        `FAIL ${ref}: upgraded schema differs from a fresh install (${drift.join(', ')})`
      );
      for (const k of drift) {
        const freshLines = new Set(freshCatalog[k].split('\n'));
        const upgradedLines = new Set(upgraded[k].split('\n'));
        for (const line of freshLines) {
          if (!upgradedLines.has(line)) console.error(`  missing after upgrade [${k}]: ${line}`);
        }
        for (const line of upgradedLines) {
          if (!freshLines.has(line)) console.error(`  extra after upgrade   [${k}]: ${line}`);
        }
      }
      failures++;
      admin(`DROP DATABASE IF EXISTS ${db}`);
      continue;
    }

    console.log(`ok   ${ref} → current (idempotent, converges on the fresh schema)`);
    admin(`DROP DATABASE IF EXISTS ${db}`);
  }

  admin(`DROP DATABASE IF EXISTS ${freshDb}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncheck:schema-upgrades FAILED (${failures} baseline(s))`);
  process.exit(1);
}
console.log('\ncheck:schema-upgrades OK');
