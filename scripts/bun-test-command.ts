import { WINDOWS_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';

/**
 * The one place a `bun test` invocation is assembled, so the per-test budget has one owner.
 * On Windows the default budget is `WINDOWS_TEST_TIMEOUT_MS` instead of Bun's 5 s; its
 * comment carries the attribution. A test with its own explicit budget keeps it, so explicit
 * budgets at or below the floor go through `testTimeout`.
 */
export function bunTestCommand(
  selectors: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const budget = platform === 'win32' ? ['--timeout', String(WINDOWS_TEST_TIMEOUT_MS)] : [];
  return ['bun', 'test', ...budget, ...selectors];
}

/**
 * Environment for a `bun test` process. Tests never send telemetry: a test that
 * starts a real CLI or engine with a temp `ARCHON_HOME` would otherwise mint a
 * fresh install id per run and report it as a real install. A test that covers
 * telemetry itself re-enables it by setting the variable in its own child env.
 */
export function bunTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ARCHON_TELEMETRY_DISABLED: env.ARCHON_TELEMETRY_DISABLED ?? '1' };
}
