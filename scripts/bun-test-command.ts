import { DEFAULT_TEST_TIMEOUT_MS } from '@archon/paths/test-utils';

export function bunTestCommand(selectors: readonly string[]): string[] {
  return ['bun', 'test', '--timeout', String(DEFAULT_TEST_TIMEOUT_MS), ...selectors];
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
