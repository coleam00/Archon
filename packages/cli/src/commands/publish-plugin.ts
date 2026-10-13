import { randomBytes } from 'node:crypto';
import { copyFile, lstat, rename, rm } from 'node:fs/promises';
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
  const backups = new Map<string, string>();
  const published: string[] = [];
  const discardBackups = async (): Promise<void> => {
    for (const backup of backups.values()) {
      try {
        await rm(backup, { force: true });
      } catch {
        console.warn(`Plugin backup cleanup failed: ${backup}`);
      }
    }
  };
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
  } catch {
    await discardBackups();
    throw new Error(`Plugin could not back up installed files: ${receiptFile}`);
  }

  try {
    // Receipt first: the other order could strand a binary no receipt owns, which
    // every later install would refuse to replace.
    await rename(stagedReceipt, receiptFile);
    published.push(receiptFile);
    await renameUnlocked(stagedBinary, target);
    published.push(target);
    for (const path of previousFiles) {
      if (path !== target) await removeUnlocked(path);
    }
  } catch (error) {
    const recovery: string[] = [];
    for (const path of published) {
      if (backups.has(path)) continue;
      try {
        await removeUnlocked(path);
      } catch {
        recovery.push(path);
      }
    }
    for (const [path, backup] of backups) {
      try {
        await renameUnlocked(backup, path);
      } catch {
        recovery.push(`${path} (backup: ${backup})`);
      }
    }
    const reason = (error as Error).message;
    if (recovery.length) {
      throw new Error(
        `Plugin publication failed and rollback failed; recovery required: ${recovery.join(', ')}. ${reason}`,
        { cause: error }
      );
    }
    await discardBackups();
    throw new Error(
      `Plugin publication failed; previous install restored: ${receiptFile}. ${reason}`,
      { cause: error }
    );
  }
  // Publication has committed; leftover backups must not turn success into refusal.
  await discardBackups();
}
