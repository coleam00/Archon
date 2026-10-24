/**
 * Temp-tree teardown for pack tests.
 *
 * The pack does not import engine code, so it owns this helper instead of using
 * `@archon/paths/test-utils`. The two are independent: change either without the other.
 */
import { afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';

/**
 * Codes meaning "something still holds this tree". Bun reports any OS error it cannot map
 * as `EFAULT`, which is how an ordinary lock arrives on Windows, so it is retried too.
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM', 'EFAULT']);
const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 50;

/**
 * Remove a test temp tree, retrying while the OS still holds a handle inside it. The retry is
 * written out because Bun accepts `rm`'s `maxRetries` and ignores it. A tree that never comes
 * free warns instead of throwing: a leaked scratch directory is not a test failure.
 */
export async function removeTempTree(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_ATTEMPTS || code === undefined || !TRANSIENT_CODES.has(code)) {
        console.warn(`temp cleanup failed for ${path}: ${String(error)}`);
        return;
      }
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Register an `afterEach` that removes every root passed through the returned function.
 * Call once at module scope and route every fixture root through it as it is created.
 */
export function trackTempRoots(): (root: string) => string {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await removeTempTree(root);
  });
  return root => {
    roots.push(root);
    return root;
  };
}
