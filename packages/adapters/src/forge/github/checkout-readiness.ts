import { access } from 'fs/promises';
import { join, resolve } from 'path';
import { findRepoRoot } from '@archon/git';
import { getProjectSourcePath, parseOwnerRepo } from '@archon/paths';

/**
 * Whether GitHub readiness uses `repoPath` as an existing checkout instead of cloning into it.
 * A project may be registered at a subdirectory of a checkout, so a present path without its
 * own `.git` is resolved by git discovery. A managed `source/` needs its own metadata: when
 * storage sits inside another checkout, discovery would adopt that checkout and skip a first or
 * retried clone. The managed source belongs to the webhook's `owner/repo` or, for a registration
 * whose name was allocated (`owner/repo-2`), to the registration's own name.
 *
 * The community adapters treat any nonempty directory as a checkout. GitHub uses discovery so
 * a directory holding only operator files still reaches the clone, which refuses it and
 * leaves the files in place.
 */
export async function isExistingCheckout(
  repoPath: string,
  owner: string,
  repo: string,
  projectName: string
): Promise<boolean> {
  if (await isPresent(join(repoPath, '.git'))) return true;
  const identities = [{ owner, repo }, parseOwnerRepo(projectName)];
  const isManagedSource = identities.some(
    identity =>
      identity && resolve(getProjectSourcePath(identity.owner, identity.repo)) === resolve(repoPath)
  );
  if (isManagedSource) return false;
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
