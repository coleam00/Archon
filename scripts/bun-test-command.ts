import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';

/** One transpiler cache for every test process, whatever home a test gives its child. */
export const TEST_TRANSPILER_CACHE = join(
  import.meta.dir,
  '..',
  'node_modules',
  '.cache',
  'bun-transpiler'
);

export function bunTestCommand(selectors: readonly string[]): string[] {
  return ['bun', 'test', '--timeout', String(DEFAULT_TEST_TIMEOUT_MS), ...selectors];
}

const gitConfigFiles: string[] = [];
process.on('exit', () => {
  for (const file of gitConfigFiles) rmSync(file, { force: true });
});

/**
 * A global git config of its own for one test process. Git processes in tests read it, and
 * the product code under test writes it (`git config --global safe.directory`). Shared, it
 * is the operator's real ~/.gitconfig: on a Windows runner a reader that overlaps a writer
 * in a parallel suite fails with "unable to access ... Permission denied" (#2924). It has
 * to be in the environment the test process starts with: on Windows, Bun.spawn children
 * do not inherit a variable the process set after startup, so a preload cannot provide it.
 */
function privateGitConfig(): string {
  const file = join(tmpdir(), `archon-test-gitconfig-${process.pid}-${gitConfigFiles.length}`);
  gitConfigFiles.push(file);
  return file;
}

/**
 * Environment for a `bun test` process. Tests never send telemetry: a test that
 * starts a real CLI or engine with a temp `ARCHON_HOME` would otherwise mint a
 * fresh install id per run and report it as a real install. A test that covers
 * telemetry itself re-enables it by setting the variable in its own child env.
 *
 * Bun keeps its runtime transpiler cache under the home directory (`USERPROFILE` on
 * Windows, `HOME` elsewhere), so a test that gives its child a scratch home would start
 * that child cold and have it write a fresh cache into the scratch home. On windows-latest
 * that is measurably slower per spawn and adds small-file writes to the OS disk that
 * already saturates under the parallel suite (#3294). Pinning the path keeps every such
 * child warm; a caller's own setting wins.
 */
export function bunTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_CONFIG_GLOBAL: privateGitConfig(),
    ARCHON_TELEMETRY_DISABLED: env.ARCHON_TELEMETRY_DISABLED ?? '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH:
      env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? TEST_TRANSPILER_CACHE,
  };
}
