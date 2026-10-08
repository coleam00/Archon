import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function withPluginMutationLock<T>(
  pluginsDir: string,
  mutate: () => Promise<T>
): Promise<T> {
  await mkdir(pluginsDir, { recursive: true });
  const lock = join(pluginsDir, '.mutation-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Plugin mutation locked at ${lock}. Retry after the other plugin command finishes. If it was interrupted, remove this directory only after confirming that no plugin command is running.`
      );
    }
    throw error;
  }
  // Never reclaim by age: a slow download or handshake still owns the installation.
  try {
    return await mutate();
  } finally {
    await rmdir(lock);
  }
}
