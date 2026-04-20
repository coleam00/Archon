/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers with config injection.
 * Currently only supports WorktreeProvider (git worktrees).
 */

import type { IIsolationProvider, RepoConfigLoader } from './types';
import { WorktreeProvider } from './providers/worktree';

let provider: IIsolationProvider | null = null;
let configuredLoader: RepoConfigLoader = () => Promise.resolve(null);

/**
 * Configure the isolation system with a repo config loader.
 * Must be called before getIsolationProvider() for full functionality.
 * If not called, WorktreeProvider uses a no-op loader (no custom baseBranch, copyFiles, or path).
 */
export function configureIsolation(loader: RepoConfigLoader): void {
  configuredLoader = loader;
  provider = null; // Reset singleton so it picks up new loader
}

/**
 * Get the isolation provider instance (singleton).
 * Currently only returns WorktreeProvider.
 */
export function getIsolationProvider(): IIsolationProvider {
  provider ??= new WorktreeProvider(configuredLoader);
  return provider;
}

/**
 * Reset the isolation provider (for testing)
 */
export function resetIsolationProvider(): void {
  provider = null;
}
