// --- Types ---
export type {
  IsolationProviderType,
  IsolationWorkflowType,
  EnvironmentStatus,
  IssueIsolationRequest,
  PRIsolationRequest,
  ReviewIsolationRequest,
  ThreadIsolationRequest,
  TaskBranchSelection,
  TaskIsolationRequest,
  IsolationRequest,
  AdoptedWorktreeMetadata,
  CreatedWorktreeMetadata,
  ObservedWorktreeMetadata,
  WorktreeCreationEnvironment,
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
  ResolvedIsolation,
  ExecutionContext,
  WriteBackFinalizeResult,
  WriteBackApplySummary,
  BackendPrepareRequest,
  PreparedEnv,
  IIsolationBackend,
  ContainerBackendConfig,
} from './types';

export {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  isPRIsolationRequest,
  CONTAINER_LABELS,
  worktreeRegistrationMetadata,
  WORKTREE_REGISTRATION_ID,
  WORKTREE_REMOVAL_OWNER,
  readWorktreeCreationId,
  readWorktreeBranchCreated,
  WorktreeRegistrationChangedError,
  WorktreeRemovalInProgressError,
} from './types';

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
export { recordWorktreeAdoption, registerWorktree } from './store';

// --- Errors ---
export {
  ExistingBranchDivergedError,
  IsolationBlockedError,
  IsolationFailure,
  MissingProjectDirectoryError,
  WorktreeLeftoverError,
  WorktreeUncommittedChangesError,
  classifyIsolationError,
} from './errors';

// --- Factory ---
export { getIsolationProvider, configureIsolation, resetIsolationProvider } from './factory';

// --- Resolver ---
export { IsolationResolver } from './resolver';
export type { IsolationResolverDeps } from './resolver';

// --- Provider ---
export { WorktreeProvider, resolveRepoLocalOverride } from './providers/worktree';
export { isGeneratedTaskBranch } from './providers/worktree/branches';

// --- PR state lookup ---
export { getPrState } from './pr-state';
export type { PrLookup } from './pr-state';

// --- Worktree copy utility ---
export {
  copyWorktreeFiles,
  copyWorktreeFile,
  parseCopyFileEntry,
  isPathWithinRoot,
} from './worktree-copy';
export type { CopyFileEntry } from './worktree-copy';

export { validateWorktreePostCreate } from './post-create-config';
export type { WorktreeSetupExecutor, WorktreeSetupInput } from './types';
export { WorktreePostCreateError } from './errors';

export type { IsolationFailureKind } from './errors';
