import { isAbsolute, join, normalize as normalizePath, resolve } from 'path';

import { getWorktreeBase } from '@archon/git';
import type { RepoPath, WorktreeBaseOverride } from '@archon/git';
import { isPathInside } from '@archon/paths';
import type { IsolationRequest, WorktreeCreateConfig } from '../../types';

/**
 * Validate a user-supplied `worktree.path` from `.archon/config.yaml` and return
 * it as a safe relative path for `getWorktreeBase()`, or `undefined` to fall
 * through to default path resolution.
 *
 * Rules (Fail Fast — malformed values throw; empty/whitespace values are ignored):
 * - `undefined` / empty-after-trim → `undefined` (no override; default resolution applies)
 * - Absolute path                  → throw (override must stay within the repo)
 * - Contains `..` segment          → throw (escapes repo root)
 * - Resolved path escapes repoRoot → throw (covers symlink / nested `../` edge cases)
 *
 * The path is returned trimmed. The caller composes it via `join(repoRoot, result)`.
 */
export function resolveRepoLocalOverride(
  rawPath: string | undefined,
  repoRoot: string
): string | undefined {
  if (rawPath === undefined) return undefined;
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;

  if (isAbsolute(trimmed)) {
    throw new Error(
      `.archon/config.yaml worktree.path must be relative to the repo root (got absolute: ${trimmed}). ` +
        "Use a path relative to the repo root, or omit worktree.path to use Archon's default location."
    );
  }

  const normalized = normalizePath(trimmed);
  // A plain `..` or anything that starts with `../` or contains `/../` escapes the repo.
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('..\\') ||
    normalized.includes('/../') ||
    normalized.includes('\\..\\')
  ) {
    throw new Error(
      `.archon/config.yaml worktree.path must stay within the repo (got: ${trimmed}). ` +
        'Remove any `..` segments.'
    );
  }

  // Double-check via resolved absolute paths — catches edge cases like a path that
  // normalizes clean but still escapes when joined (e.g. leading `./../` on some platforms).
  const resolved = resolve(repoRoot, normalized);
  if (!isPathInside(resolve(repoRoot), resolved, { includeRoot: true, lexical: true })) {
    throw new Error(
      `.archon/config.yaml worktree.path resolves outside the repo root (got: ${trimmed} → ${resolved}).`
    );
  }

  return normalized;
}

/**
 * The directory a repository's worktrees live in, honoring the per-repo override.
 *
 * Layouts (see `getWorktreeBase()` in `@archon/git` for resolution):
 *   - `repo-local`       → `<repoRoot>/<config.path>`              (opt-in)
 *   - `workspace-scoped` → `~/.archon/workspaces/{owner}/{repo}/worktrees`  (default)
 *
 * In both layouts the base already carries full repo context, so a caller
 * appends only the branch name. Unsafe `config.path` values throw (see
 * `resolveRepoLocalOverride()`) rather than falling back to the default layout.
 */
export function worktreeBaseFor(
  repoPath: RepoPath,
  codebaseName: string | undefined,
  config?: WorktreeCreateConfig | null
): string {
  const override: WorktreeBaseOverride = {
    repoLocal: resolveRepoLocalOverride(config?.path, repoPath),
  };
  return getWorktreeBase(repoPath, codebaseName, override).base;
}

/** The checkout path for a request's branch: `<worktree base>/<branch>`. */
export function worktreePathFor(
  request: IsolationRequest,
  branchName: string,
  config?: WorktreeCreateConfig | null
): string {
  return join(worktreeBaseFor(request.canonicalRepoPath, request.codebaseName, config), branchName);
}
