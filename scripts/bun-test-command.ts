/**
 * The one place a `bun test` invocation is assembled, so the per-test budget has one owner.
 *
 * On Windows the budget is 20 s instead of Bun's 5 s default. This is an attributed
 * runner-floor residual, not headroom for slow tests: on the 4-vCPU `windows-latest` VM the
 * suite's several hundred child processes periodically saturate the CPUs and the OS disk
 * (sometimes together with Windows' own background maintenance), and any spawn issued in
 * such a second can take 5 to 15 s regardless of which test issued it. Fifty instrumented
 * runs found no per-test, per-package, disk-layout or service-level change that removes
 * the class; the attribution is on coleam00/Archon#3294. A test with its own explicit
 * budget keeps it: `--timeout` only sets the default.
 */
export const WINDOWS_TEST_TIMEOUT_MS = 20_000;

export function bunTestCommand(
  selectors: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const budget = platform === 'win32' ? ['--timeout', String(WINDOWS_TEST_TIMEOUT_MS)] : [];
  return ['bun', 'test', ...budget, ...selectors];
}
