import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Places one trigger file in `directory` under its own name and returns where it went.
 *
 * Every process that completes a run reads each `*.json` in the triggers directory, and a
 * file that is not complete JSON fails that run. So the file is copied under a `.tmp` name,
 * which the loader skips, and renamed into place within the directory: a completing run sees
 * the old file or the whole new one, never part of one. Each add stages its own `.tmp` file,
 * so overlapping adds of one name never rename a copy another add is still writing. The file's contents are left to the
 * loader and `archon trigger check`.
 */
export async function addTriggerFile(file: string, directory: string): Promise<string> {
  const name = basename(file);
  if (!name.endsWith('.json'))
    throw new Error(
      `${file} does not end in .json; the engine reads only trigger files that do, so it would never apply.`
    );
  await mkdir(directory, { recursive: true });
  const placed = join(directory, name);
  const partial = `${placed}.${randomUUID()}.tmp`;
  try {
    await copyFile(file, partial);
    await rename(partial, placed);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return placed;
}
