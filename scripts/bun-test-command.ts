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
    ARCHON_TELEMETRY_DISABLED: env.ARCHON_TELEMETRY_DISABLED ?? '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH:
      env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? TEST_TRANSPILER_CACHE,
  };
}
