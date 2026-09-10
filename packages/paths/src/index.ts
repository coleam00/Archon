// Archon path resolution utilities
export {
  expandTilde,
  canonicalizeProjectPath,
  isDocker,
  isWSL,
  getWSLDistroName,
  getArchonHome,
  getArchonWorkspacesPath,
  ensureArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonTempPath,
  getArchonConfigPath,
  getInstallManifestPath,
  getCredentialKeyPath,
  getArchonEnvPath,
  getRepoArchonEnvPath,
  getHomeWorkflowsPath,
  getHomeCommandsPath,
  getHomeScriptsPath,
  getLegacyHomeWorkflowsPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  getAppArchonBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logArchonPaths,
  validateAppDefaultsPaths,
  parseOwnerRepo,
  resolveRepoProjectIdentity,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  sanitizeScopeSegment,
  getScopeArtifactsPath,
  resolveProjectStorageKey,
  getProjectStoragePaths,
  getStoragePathsForRoot,
  isInsideArchonHome,
  resolveRunStorageRoot,
  getRunArtifactsDirForKey,
  getRunArtifactsDirForRoot,
  getRunLogPathForRoot,
  getRunWorkflowSourceDirForRoot,
  slugifyFolderName,
  getFolderProjectRoot,
  getFolderProjectArtifactsPath,
  getFolderProjectLogsPath,
  getFolderRunArtifactsPath,
  ensureFolderProjectStructure,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
  findMarkdownFilesRecursive,
  findCommandFiles,
  getWebDistDir,
  getSourceWebDistDir,
} from './archon-paths';
export type { ProjectStorageKey, ProjectStoragePaths } from './archon-paths';

// Detached workflow install identity
export {
  DETACHED_INSTALL_CONTEXT_KEYS,
  captureDetachedInstallContext,
  restoreDetachedInstallContext,
} from './detached-install-context';
export type { DetachedInstallContext, DetachedInstallContextKey } from './detached-install-context';

// Env loader
export { loadArchonEnv, isVerboseBoot } from './env-loader';

// Logger
export { createLogger, setLogLevel, getLogLevel, rootLogger } from './logger';
export type { Logger } from './logger';

// Build-time constants (rewritten by scripts/build-binaries.sh)
export {
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  BUNDLED_GIT_COMMIT,
  BUNDLED_WEB_DIST_SHA256,
} from './bundled-build';

// Compiled CLI discovery manifest
export { refreshCompiledInstallManifest } from './install-manifest';
export type { InstallManifest } from './install-manifest';

// Update check
export {
  checkForUpdate,
  getCachedUpdateCheck,
  isNewerVersion,
  parseLatestRelease,
} from './update-check';
export type { UpdateCheckResult } from './update-check';

// Tier notice (one-time CLI notice for unconfigured tier-keyword workflows)
export { readTierNoticeState, markTierNoticeShown } from './tier-notice';
export type { TierNoticeState } from './tier-notice';

// Anonymous telemetry
export {
  captureWorkflowInvoked,
  captureArchonStarted,
  captureArchonActive,
  captureChatTurn,
  captureApprovalResolved,
  captureCodebaseRegistered,
  captureWorkflowCompleted,
  classifyWorkflowForTelemetry,
  TELEMETRY_SCHEMA_VERSION,
  shutdownTelemetry,
  isTelemetryDisabled,
  getTelemetryStatus,
  resetTelemetryId,
} from './telemetry';
export type {
  WorkflowInvokedProperties,
  ArchonStartedProperties,
  ChatTurnProperties,
  DeploymentShapeProperties,
  WorkflowCompletedProperties,
  WorkflowExitReason,
  WorkflowErrorClass,
  WorkflowNodeType,
  WorkflowTelemetrySource,
  TelemetryStatus,
  TelemetryDisabledReason,
} from './telemetry';
