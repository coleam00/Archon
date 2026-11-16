/**
 * Which server `check-schema-upgrades.ts` reaches. A stub psql on PATH records
 * every call's target and fails, which ends the run at its first statement, so
 * no test here reaches a real PostgreSQL.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const SCRIPT = join(import.meta.dir, 'check-schema-upgrades.ts');
const CONNECTION_KEYS = ['DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGPORT', 'PGUSER'];

/** Runs the check with only `conn` as connection settings; returns its psql calls. */
function run(conn: Record<string, string>): {
  status: number | null;
  out: string;
  calls: string[];
} {
  const stubs = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-schema-stubs-')));
  const log = join(stubs, 'psql-calls.log');
  writeFileSync(
    join(stubs, 'psql'),
    `#!/bin/sh\nfor a; do case "$prev" in -d) d="$a";; esac; prev="$a"; done\n` +
      `printf '%s\\n' "PGHOST=\${PGHOST-} -d $d" >> '${log}'; exit 1\n`
  );
  chmodSync(join(stubs, 'psql'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, ...conn };
  for (const key of CONNECTION_KEYS) if (!(key in conn)) delete env[key];
  env.PATH = `${stubs}${delimiter}${env.PATH ?? ''}`;
  // `--no-env-file`, as the package script runs it, so a repo `.env` cannot name a server.
  const r = spawnSync('bun', ['--no-env-file', SCRIPT, 'HEAD'], {
    cwd: join(import.meta.dir, '..'),
    encoding: 'utf8',
    env,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

const skipOnWindows = test.skipIf(process.platform === 'win32');

skipOnWindows(
  'with no server named, it exits before any psql call and says how to name one',
  () => {
    const r = run({ PGPORT: '5432', PGUSER: 'postgres' });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('PGHOST=');
  }
);

skipOnWindows('a DATABASE_URL with no host names no server on its own', () => {
  const r = run({ DATABASE_URL: 'postgres:///archon?user=postgres' });
  expect(r.status).toBe(1);
  expect(r.calls).toEqual([]);
  expect(r.out).toContain('DATABASE_URL names no host');
});

skipOnWindows('a DATABASE_URL that repeats or empties a server parameter is refused', () => {
  // libpq takes the last value of a repeated parameter, and an empty host means
  // the default socket, overriding both the authority and PGHOST.
  for (const conn of <Record<string, string>[]>[
    { DATABASE_URL: 'postgres://named.invalid/app?host=' },
    { DATABASE_URL: 'postgres://named.invalid/app?host=named.invalid&host=' },
    { DATABASE_URL: 'postgres://named.invalid/app?hostaddr=' },
    { DATABASE_URL: 'postgres:///app?host=', PGHOST: '/scratch/sock' },
  ]) {
    const r = run(conn);
    expect(r.status, conn.DATABASE_URL).toBe(1);
    expect(r.calls, conn.DATABASE_URL).toEqual([]);
    expect(r.out).toContain('repeats or empties');
  }
});

skipOnWindows('a named server is the one every psql call targets', () => {
  const byHost = run({ PGHOST: '/scratch/sock', PGUSER: 'postgres' });
  expect(byHost.calls.length).toBeGreaterThan(0);
  expect(new Set(byHost.calls)).toEqual(new Set(['PGHOST=/scratch/sock -d postgres']));

  const byUrl = run({ DATABASE_URL: 'postgres://u@scratch.example:5433/app?sslmode=disable' });
  expect(byUrl.calls.length).toBeGreaterThan(0);
  expect(new Set(byUrl.calls)).toEqual(
    new Set(['PGHOST= -d postgres://u@scratch.example:5433/postgres?sslmode=disable'])
  );

  // A host query parameter names the server, and a dbname parameter cannot
  // move the run off the scratch database the script picked.
  const byParam = run({ DATABASE_URL: 'postgres:///app?host=/scratch/sock&dbname=real' });
  expect(new Set(byParam.calls)).toEqual(
    new Set(['PGHOST= -d postgres:///postgres?host=%2Fscratch%2Fsock'])
  );

  // A hostless URL takes its server from PGHOST, so with PGHOST set it runs.
  const hostless = run({
    DATABASE_URL: 'postgres:///archon?user=postgres',
    PGHOST: '/scratch/sock',
  });
  expect(new Set(hostless.calls)).toEqual(
    new Set(['PGHOST=/scratch/sock -d postgres:///postgres?user=postgres'])
  );
});
