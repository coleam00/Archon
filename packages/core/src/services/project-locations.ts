import { getProjectStoragePaths, resolveProjectStorageKey } from '@archon/paths';
import {
  CanonicalRepoPathUnavailableError,
  getCanonicalRepoPath,
  getWorktreeBase,
  toRepoPath,
} from '@archon/git';
import { resolveRepoLocalOverride } from '@archon/isolation';
import { resolve } from 'node:path';
import { loadRepoConfig } from '../config/config-loader';
import type { Codebase } from '../schemas/codebase';

export async function getProjectLocations(
  project: Pick<Codebase, 'name' | 'kind' | 'default_cwd'>
): Promise<string[]> {
  const storageRoot = getProjectStoragePaths(
    resolveProjectStorageKey(project, project.default_cwd)
  ).root;
  if (project.kind === 'folder') return [storageRoot];
  let primaryPath;
  try {
    primaryPath = await getCanonicalRepoPath(project.default_cwd);
  } catch (error) {
    // Separate Git directories have no reverse pointer to their primary checkout.
    if (!(error instanceof CanonicalRepoPathUnavailableError)) throw error;
    primaryPath = toRepoPath(project.default_cwd);
  }
  const worktreeBase = async (path: string): Promise<string> => {
    const config = await loadRepoConfig(path);
    const repoLocal = resolveRepoLocalOverride(config.worktree?.path, path);
    return resolve(getWorktreeBase(toRepoPath(path), project.name, { repoLocal }).base);
  };
  const registeredBase = await worktreeBase(project.default_cwd);
  const primaryBase =
    primaryPath === project.default_cwd ? registeredBase : await worktreeBase(primaryPath);
  return [storageRoot, registeredBase, primaryBase];
}
