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
 * Connection: the check creates and drops databases, so it only touches a server
 * someone named for it. Name one with PGHOST, PGHOSTADDR, PGSERVICE or
 * DATABASE_URL (a DATABASE_URL keeps its options; its database name is replaced).
 * PGPORT, PGUSER and PGPASSWORD refine a named server but do not name one: on
 * their own psql still reaches the default local socket, which is whatever
 * PostgreSQL happens to run on the machine. With no server named, the script
 * starts a throwaway PostgreSQL (initdb + pg_ctl, socket-only, in a temp dir),
 * runs against it, then stops it and deletes it. The package script passes
 * `--no-env-file`, so a DATABASE_URL in `.env` is not taken as a name.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { defaultBaselines, SCHEMA_REPO_PATH } from './schema-upgrade-baselines';

const SCHEMA_PATH = resolve(import.meta.dir, '..', SCHEMA_REPO_PATH);

interface Baseline {
  ref: string;
  sql: string;
}

/**
 * Deliberately `spawnSync` rather than `@archon/git`: this script must run in CI
 * with no `bun install` (only local modules and Node builtins), and reads
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
  triggers: 'SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1',
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

/** True when the caller picked a server; see the Connection note in the header. */
function serverNamed(): boolean {
  return ['DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGSERVICE'].some(k => !!process.env[k]);
}

/**
 * The bin dir holding initdb and pg_ctl, or undefined. PATH first, then
 * `pg_config --bindir` (Debian and Homebrew keg installs keep the server
 * binaries off PATH). The dir is put first on PATH so initdb, pg_ctl and psql
 * all come from one install.
 */
function findServerBinDir(): string | undefined {
  if (!spawnSync('initdb', ['--version']).error && !spawnSync('pg_ctl', ['--version']).error) {
    return '';
  }
  const cfg = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (cfg.error || cfg.status !== 0) return undefined;
  const dir = cfg.stdout.trim();
  return existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl')) ? dir : undefined;
}

/**
 * Data dir of the throwaway server this run started, if any. Its own short temp
 * dir, separate from workDir: the socket lives there and macOS caps a socket
 * path at about 103 bytes.
 */
let throwaway: { dir: string; data: string } | undefined;

// macOS: without a C locale initdb rejects the locale and the postmaster dies
// with "postmaster became multithreaded during startup".
const serverEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' });

function startThrowawayServer(): void {
  const bin = findServerBinDir();
  if (bin === undefined) {
    console.error(
      'No PostgreSQL server was named, and no initdb/pg_ctl was found to start a throwaway one.\n' +
        'This check creates and drops databases, so it will not fall back to the default local socket.\n' +
        'Install the PostgreSQL server binaries, or name a scratch server you own:\n' +
        '  PGHOST=<host or socket dir> PGUSER=<user> bun run check:schema-upgrades\n' +
        '  DATABASE_URL=postgres://user@host:port/any bun run check:schema-upgrades'
    );
    process.exit(1);
  }
  if (bin) process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;

  const dir = mkdtempSync(join(tmpdir(), 'archon-pg-'));
  const data = join(dir, 'data');
  // Before any step that can leave something behind, so no exit is uncovered.
  watchThrowawayServer(dir, data);

  // The client settings are set before startup too: pg_ctl and the postmaster
  // read PGPORT, so an inherited one would put the server on a port psql does
  // not use. DATABASE_URL is unset on this path.
  process.env.PGHOST = dir;
  process.env.PGPORT = '5432';
  process.env.PGUSER = 'postgres';
  delete process.env.PGPASSWORD;

  const init = startupStep(dir, [
    'initdb',
    '-D',
    data,
    '-U',
    'postgres',
    '--auth=trust',
    '-E',
    'UTF8',
    '--no-sync',
  ]);
  if (init.error || init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`initdb failed for the throwaway server:\n${init.error?.message ?? init.stderr}`);
    process.exit(1);
  }

  throwaway = { dir, data };
  const log = join(dir, 'server.log');
  const start = startupStep(dir, [
    'pg_ctl',
    '-D',
    data,
    '-l',
    log,
    '-w',
    '-o',
    `-c listen_addresses='' -c unix_socket_directories='${dir}' -c port=5432 -c fsync=off`,
    'start',
  ]);
  if (start.error || start.status !== 0) {
    console.error(`the throwaway server did not start:\n${start.error?.message ?? start.stderr}`);
    if (existsSync(log)) console.error(readFileSync(log, 'utf8'));
    stopThrowawayServer();
    process.exit(1);
  }

  console.log(`no server named: using a throwaway PostgreSQL in ${dir}\n`);
}

