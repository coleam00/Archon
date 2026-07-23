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
  WriteBackFinalizeResult,
  WriteBackApplySummary,
  BackendPrepareRequest,
  PreparedEnv,
  IIsolationBackend,
  ContainerBackendConfig,
} from './types';

export { isPRIsolationRequest, CONTAINER_LABELS } from './types';

// --- Backend seam (folder projects) ---
export { resolveFolderBackend } from './backend-router';
export type { ResolveFolderBackendOptions } from './backend-router';
export { InPlaceBackend } from './backends/in-place';
export { ContainerBackend } from './backends/container';
export type { ContainerBackendDeps } from './backends/container';

// --- Container backend primitives (docker CLI wrapper) ---
export { dockerCli, dockerPreflight, extractDockerError } from './container/docker-exec';
export type { DockerRunner, DockerExecOptions, DockerExecResult } from './container/docker-exec';

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

// --- Worktree engine (pluggable low-level plumbing: git | worktrunk) ---
export { WORKTREE_ENGINE_IDS } from './engine/types';
export type {
  WorktreeEngine,
  WorktreeEngineId,
  AddWorktreeOptions,
  RemoveWorktreeOptions,
} from './engine/types';
export { GitWorktreeEngine } from './engine/git-engine';
export { WorktrunkEngine, MIN_WORKTRUNK_VERSION } from './engine/worktrunk-engine';
export { resolveWorktreeEngine } from './engine/resolve';

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
