// `bun test` preload for the repo root and every package with tests (enforced by
// scripts/bun-test-command.test.ts). Bun reads bunfig.toml only from the cwd, so each
// of them registers this file itself.
import { afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths/archon-paths';
import { removeTempTree } from '@archon/paths/test-utils';

// Tests never send telemetry. A test that covers telemetry re-enables it in its own
// child env.
process.env.ARCHON_TELEMETRY_DISABLED ??= '1';

/**
 * The ARCHON_HOME every test process starts with, in place of the one it inherited.
 * A suite that points ARCHON_HOME at its own scratch directory restores this value in
 * its cleanup, so work still running after that cleanup (a timed-out test's, say) and
 * reopening the database lands here, never in the operator's real home (#3979).
 * Children a test spawns inherit it too, unless the test gives them a home of its own.
 * An inherited DATABASE_URL would send that reopen to the operator's PostgreSQL instead;
 * a test that needs PostgreSQL sets its own scratch URL.
 */
const testArchonHome = mkdtempSync(join(tmpdir(), 'archon-test-home-'));
process.env.ARCHON_HOME = testArchonHome;
process.env.DATABASE_URL = '';
// getArchonHome() lets Docker detection override ARCHON_HOME, which would point a test
// run inside the Archon container at the container's real /.archon.
process.env.ARCHON_DOCKER = '';
process.env.WORKSPACE_PATH = '';
// isDocker() owns the signal list; fail the process rather than run against a home
// it would override.
if (getArchonHome() !== testArchonHome) {
  throw new Error(
    `test preload: getArchonHome() resolves to ${getArchonHome()}, not the scratch home ${testArchonHome}`
  );
}

afterAll(async () => {
  await removeTempTree(testArchonHome);
});
