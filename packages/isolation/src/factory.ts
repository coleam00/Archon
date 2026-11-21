/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers with config injection.
 * Currently only supports WorktreeProvider (git worktrees).
 */

import type { IIsolationProvider, RepoConfigLoader, WorktreeSetupExecutor } from './types';
import type { RepoPath } from '@archon/git';
import { WorktreeProvider } from './providers/worktree';
import { checkWorktreeStart } from './providers/worktree/create';

let configuredExecutor: WorktreeSetupExecutor | undefined;
let provider: IIsolationProvider | null = null;
let configuredLoader: RepoConfigLoader = () => Promise.resolve(null);

/**
 * Configure the isolation system with a repo config loader.
 * Must be called before getIsolationProvider() for full functionality.
 * If not called, WorktreeProvider uses a no-op loader (no custom baseBranch, copyFiles, or path).
 */
export function configureIsolation(
  loader: RepoConfigLoader,
  setupExecutor?: WorktreeSetupExecutor
): void {
  configuredLoader = loader;
  configuredExecutor = setupExecutor;
  provider = null; // Reset singleton so it picks up new loader
}

/**
 * Get the isolation provider instance (singleton).
 * Currently only returns WorktreeProvider.
 */
export function getIsolationProvider(): IIsolationProvider {
  provider ??= new WorktreeProvider(configuredLoader, configuredExecutor);
  return provider;
}

/**
 * Refuse a worktree start that cannot succeed whatever base it gets: an ambiguous
 * remote, or no remote and no commit. These are the checks `create()` runs first,
 * read through the configured loader, so a caller can refuse before taking a slot.
 */
export async function checkWorktreeStartable(repoPath: RepoPath): Promise<void> {
  await checkWorktreeStart(repoPath, await configuredLoader(repoPath));
}
