import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Short commit of the git checkout containing `startDir`, read from git's
 * on-disk metadata without spawning `git` (this runs on every CLI start).
 * Handles plain checkouts, linked worktrees (`.git` file + `commondir`),
 * detached HEAD and packed refs. Returns undefined when there is no checkout
 * or anything is unreadable.
 */
export function readSourceCommit(startDir: string): string | undefined {
  try {
    const dotGit = findDotGit(startDir);
    if (!dotGit) return undefined;
    const gitDir = statSync(dotGit).isFile() ? readGitDirPointer(dotGit) : dotGit;
    if (!gitDir) return undefined;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref) return shortSha(head);
    const commonDirFile = join(gitDir, 'commondir');
    const commonDir = existsSync(commonDirFile)
      ? resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim())
      : gitDir;
    for (const dir of [gitDir, commonDir]) {
      const refFile = join(dir, ref);
      if (existsSync(refFile)) return shortSha(readFileSync(refFile, 'utf8').trim());
    }
    const packedRefs = join(commonDir, 'packed-refs');
    if (!existsSync(packedRefs)) return undefined;
    for (const line of readFileSync(packedRefs, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha) return shortSha(sha);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function findDotGit(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.git');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readGitDirPointer(dotGitFile: string): string | undefined {
  const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitFile, 'utf8'))?.[1]?.trim();
  return target ? resolve(dirname(dotGitFile), target) : undefined;
}

function shortSha(value: string): string | undefined {
  return FULL_SHA.test(value) ? value.slice(0, 7) : undefined;
}