/**
 * Runs initdb or pg_ctl start with its PID recorded in `<dir>/startup.pid`
 * (`exec` keeps the shell's PID), so the watcher can wait for a step this
 * process left running when it died.
 */
function startupStep(dir: string, argv: string[]): SpawnSyncReturns<string> {
  return spawnSync('sh', ['-c', 'echo $$ > "$0/startup.pid" && exec "$@"', dir, ...argv], {
    encoding: 'utf8',
    env: serverEnv(),
  });
}

/**
 * Covers the exits the `finally` below cannot: Ctrl-C and SIGTERM kill this
 * process outright, because Bun runs a signal handler only after synchronous
 * code returns, and this script is synchronous to the end. initdb and pg_ctl
 * outlive a killed parent, and pg_ctl detaches the postmaster, so the server
 * would outlive us. A detached shell waits for this PID to go away, then for
 * any startup step still running (its PID is in startup.pid), then stops the
 * server through pg_ctl and removes the dir. On a normal exit
 * `stopThrowawayServer` has already done both and the watcher finds the dir gone.
 */
function watchThrowawayServer(dir: string, data: string): void {
  const script =
    'while kill -0 "$1" 2>/dev/null; do sleep 1; done; ' +
    '[ -d "$2" ] || exit 0; ' +
    'while [ -f "$2/startup.pid" ] && kill -0 "$(cat "$2/startup.pid")" 2>/dev/null; do sleep 1; done; ' +
    'if [ -f "$3/postmaster.pid" ]; then pg_ctl -D "$3" -m fast -w stop >/dev/null 2>&1 || exit 1; fi; ' +
    'rm -rf "$2"';
  spawn('sh', ['-c', script, 'sh', String(process.pid), dir, data], {
    detached: true,
    stdio: 'ignore',
    env: serverEnv(),
  }).unref();
}

/**
 * Stops the throwaway server through pg_ctl, which signals the PID recorded in
 * postmaster.pid, then removes its dir. If the stop fails the dir is kept: it
 * holds that PID, which the operator needs to stop the server by hand.
 * Returns false when a server was left running. Idempotent.
 */
function stopThrowawayServer(): boolean {
  if (!throwaway) return true;
  const { dir, data } = throwaway;
  throwaway = undefined;
  const pidFile = join(data, 'postmaster.pid');
  if (!existsSync(pidFile)) {
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
  const stop = spawnSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], {
    encoding: 'utf8',
    env: serverEnv(),
  });
  if (!stop.error && stop.status === 0) {
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
  const pid = readFileSync(pidFile, 'utf8').split('\n')[0];
  console.error(
    `could not stop the throwaway PostgreSQL (pid ${pid}, data dir ${data}, log ${join(dir, 'server.log')}):\n` +
      `${stop.error?.message ?? stop.stderr}\nStop it with: pg_ctl -D ${data} stop`
  );
  return false;
}

const requested = process.argv.slice(2).filter(a => !a.startsWith('-'));
const refs = requested.length > 0 ? requested : defaultBaselines(git);
if (refs.length === 0) {
  console.error('no baseline refs to test (no release tags carry the schema file)');
  process.exit(1);
}

// Started after the early exit above, so that exit cannot leave a server behind.
if (!serverNamed()) startThrowawayServer();

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

    const olderWriter = psql(db, {
      sql: `WITH conversation AS (
              INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
              VALUES ('cli', 'upgrade-old-writer') RETURNING id
            )
            INSERT INTO remote_agent_workflow_runs
              (workflow_name, conversation_id, user_message)
            SELECT 'upgrade-old-writer', id, 'legacy insert after upgrade' FROM conversation;
            SELECT COUNT(*) FROM remote_agent_workflow_runs
             WHERE workflow_name = 'upgrade-old-writer' AND origin IS NULL;`,
    });
    if (olderWriter.code !== 0 || olderWriter.out.trim() !== '1') {
      console.error(`FAIL ${ref}: older writer insert after upgrade failed\n${olderWriter.out}`);
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
  if (!stopThrowawayServer()) failures++;
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
