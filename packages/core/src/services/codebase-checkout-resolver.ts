import type { Codebase } from '../types';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import {
  findRepoRoot,
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
 * Resolve a registered codebase named explicitly by id, then by name (`owner/repo` for
 * a repository). A name two codebases share is refused rather than guessed. Returns null
 * when nothing matches, so each caller can say what else the spec may name.
 */
export async function findRegisteredCodebase(
  codebases: Pick<CodebaseCheckoutResolverDeps, 'listCodebases'>,
  spec: string
): Promise<Codebase | null> {
  const all = await codebases.listCodebases();
  const byId = all.find(codebase => codebase.id === spec);
  if (byId) return byId;
  const byName = all.filter(codebase => codebase.name === spec);
  if (byName.length > 1)
    throw new Error(
      `Project name '${spec}' matches ${String(byName.length)} codebases (${byName
        .map(codebase => codebase.id)
        .join(', ')}). Name one by id.`
    );
  return byName[0] ?? null;
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
    const primary = await deps.findCodebaseByDefaultCwd(
      await canonicalizeProjectPath(canonicalCwd)
    );
    return primary?.kind === 'repo' ? primary : null;
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

export async function resolveCodebaseForPath(
  cwd: string,
  deps: Pick<CodebaseCheckoutResolverDeps, 'findCodebaseByDefaultCwd' | 'listCodebases'> & {
    findCodebaseByPathPrefix: (cwd: string) => Promise<Codebase | null>;
  }
): Promise<{ codebase: Codebase | null; repoRoot: string | null }> {
  cwd = await canonicalizeProjectPath(cwd);
  const exact = await deps.findCodebaseByDefaultCwd(cwd);
  if (exact?.kind === 'folder') return { codebase: exact, repoRoot: null };
  // Repository roots always come from Git: runs record this string as their working
  // path, and on Windows it differs from the canonical `default_cwd` (separators,
  // 8.3 short names), so returning `cwd` would hide runs from `--resume`.
  const repoRoot = await findRepoRoot(cwd);
  if (exact) return { codebase: exact, repoRoot };
  const parent = await deps.findCodebaseByPathPrefix(cwd);
  if (parent?.kind === 'folder') {
    const insideFolder = repoRoot ? relative(parent.default_cwd, repoRoot) : null;
    // A nested repository owns its checkout; an enclosing repository cannot
    // override a folder the operator explicitly registered inside it.
    if (
      insideFolder === null ||
      insideFolder === '..' ||
      insideFolder.startsWith(`..${sep}`) ||
      isAbsolute(insideFolder) ||
      insideFolder === ''
    ) {
      return { codebase: parent, repoRoot: null };
    }
  }
  return {
    codebase: repoRoot ? await findCodebaseForCheckoutPath(repoRoot, deps) : parent,
    repoRoot,
  };
}
