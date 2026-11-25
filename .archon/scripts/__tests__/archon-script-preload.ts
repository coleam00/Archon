/**
 * `bun test` preload that gives pack tests the `archon:script` module.
 *
 * A pack script imports its host API by that name, and only a host provides it. The
 * tests ask the host named by `ARCHON_CLI_COMMAND` for the preload file it passes to a
 * script node (`archon script preload`), load it into this process for the pack modules
 * a test imports, and name it in `ARCHON_SCRIPT_PRELOAD` for the scripts a test starts.
 *
 * `scripts/repo-tests.ts` passes this file to root-owned runs. Loaded without a host
 * command it registers nothing that works: importing the module then fails with the
 * reason, and nothing fails before that.
 */
import { afterAll } from 'bun:test';
import { plugin } from 'bun';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from './temp-roots';

const command = process.env.ARCHON_CLI_COMMAND;
if (!command) {
  plugin({
    name: 'archon-script-unavailable',
    setup(build) {
      build.module('archon:script', () => {
        throw new Error('pack tests run the Archon CLI named by ARCHON_CLI_COMMAND; run them with `bun run test`');
      });
    },
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), 'archon-script-preload-'));
  const file = join(directory, 'archon-script.preload.ts');
  const [executable, ...args] = JSON.parse(command) as string[];
  const written = spawnSync(executable as string, [...args, 'script', 'preload', '--out', file], { encoding: 'utf8' });
  if (written.status !== 0) {
    throw new Error(`archon script preload failed (exit ${String(written.status)}): ${written.stderr}`);
  }
  process.env.ARCHON_SCRIPT_PRELOAD = file;
  await import(file);

  afterAll(async () => {
    await removeTempTree(directory);
  });
}
