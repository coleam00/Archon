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
 * DATABASE_URL — its options are honoured but its database name is replaced,
 * since this script creates and drops its own scratch databases.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCHEMA_PATH = resolve(import.meta.dir, '..', 'migrations', '000_combined.sql');
const SCHEMA_REPO_PATH = 'migrations/000_combined.sql';

interface Baseline {
  ref: string;
  sql: string;
}

/**
 * Deliberately `spawnSync` rather than `@archon/git`: this script must run in CI
 * with no `bun install` (it imports nothing outside Node builtins), and reads
 * history — `git show <ref>:<path>` — rather than manipulating worktrees, which
 * is what `@archon/git` covers. The argument array means no ref ever reaches a
 * shell.
 */
function git(...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  // A launch failure is not "this ref has no schema file" — reporting it as one
  // would accuse the repository of missing a file that is present.
  if (r.error) throw new Error(`git could not be executed: ${r.error.message}`);
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

/**
 * Connection target for one database. With DATABASE_URL set, the URI is passed
 * through with only its database name replaced, so `?sslmode=…` and the rest of
 * the query string survive; otherwise psql reads the standard PG* env vars.
 *
 * One documented libpq shape is not supported: a comma-separated multi-host URI
 * (`postgresql://a:5432,b:5432/db`) is not parseable by WHATWG `URL`. Use PG* env
 * vars for that case.
 */
function connectionFor(db: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) return db;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(
      `DATABASE_URL is not a parseable URI: ${url.replace(/:[^:@/]*@/, ':***@')}\n` +
        'Multi-host URIs are the known unsupported shape — use PGHOST/PGPORT/PGUSER instead.'
    );
  }
  u.pathname = `/${db}`;
  return u.toString();
}

/** Run psql against `db`. `file` applies a script transactionally; `sql` runs one query. */
function psql(db: string, opts: { file?: string; sql?: string }): { code: number; out: string } {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', connectionFor(db)];
  if (opts.file) args.push('--single-transaction', '-f', opts.file);
  if (opts.sql) args.push('-A', '-t', '-c', opts.sql);
  const r = spawnSync('psql', args, { encoding: 'utf8' });
  if (r.error) {
    throw new Error(
      `psql could not be executed: ${r.error.message}\n` +
        'Install the PostgreSQL client and point PGHOST/PGPORT/PGUSER (or DATABASE_URL) at a server.'
    );
  }
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function admin(sql: string): { code: number; out: string } {
  return psql('postgres', { sql });
}

/**
 * Every DISTINCT schema ever shipped in a release tag, oldest tag per version.
 *
 * A release that does not touch the schema ships the same file as the one before
 * it — 21 tags carry 8 distinct versions today, and v0.3.0 through v0.3.12 are all
 * byte-identical. Deduplicating by blob therefore makes this the set of vintages a
 * real install can actually have, rather than a sample of recent releases, and it
 * grows with schema churn instead of release cadence.
 */
function defaultBaselines(): string[] {
  const tags = git('tag', '--sort=creatordate').stdout.split('\n').filter(Boolean);
  const oldestTagPerSchema = new Map<string, string>();
  let withoutSchema = 0;

  for (const tag of tags) {
    const blob = git('rev-parse', `${tag}:${SCHEMA_REPO_PATH}`);
    if (!blob.ok) {
      withoutSchema++;
      continue;
    }
    const id = blob.stdout.trim();
    if (!oldestTagPerSchema.has(id)) oldestTagPerSchema.set(id, tag);
  }

  if (withoutSchema > 0) {
    console.log(
      `note: ${withoutSchema} tag(s) predate ${SCHEMA_REPO_PATH} and cannot be a baseline`
    );
  }
  console.log(
    `note: ${tags.length - withoutSchema} tag(s) carry ${oldestTagPerSchema.size} distinct schema version(s)`
  );
  return [...oldestTagPerSchema.values()];
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
  constraints: `SELECT conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)
                FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
  sequences: `SELECT sequencename||' owned_by='||COALESCE(
                (SELECT c.relname||'.'||a.attname
                 FROM pg_depend d
                 JOIN pg_class c ON c.oid = d.refobjid
                 JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                 WHERE d.objid = (schemaname||'.'||sequencename)::regclass AND d.deptype = 'a'),
                '-')
              FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
};

/**
 * The one divergence between a fresh install and an upgrade that is expected.
 *
 * `remote_agent_codebases.kind` carries `CHECK (kind IN ('repo','folder'))` in the
 * CREATE TABLE body, and a constraint declared there binds only databases created
 * after it (AGENTS.md). It is deliberately NOT repeated in the additive block:
 * `ALTER TABLE ... ADD CONSTRAINT` validates existing rows, so a single unexpected
 * value would abort the entire apply — the crash-loop class this check exists to
 * prevent. SQLite cannot add a CHECK by ALTER at all, so both dialects agree in
 * staying tolerant and letting application code enforce the value set.
 *
 * Deliberately not a general allowlist. One exception, matched on the exact
 * constraint identity — `<table> <conname>`, so Postgres's auto-generated
 * `..._kind_check1` sibling is NOT covered — and consulted in only one direction,
 * where the UPGRADED database is the one missing it. Anything else, including an
 * upgrade that GAINED a constraint, still fails.
 */
const EXPECTED_MISSING_CONSTRAINT = 'remote_agent_codebases remote_agent_codebases_kind_check';

/** True for the single sanctioned "fresh has it, upgraded does not" constraint. */
function isExpectedMissingConstraint(catalogName: string, line: string): boolean {
  if (catalogName !== 'constraints') return false;
  const [table, conname] = line.split(' ');
  return `${table} ${conname}` === EXPECTED_MISSING_CONSTRAINT;
}

function catalog(db: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
    const r = psql(db, { sql });
    if (r.code !== 0) throw new Error(`catalog query '${name}' failed on ${db}: ${r.out}`);
    snapshot[name] = r.out.trim();
  }
  return snapshot;
}

