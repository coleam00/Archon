/**
 * The no-server path of `check-schema-upgrades.ts`: with nothing named, every
 * psql call goes to the throwaway server the script started, never to the
 * default socket, and that server is gone when the script exits. CI names its
 * server, so nothing else runs this path.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { testTimeout, trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const SCRIPT = join(import.meta.dir, 'check-schema-upgrades.ts');
const NAMING_KEYS = ['DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGPORT', 'PGUSER'];

function runUnnamed(pathPrefix?: string): { status: number | null; out: string; dir?: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of NAMING_KEYS) delete env[key];
  if (pathPrefix) env.PATH = `${pathPrefix}${delimiter}${env.PATH ?? ''}`;
  // `--no-env-file`, as the package script runs it, so a repo `.env` cannot name a server.
  const r = spawnSync('bun', ['--no-env-file', SCRIPT, 'HEAD'], {
    cwd: join(import.meta.dir, '..'),
    encoding: 'utf8',
    env,
  });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out, dir: /throwaway PostgreSQL in (\S+)/.exec(out)?.[1] };
}

test.skipIf(process.platform === 'win32')(
  'with no server named, every psql call targets the throwaway server',
  () => {
    const stubs = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-schema-stubs-')));
    const calls = join(stubs, 'psql-calls.log');
    // initdb and pg_ctl succeed without starting anything; psql records its
    // target and fails, which ends the run at the first CREATE DATABASE.
    const stub = (name: string, body: string): void => {
      writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(stubs, name), 0o755);
    };
    stub('initdb', 'exit 0');
    stub('pg_ctl', 'exit 0');
    stub('psql', `printf '%s\\n' "PGHOST=\${PGHOST-<unset>}" >> '${calls}'; exit 1`);

    const run = runUnnamed(stubs);

    if (run.dir && existsSync(run.dir)) trackTempRoot(run.dir);
    expect(run.dir).toBeDefined();
    const targets = readFileSync(calls, 'utf8').trim().split('\n');
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set([`PGHOST=${run.dir}`]));
  },
  testTimeout(20_000)
);

/** The bin dir with initdb, pg_ctl and psql, found the way the script finds it. */
function serverBinDir(): string | undefined {
  const onPath = Bun.which('initdb');
  if (onPath && Bun.which('pg_ctl') && Bun.which('psql')) return dirname(onPath);
  const cfg = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (cfg.error || cfg.status !== 0) return undefined;
  const dir = cfg.stdout.trim();
  return ['initdb', 'pg_ctl', 'psql'].every(b => existsSync(join(dir, b))) ? dir : undefined;
}
const BIN_DIR = process.platform === 'win32' ? undefined : serverBinDir();

test.skipIf(BIN_DIR === undefined)(
  'the throwaway server is stopped and its directory removed when the script exits',
  () => {
    // Real psql, but only toward a throwaway socket dir: if the script ever
    // regresses to the default socket, this run must not reach the PostgreSQL
    // that answers there.
    const shims = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-schema-shim-')));
    writeFileSync(
      join(shims, 'psql'),
      `#!/bin/sh\ncase "\${PGHOST-}" in */archon-pg-*) exec '${join(BIN_DIR as string, 'psql')}' "$@";; esac\n` +
        'echo "refused: PGHOST is not a throwaway server" >&2; exit 1\n'
    );
    chmodSync(join(shims, 'psql'), 0o755);
    const run = runUnnamed(`${shims}${delimiter}${BIN_DIR}`);
    expect(run.dir).toBeDefined();
    const dir = run.dir as string;
    const pidFile = join(dir, 'data', 'postmaster.pid');
    const leaked = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n')[0] : undefined;
    // Never leave a server behind for the next test, even when this one fails.
    if (leaked) {
      spawnSync(
        join(BIN_DIR as string, 'pg_ctl'),
        ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'],
        {
          env: { ...process.env, LC_ALL: 'C' },
        }
      );
    }
    if (existsSync(dir)) trackTempRoot(dir);

    expect(run.status, run.out).toBe(0);
    expect(leaked).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  },
  testTimeout(60_000)
);
