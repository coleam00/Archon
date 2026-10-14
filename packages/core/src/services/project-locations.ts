import { getProjectStoragePaths, resolveProjectStorageKey } from '@archon/paths';
import { getWorktreeBase, toRepoPath } from '@archon/git';
import { resolveRepoLocalOverride } from '@archon/isolation';
import { resolve } from 'node:path';
import { loadRepoConfig } from '../config/config-loader';
import type { Codebase } from '../schemas/codebase';

/**
 * Storage and worktrees resolve identity separately: a repo inside Archon's
 * workspaces can derive its worktree owner/repo from the path. Both locations
 * must stay unchanged during a rename or in-place registration repair.
 */
export async function getProjectLocations(
  project: Pick<Codebase, 'name' | 'kind' | 'default_cwd'>
): Promise<string[]> {
  const storageRoot = getProjectStoragePaths(
    resolveProjectStorageKey(project, project.default_cwd)
  ).root;
  if (project.kind === 'folder') return [storageRoot];
  const config = await loadRepoConfig(project.default_cwd);
  const repoLocal = resolveRepoLocalOverride(config.worktree?.path, project.default_cwd);
  const { base } = getWorktreeBase(toRepoPath(project.default_cwd), project.name, { repoLocal });
  return [storageRoot, resolve(base)];
}
