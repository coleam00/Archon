import { lstat } from 'node:fs/promises';

/**
 * False only when nothing exists at `path`; any other lstat failure propagates, so an
 * unreadable checkout still fails the caller. Its own module so the cleanup unit tests
 * can mock it without mocking `node:fs/promises`, which other cleanup jobs read for real.
 */
export async function checkoutExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
