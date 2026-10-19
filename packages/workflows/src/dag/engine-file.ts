import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';

/**
 * Reject existing parent symlinks and replace leaf links without truncating their targets.
 * These pathname checks do not prevent concurrent parent replacement: the artifact
 * mount is writable by container nodes, including its engine directory.
 */
export function writeEngineFile(artifactsDir: string, path: string, value: string): string {
  const root = resolve(artifactsDir);
  const target = resolve(root, RUN_ARTIFACTS_ENGINE_SUBDIR, path);
  const child = relative(root, target);
  if (!child.startsWith(`${RUN_ARTIFACTS_ENGINE_SUBDIR}${sep}`)) {
    throw new Error(`Engine file escapes run artifacts: ${target}`);
  }
  mkdirSync(dirname(root), { recursive: true });
  let dir = root;
  for (const component of ['', ...relative(root, dirname(target)).split(sep)]) {
    dir = join(dir, component);
    try {
      mkdirSync(dir);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (!lstatSync(dir).isDirectory()) {
      throw new Error(`Engine file parent is not a directory: ${dir}`);
    }
  }
  // Exclusive staging and rename never truncate a pre-existing symlink or hard link.
  const staging = join(dir, `.write-${randomUUID()}`);
  try {
    writeFileSync(staging, value, { flag: 'wx' });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
  return target;
}
