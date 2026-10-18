import { access } from 'fs/promises';
import { join, resolve } from 'path';
import { findRepoRoot } from '@archon/git';
import { getProjectSourcePath } from '@archon/paths';

/**
 * Whether GitHub readiness uses `repoPath` as an existing checkout instead of cloning into it.
 * A project may be registered at a subdirectory of a checkout, so a present path without its
 * own `.git` is resolved by git discovery. The managed `source/` of `owner/repo` needs its own
 * metadata: when storage sits inside another checkout, discovery would adopt that checkout and
 * skip a first or retried clone.
 *
 * The community adapters treat any nonempty directory as a checkout. GitHub uses discovery so
 * a directory holding only operator files still reaches the clone, which refuses it and
 * leaves the files in place.
 */
export async function isExistingCheckout(
  repoPath: string,
  owner: string,
  repo: string
): Promise<boolean> {
  if (await isPresent(join(repoPath, '.git'))) return true;
  if (resolve(getProjectSourcePath(owner, repo)) === resolve(repoPath)) return false;
  return (await isPresent(repoPath)) && (await findRepoRoot(repoPath)) !== null;
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    throw new Error(
      `Cannot access repository at ${path}: ${err.code ?? err.message}. ` +
        'Check permissions and disk health.',
      { cause: error }
    );
  }
}
