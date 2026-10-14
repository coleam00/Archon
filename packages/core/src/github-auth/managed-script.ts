import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Atomically replace an Archon-managed executable script when its contents are
 * outdated. Returns true when the file was written.
 *
 * Windows cannot rename over a file another process holds open, and a running
 * script keeps itself open. Rewriting only outdated copies keeps routine setup
 * from failing while another run executes the current copy.
 */
export function installManagedScript(scriptPath: string, contents: string): boolean {
  if (isCurrent(scriptPath, contents)) return false;
  const dir = dirname(scriptPath);
  mkdirSync(dir, { recursive: true });
  const tempPath = resolve(dir, `${basename(scriptPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, contents, { flag: 'wx' });
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, scriptPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return true;
}

function isCurrent(scriptPath: string, contents: string): boolean {
  try {
    return readFileSync(scriptPath, 'utf8') === contents;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
