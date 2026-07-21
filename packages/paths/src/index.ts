// Archon path resolution utilities
export {
  expandTilde,
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  ensureArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
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
  getWebDistDir,
} from './archon-paths';

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
