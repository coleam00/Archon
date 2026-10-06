import type { Codebase } from '../types';
import { resolve } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import {
  CanonicalRepoPathUnavailableError,
  getCanonicalRepoPath,
  getGitCheckoutIdentity,
  type GitCheckoutIdentity,
} from '@archon/git';

export interface CodebaseCheckoutResolverDeps {
  findCodebaseByDefaultCwd: (cwd: string) => Promise<Codebase | null>;
  listCodebases: () => Promise<readonly Codebase[]>;
  getCanonicalRepoPath: (path: string) => Promise<string>;
  getGitCheckoutIdentity: (path: string) => Promise<GitCheckoutIdentity>;
}

/**
 * Resolve a checkout to an existing codebase without remote or branch inference.
 *
 * Exact registration wins. Normal linked worktrees then use their Git-proven
 * primary checkout. A linked worktree backed by `--separate-git-dir` has no
 * reverse primary-path pointer, so the final tier matches Git's exact common
 * directory against registered repository checkouts and rejects ambiguity.
 */
export async function findCodebaseForCheckoutPath(
  cwd: string,
  deps: Pick<CodebaseCheckoutResolverDeps, 'findCodebaseByDefaultCwd' | 'listCodebases'> &
    Partial<Pick<CodebaseCheckoutResolverDeps, 'getCanonicalRepoPath' | 'getGitCheckoutIdentity'>>
): Promise<Codebase | null> {
  cwd = await canonicalizeProjectPath(cwd);
  const exact = await deps.findCodebaseByDefaultCwd(cwd);
  if (exact) return exact;

  try {
    const canonicalCwd = await (deps.getCanonicalRepoPath ?? getCanonicalRepoPath)(cwd);
    if (canonicalCwd === cwd) return null;
    // The primary path comes from `git worktree list` (forward slashes on
    // Windows); `default_cwd` is stored in canonical form.
    return await deps.findCodebaseByDefaultCwd(await canonicalizeProjectPath(canonicalCwd));
  } catch (error) {
    if (!(error instanceof CanonicalRepoPathUnavailableError)) throw error;
  }

  const checkoutIdentity = await (deps.getGitCheckoutIdentity ?? getGitCheckoutIdentity)(cwd);
  const matches: Codebase[] = [];
  for (const codebase of await deps.listCodebases()) {
    if (codebase.kind === 'folder') continue;
    try {
      const registeredIdentity = await (deps.getGitCheckoutIdentity ?? getGitCheckoutIdentity)(
        codebase.default_cwd
      );
      if (resolve(registeredIdentity.commonGitDir) === resolve(checkoutIdentity.commonGitDir)) {
        matches.push(codebase);
      }
    } catch {
      // A stale registered path cannot own the live checkout identity.
    }
  }

  if (matches.length > 1) {
    const paths = matches.map(codebase => codebase.default_cwd).join(', ');
    throw new Error(
      `Checkout ${cwd} matches multiple registered codebases through Git directory ` +
        `${checkoutIdentity.commonGitDir}: ${paths}. Register this exact checkout or remove the ambiguity.`
    );
  }
  return matches[0] ?? null;
}
