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
  listCodebaseClaims: () => Promise<readonly Codebase[]>;
  getCanonicalRepoPath: (path: string) => Promise<string>;
  getGitCheckoutIdentity: (path: string) => Promise<GitCheckoutIdentity>;
}

type CheckoutLookupDeps = Pick<
  CodebaseCheckoutResolverDeps,
  'findCodebaseByDefaultCwd' | 'listCodebaseClaims'
> &
  Partial<Pick<CodebaseCheckoutResolverDeps, 'getCanonicalRepoPath' | 'getGitCheckoutIdentity'>>;

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
  deps: CheckoutLookupDeps
): Promise<Codebase | null> {
  cwd = await canonicalizeProjectPath(cwd);
  const exact = await deps.findCodebaseByDefaultCwd(cwd);
  if (exact) return exact;
  const primary = await findPrimaryCheckoutCodebase(cwd, deps);
  if (primary !== undefined) return primary;
  return findCodebaseByCommonGitDir(cwd, deps);
}

/**
 * The repository codebase registered at the checkout's primary path, or null when there
 * is none. Undefined when Git cannot name a primary path (`--separate-git-dir`).
 */
async function findPrimaryCheckoutCodebase(
  cwd: string,
  deps: CheckoutLookupDeps
): Promise<Codebase | null | undefined> {
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
    return undefined;
  }
}

/** The one registered repository checkout that shares the checkout's Git common directory. */
async function findCodebaseByCommonGitDir(
  cwd: string,
  deps: CheckoutLookupDeps
): Promise<Codebase | null> {
  const readIdentity = deps.getGitCheckoutIdentity ?? getGitCheckoutIdentity;
  const checkoutIdentity = await readIdentity(cwd);
  const matches: Codebase[] = [];
  for (const codebase of await deps.listCodebaseClaims()) {
    if (await sharesCommonGitDir(codebase, checkoutIdentity, readIdentity)) matches.push(codebase);
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

async function sharesCommonGitDir(
  codebase: Codebase,
  checkoutIdentity: GitCheckoutIdentity,
  readIdentity: (path: string) => Promise<GitCheckoutIdentity>
): Promise<boolean> {
  // A relative stored path would resolve against this process's directory.
  if (codebase.kind === 'folder' || !isAbsolute(codebase.default_cwd)) return false;
  try {
    const registeredIdentity = await readIdentity(codebase.default_cwd);
    return resolve(registeredIdentity.commonGitDir) === resolve(checkoutIdentity.commonGitDir);
  } catch {
    // A stale registered path cannot own the live checkout identity.
    return false;
  }
}

export async function resolveCodebaseForPath(
  cwd: string,
  deps: CheckoutLookupDeps & {
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