/**
 * Scratch databases this run created. Tracked so no failure path can leak one:
 * the interesting failure is "the current schema does not apply", and leaving
 * the wreckage of that behind on a developer's persistent server would be a poor
 * thank-you for the check that found it.
 */
const createdDbs = new Set<string>();

function recreate(db: string): void {
  admin(`DROP DATABASE IF EXISTS ${db}`);
  const r = admin(`CREATE DATABASE ${db}`);
  if (r.code !== 0) throw new Error(`could not create ${db}: ${r.out}`);
  createdDbs.add(db);
}

function drop(db: string): void {
  admin(`DROP DATABASE IF EXISTS ${db}`);
  createdDbs.delete(db);
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
/** Whether the one sanctioned divergence actually turned up — see the stale check below. */
let expectedMissingSeen = false;

try {
  const baselines = loadBaselines(refs, workDir);
  if (baselines.length === 0) throw new Error('none of the requested refs carry the schema file');

  // Reference: what a fresh install of the CURRENT schema looks like.
  const freshDb = 'archon_upgrade_fresh';
  recreate(freshDb);
  const fresh = psql(freshDb, { file: SCHEMA_PATH });
  if (fresh.code !== 0) {
    throw new Error(`FAIL fresh install of the current schema:\n${fresh.out}`);
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
      drop(db);
      continue;
    }

    const upgrade = psql(db, { file: SCHEMA_PATH });
    if (upgrade.code !== 0) {
      console.error(`FAIL ${ref}: upgrading to the current schema aborted\n${upgrade.out}`);
      failures++;
      drop(db);
      continue;
    }

    // Applied twice on purpose: every boot and every CLI invocation re-applies.
    const again = psql(db, { file: SCHEMA_PATH });
    if (again.code !== 0) {
      console.error(`FAIL ${ref}: re-applying the current schema is not idempotent\n${again.out}`);
      failures++;
      drop(db);
      continue;
    }

    // An upgrade that survives but lands somewhere else is the other half of
    // this failure mode: the crash is gone and an index quietly is too.
    const upgraded = catalog(db);
    const differences: string[] = [];
    const allowed: string[] = [];

    for (const k of Object.keys(CATALOG_QUERIES)) {
      const freshLines = new Set(freshCatalog[k].split('\n').filter(Boolean));
      const upgradedLines = new Set(upgraded[k].split('\n').filter(Boolean));
      for (const line of freshLines) {
        if (upgradedLines.has(line)) continue;
        if (isExpectedMissingConstraint(k, line)) {
          expectedMissingSeen = true;
          allowed.push(`[${k}] ${line}`);
          continue;
        }
        differences.push(`  missing after upgrade [${k}]: ${line}`);
      }
      // No exception in this direction: an upgrade that GAINED something the
      // fresh schema lacks is always a finding.
      for (const line of upgradedLines) {
        if (!freshLines.has(line)) differences.push(`  extra after upgrade   [${k}]: ${line}`);
      }
    }

    // Printed before the verdict, so a ref with both a real and an expected
    // divergence still shows what was excused. Labelled with the ref, since it
    // no longer sits under that ref's ok line.
    for (const line of allowed) console.log(`     ${ref}: expected divergence ${line}`);

    if (differences.length > 0) {
      console.error(`FAIL ${ref}: upgraded schema differs from a fresh install`);
      for (const line of differences) console.error(line);
      failures++;
      drop(db);
      continue;
    }

    console.log(`ok   ${ref} → current (idempotent, converges on the fresh schema)`);
    drop(db);
  }

  drop(freshDb);
} catch (err) {
  console.error(`\n${(err as Error).message}`);
  failures++;
} finally {
  // Runs on every path, including the early failures above.
  for (const db of createdDbs) {
    const r = admin(`DROP DATABASE IF EXISTS ${db}`);
    // Not fatal — the next run's DROP ... IF EXISTS collects it — but never silent.
    if (r.code !== 0) console.error(`warning: could not drop scratch database ${db}\n${r.out}`);
  }
  rmSync(workDir, { recursive: true, force: true });
}

// The exception above must keep describing real drift, or it is a hole that
// outlived its reason. On a default run the oldest baseline guarantees it fires;
// an explicit-ref run may legitimately not reach it, so only assert the default.
if (requested.length === 0 && failures === 0 && !expectedMissingSeen) {
  console.error(
    `\ncheck:schema-upgrades FAILED: the expected divergence (${EXPECTED_MISSING_CONSTRAINT}) never appeared.`
  );
  console.error(
    'It is stale. If that constraint was renamed or removed, delete EXPECTED_MISSING_CONSTRAINT from this script.'
  );
  process.exit(1);
}

if (failures > 0) {
  console.error(`\ncheck:schema-upgrades FAILED (${failures} baseline(s))`);
  process.exit(1);
}
console.log('\ncheck:schema-upgrades OK');
