import { afterAll, afterEach, beforeEach, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase, getSqliteDbPath } from '@archon/core/db/connection';
import { getArchonHome } from '@archon/paths/archon-paths';
import { removeTempTree } from '@archon/paths/test-utils';

// The per-test home shape suites use: a scratch ARCHON_HOME in beforeEach, then close
// the database and restore the process's home in afterEach. Work the test started keeps
// running past that cleanup, the way it does when the test times out.
const processHome = process.env.ARCHON_HOME;
let testHome = '';
const cleanedUp = Promise.withResolvers<void>();
let lateWork: Promise<void> = Promise.resolve();

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'archon-late-reopen-'));
  process.env.ARCHON_HOME = testHome;
});

afterEach(async () => {
  await closeDatabase();
  process.env.ARCHON_HOME = processHome;
  await removeTempTree(testHome);
  cleanedUp.resolve();
});

afterAll(async () => {
  await lateWork;
  await closeDatabase();
});

test('leaves work running past its cleanup', () => {
  lateWork = (async (): Promise<void> => {
    await cleanedUp.promise;
    console.log(
      JSON.stringify({
        lateDbPath: getSqliteDbPath(),
        lateDbUrl: process.env.DATABASE_URL,
        lateHome: getArchonHome(),
        lateEnvHome: process.env.ARCHON_HOME,
      })
    );
    await getDatabase().query('SELECT 1');
  })();
});
