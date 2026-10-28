import { randomBytes } from 'node:crypto';
import { copyFile, lstat, rename } from 'node:fs/promises';
import { removeUnlocked, renameUnlocked } from './unlocked-file';

interface Publication {
  stagedReceipt: string;
  receiptFile: string;
  stagedBinary: string;
  target: string;
  previousFiles: readonly string[];
}

/**
 * Moves a staged plugin binary and its receipt into place, then removes the files the
 * previous receipt owned. Any failure restores the previous install from backups taken
 * up front, so the receipt never names a binary that is not there.
 */
export async function publishPlugin(publication: Publication): Promise<void> {
  const { stagedReceipt, receiptFile, stagedBinary, target, previousFiles } = publication;
  const backups = await backupInstalledFiles(receiptFile, previousFiles);
  // Paths this publication has replaced, created or removed, in order. A step that
  // throws leaves its path untouched, so rollback restores exactly these.
  const changed: string[] = [];

  try {
    // Receipt first: the other order could strand a binary no receipt owns, which
    // every later install would refuse to replace.
    await rename(stagedReceipt, receiptFile);
    changed.push(receiptFile);
    await renameUnlocked(stagedBinary, target);
    changed.push(target);
    for (const path of previousFiles) {
      if (path === target) continue;
      await removeUnlocked(path);
      changed.push(path);
    }
  } catch (error) {
    const recovery = await restoreChangedFiles(changed, backups);
    // An untouched file needs no restore, so its backup is only discarded. Renaming it
    // back would race the same lock that may have failed the publication.
    const leftovers = await discardBackups(
      backups,
      [...backups.keys()].filter(p => !changed.includes(p))
    );
    const reason = (error as Error).message;
    if (recovery.length) {
      throw new Error(
        `Plugin publication failed and rollback failed; recovery required: ${recovery.join(', ')}. ${reason}${leftoverNote(leftovers)}`,
        { cause: error }
      );
    }
    throw new Error(
      `Plugin publication failed; previous install restored: ${receiptFile}. ${reason}${leftoverNote(leftovers)}`,
      { cause: error }
    );
  }
  // Publication has committed; leftover backups must not turn success into refusal.
  for (const leftover of await discardBackups(backups, backups.keys())) {
    console.warn(`Plugin backup cleanup failed: ${leftover}`);
  }
}

async function backupInstalledFiles(
  receiptFile: string,
  previousFiles: readonly string[]
): Promise<Map<string, string>> {
  const backups = new Map<string, string>();
  try {
    for (const path of new Set([receiptFile, ...previousFiles])) {
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const backup = `${path}.${randomBytes(6).toString('hex')}.partial`;
      backups.set(path, backup);
      await copyFile(path, backup);
    }
  } catch (error) {
    const leftovers = await discardBackups(backups, backups.keys());
    throw new Error(
      `Plugin could not back up installed files: ${receiptFile}. ${(error as Error).message}${leftoverNote(leftovers)}`,
      { cause: error }
    );
  }

  return backups;
}

async function restoreChangedFiles(
  changed: readonly string[],
  backups: ReadonlyMap<string, string>
): Promise<string[]> {
  const recovery: string[] = [];
  for (const path of changed) {
    const backup = backups.get(path);
    try {
      if (backup === undefined) await removeUnlocked(path);
      else await renameUnlocked(backup, path);
    } catch {
      recovery.push(backup === undefined ? path : `${path} (backup: ${backup})`);
    }
  }
  return recovery;
}

/** Removes the backups of `paths` and returns a description of each one left behind. */
async function discardBackups(
  backups: ReadonlyMap<string, string>,
  paths: Iterable<string>
): Promise<string[]> {
  const leftovers: string[] = [];
  for (const path of paths) {
    const backup = backups.get(path);
    if (backup === undefined) continue;
    try {
      await removeUnlocked(backup);
    } catch (error) {
      leftovers.push(`${backup} (${(error as Error).message})`);
    }
  }
  return leftovers;
}

const leftoverNote = (leftovers: string[]): string =>
  leftovers.length ? ` Remove leftover backups: ${leftovers.join(', ')}.` : '';
