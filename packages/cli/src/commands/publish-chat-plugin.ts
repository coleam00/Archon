import { randomBytes } from 'node:crypto';
import { copyFile, lstat, rename, rm } from 'node:fs/promises';

interface Publication {
  stagedReceipt: string;
  receiptFile: string;
  stagedBinary: string;
  target: string;
  previousFiles: readonly string[];
}

export async function publishChatPlugin(publication: Publication): Promise<void> {
  const { stagedReceipt, receiptFile, stagedBinary, target, previousFiles } = publication;
  const backups = new Map<string, string>();
  const published: string[] = [];
  const discardBackups = async (): Promise<void> => {
    for (const backup of backups.values()) {
      try {
        await rm(backup, { force: true });
      } catch {
        console.warn(`Chat plugin backup cleanup failed: ${backup}`);
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
    throw new Error(`Chat plugin could not back up installed files: ${receiptFile}`);
  }

  try {
    // Receipt first keeps ownership visible throughout the publication window.
    await rename(stagedReceipt, receiptFile);
    published.push(receiptFile);
    await rename(stagedBinary, target);
    published.push(target);
    for (const path of previousFiles) {
      if (path !== target) await rm(path, { force: true });
    }
  } catch {
    const recovery: string[] = [];
    for (const path of published) {
      if (backups.has(path)) continue;
      try {
        await rm(path, { force: true });
      } catch {
        recovery.push(path);
      }
    }
    for (const [path, backup] of backups) {
      try {
        await rename(backup, path);
      } catch {
        recovery.push(`${path} (backup: ${backup})`);
      }
    }
    if (recovery.length) {
      throw new Error(`Chat plugin rollback failed; recovery required: ${recovery.join(', ')}`);
    }
    await discardBackups();
    throw new Error(`Chat plugin publication failed; previous install restored: ${receiptFile}`);
  }
  // Publication has committed; leftover backups must not turn success into refusal.
  await discardBackups();
}
