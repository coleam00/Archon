import { getProjectStoragePaths, resolveProjectStorageKey } from '@archon/paths';
import { getWorktreeBase, toRepoPath } from '@archon/git';
import type { Codebase } from '../schemas/codebase';

/**
 * Storage and worktrees resolve identity separately: a repo inside Archon's
 * workspaces can derive its worktree owner/repo from the path. Both locations
 * must stay unchanged during a rename or in-place registration repair.
 */
export function getProjectLocations(
  project: Pick<Codebase, 'name' | 'kind' | 'default_cwd'>
): string[] {
  const storageRoot = getProjectStoragePaths(
    resolveProjectStorageKey(project, project.default_cwd)
  ).root;
  if (project.kind === 'folder') return [storageRoot];
  return [storageRoot, getWorktreeBase(toRepoPath(project.default_cwd), project.name).base];
}
