/**
 * Shared test-path predicate used by both archie-pretooluse-no-tests.ts
 * (dev cage) and archie-pretooluse-tests-only.ts (test-repair cage).
 *
 * Keeping this in one place ensures the two cages can never disagree about
 * what counts as a test file. If the test-path convention changes, update
 * here and both cages pick it up.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEST_PATH_RE =
  /(^|\/)(tests?|e2e|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$|(^|\/)(vitest|playwright|jest|cypress)\.config\./;

export function isTestPath(p: string, hookCwd: string): boolean {
  if (!p) return false;
  let resolved: string;
  try {
    resolved = realpathSync(resolve(hookCwd, p));
  } catch {
    resolved = resolve(hookCwd, p);
  }
  return TEST_PATH_RE.test(resolved);
}
