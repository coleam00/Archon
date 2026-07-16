// --- Types ---
export type {
  IsolationProviderType,
  IsolationWorkflowType,
  EnvironmentStatus,
  IssueIsolationRequest,
  PRIsolationRequest,
  ReviewIsolationRequest,
  ThreadIsolationRequest,
  TaskIsolationRequest,
  IsolationRequest,
  AdoptedWorktreeMetadata,
  CreatedWorktreeMetadata,
  WorktreeMetadata,
  WorktreeEnvironment,
  IsolatedEnvironment,
  DestroyOptions,
  WorktreeDestroyOptions,
  DestroyResult,
  IIsolationProvider,
  IsolationHints,
  IsolationBlockReason,
  IsolationEnvironmentRow,
  WorktreeCreateConfig,
  RepoConfigLoader,
  WorktreeStatusBreakdown,
  CreateEnvironmentParams,
  ResolveRequest,
  ResolutionMethod,
  IsolationResolution,
  ExecutionContext,
  BackendPrepareRequest,
  PreparedEnv,
  IIsolationBackend,
} from './types';

export { isPRIsolationRequest } from './types';

// --- Backend seam (folder projects) ---
export { resolveFolderBackend } from './backend-router';
export type { ResolveFolderBackendOptions } from './backend-router';
export { InPlaceBackend } from './backends/in-place';

// --- Store ---
export type { IIsolationStore } from './store';

// --- Errors ---
export { IsolationBlockedError, classifyIsolationError } from './errors';

// --- Factory ---
export { getIsolationProvider, configureIsolation, resetIsolationProvider } from './factory';

// --- Resolver ---
export { IsolationResolver } from './resolver';
export type { IsolationResolverDeps } from './resolver';

// --- Provider ---
export { WorktreeProvider } from './providers/worktree';

// --- PR state lookup ---
export { getPrState } from './pr-state';
export type { PrState } from './pr-state';

// --- Worktree copy utility ---
export {
  copyWorktreeFiles,
  copyWorktreeFile,
  parseCopyFileEntry,
  isPathWithinRoot,
} from './worktree-copy';
export type { CopyFileEntry } from './worktree-copy';
