import { rename, rm } from 'node:fs/promises';

const HANDLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const ATTEMPTS = 100;
const DELAY_MS = 100;

/**
 * Windows refuses to rename or delete a file while another process holds a handle
 * that denies delete sharing, and reports it as EBUSY, EPERM or EACCES. A plugin
 * binary that was just written, or just run by the install probe, is held that way
 * for a moment after the probe has exited, typically by an antivirus scan. Both
 * callers touch only files this install created in its own plugins directory, so
 * those codes mean "held by someone else" on every platform; retrying them
 * unconditionally also keeps this path testable off Windows.
 */
async function whenUnlocked(
  operation: string,
  path: string,
  attempt: () => Promise<void>
): Promise<void> {
  for (let attempts = 1; ; attempts++) {
    try {
      await attempt();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !HANDLE_CODES.has(code)) throw error;
      if (attempts === ATTEMPTS) {
        throw new Error(
          `Could not ${operation} ${path}: still ${code} after ${ATTEMPTS} attempts over ${(ATTEMPTS * DELAY_MS) / 1000} s. Another process holds the file open; close it and retry.`,
          { cause: error }
        );
      }
      await Bun.sleep(DELAY_MS);
    }
  }
}

export function renameUnlocked(source: string, target: string): Promise<void> {
  return whenUnlocked('rename', source, () => rename(source, target));
}

export function removeUnlocked(path: string): Promise<void> {
  return whenUnlocked('remove', path, () => rm(path, { force: true }));
}
