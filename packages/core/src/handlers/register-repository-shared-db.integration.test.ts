/**
 * Integration test: `registerRepository` never repoints a same-named managed
 * codebase row onto a separate local clone (#3403) — against a REAL bun:sqlite
 * database, real git checkouts, and the real project-structure helpers.
 *
 * Two hosts sharing one database can hold the byte-identical managed path: every
 * Docker host resolves the Archon home to `/.archon`. Here both "hosts" share one
 * ARCHON_HOME, so the other host's row names a managed path this host resolves
 * too. Whatever exists at that path here, it is not proof that this host owns the
 * row, so registration must refuse rather than rewrite it.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ../db/connection with a real adapter, which conflicts with the fakes other
 * files in this package install.
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { quoteCommandArg } from '../utils/command-args';

const { SqliteAdapter, sqliteDialect } = await import('../db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('../db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { registerRepository } = await import('./clone');
const { createCodebase, getCodebase } = await import('../db/codebases');
const { getProjectSourcePath } = await import('@archon/paths');

const trackTempRoot = trackTempRoots();
const initialArchonHome = process.env.ARCHON_HOME;
afterEach(() => {
  if (initialArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = initialArchonHome;
});

async function gitCheckout(path: string, remote: string): Promise<void> {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['-C', path, 'init', '-q']);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
}

interface Fixture {
  name: string;
  remote: string;
  rowId: string;
  managed: string;
  local: string;
}

/**
 * An ARCHON_HOME, a row the other host registered at this home's managed source
 * path, and a separate local clone of the same repository on this host. Each
 * test names its own repo: the
 * in-memory database outlives a test, and the lookup under test is by name.
 */
async function sharedDatabaseFixture(repo: string): Promise<Fixture> {
  const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-shared-db-'))));
  process.env.ARCHON_HOME = join(root, '.archon');
  const name = `owner/${repo}`;
  const remote = `https://github.com/${name}`;
  const managed = getProjectSourcePath('owner', repo);
  const row = await createCodebase({
    name,
    repository_url: remote,
    default_cwd: managed,
    ai_assistant_type: 'claude',
  });
  const local = join(root, 'local', repo);
  await gitCheckout(local, remote);
  return { name, remote, rowId: row.id, managed, local };
}

async function expectRefusedAndUnchanged(fixture: Fixture): Promise<void> {
  const error = await registerRepository(fixture.local).then(
    () => undefined,
    (err: unknown) => err as Error
  );
  expect((await getCodebase(fixture.rowId))?.default_cwd).toBe(fixture.managed);
  expect(error?.message).toContain(fixture.managed);
  expect(error?.message).toContain(
    `/update-project ${quoteCommandArg(fixture.name)} ${quoteCommandArg(fixture.local)}`
  );
}

describe('registerRepository with a row another host registered', () => {
  test('refuses when this host has nothing at the managed path, and creates nothing', async () => {
    const fixture = await sharedDatabaseFixture('unlinked');
    await expectRefusedAndUnchanged(fixture);
    // A refusal leaves no project tree and no `source` link behind: a link at the
    // managed path would make it look populated to every later check.
    expect(existsSync(dirname(fixture.managed))).toBe(false);
  });

  test('refuses when this host holds its own clone at the same managed path', async () => {
    const fixture = await sharedDatabaseFixture('cloned');
    // This host auto-cloned the project earlier: a real, different checkout at
    // the byte-identical path string the other host's row names.
    await gitCheckout(fixture.managed, fixture.remote);
    await expectRefusedAndUnchanged(fixture);
    expect(await readdir(dirname(fixture.managed))).toEqual(['source']);
  });

  test('refuses without touching an operator-created directory at the managed path', async () => {
    const fixture = await sharedDatabaseFixture('precreated');
    await mkdir(fixture.managed, { recursive: true });
    await expectRefusedAndUnchanged(fixture);
    // Still the operator's own empty directory, not a link to the local clone.
    expect((await lstat(fixture.managed)).isSymbolicLink()).toBe(false);
    expect(await readdir(fixture.managed)).toEqual([]);
    expect(await readdir(dirname(fixture.managed))).toEqual(['source']);
  });
});
