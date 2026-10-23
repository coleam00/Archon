// Home and workspace paths
export {
  expandTilde,
  isDocker,
  isWSL,
  getWSLDistroName,
  getArchonHome,
  getArchonWorkspacesPath,
  isPathInside,
  isInsideArchonWorkspaces,
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
  logArchonPaths,
  isInsideArchonHome,
  getWebDistDir,
  getServerDistDir,
} from './home-paths';
// Project and codebase paths
export {
  canonicalizeProjectPath,
  parseOwnerRepo,
  toSafeNameSegment,
  resolveRepoProjectIdentity,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  sanitizeScopeSegment,
  resolveProjectStorageKey,
  getProjectStoragePaths,
  getStoragePathsForRoot,
  slugifyFolderName,
  getFolderProjectRoot,
  getFolderProjectArtifactsPath,
  getFolderProjectLogsPath,
  ensureFolderProjectStructure,
  ensureProjectStructure,
  createProjectSourceSymlink,
  ProjectSourceOccupiedError,
  projectKeyForStorageRoot,
  projectKeyForCodebase,
} from './project-paths';
export type { ProjectStorageKey, ProjectStoragePaths } from './project-paths';
// Run and artifact paths
export {
  getRunArtifactsPath,
  getRunLogPath,
  getScopeArtifactsPath,
  resolveRunStorageRoot,
  getRunArtifactsDirForKey,
  getRunArtifactsDirForRoot,
  RUN_ARTIFACTS_ENGINE_SUBDIR,
  getRunScratchDir,
  isRunArtifactsEngineEntry,
  getRunLogPathForRoot,
  getRunWorkflowSourceDirForRoot,
  getFolderRunArtifactsPath,
} from './run-paths';
// Source checkout paths
export {
  getAppArchonBasePath,
  getBundledWorkflowsPath,
  validateAppDefaultsPaths,
  getSourceWebDistDir,
  getSourceServerEntry,
  getSourceProviderEntry,
} from './source-tree-paths';
// Command and workflow markdown discovery
export {
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  findMarkdownFilesRecursive,
  findCommandFiles,
} from './markdown-discovery';

// Detached workflow install identity
export {
  DETACHED_INSTALL_CONTEXT_KEYS,
  captureDetachedInstallContext,
  restoreDetachedInstallContext,
} from './detached-install-context';
export type { DetachedInstallContext, DetachedInstallContextKey } from './detached-install-context';

// Env loader
export { loadArchonEnv, isVerboseBoot, getPluginsPath, getArchonEnvNames } from './env-loader';

// Logger
export {
  createLogger,
  setLogLevel,
  getLogLevel,
  setLogDestination,
  setLogSink,
  rootLogger,
} from './logger';
export type { Logger } from './logger';

// Build-time constants (rewritten by scripts/build-binaries.sh)
export {
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  BUNDLED_GIT_COMMIT,
  BUNDLED_WEB_DIST_SHA256,
  BUNDLED_SERVER_SHA256,
} from './bundled-build';

// Compiled CLI discovery manifest
export { refreshCompiledInstallManifest } from './install-manifest';
export type { InstallManifest } from './install-manifest';

// Update check
export {
  checkForUpdate,
  getCachedUpdateCheck,
  takeCachedUpdateNotice,
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
  captureWorkflowNoMatch,
  captureApprovalResolved,
  captureCodebaseRegistered,
  captureWorkflowTerminal,
} from './telemetry';
export {
  WORKFLOW_TERMINAL_EVENT_TYPE,
  classifyWorkflowForTelemetry,
  TELEMETRY_SCHEMA_VERSION,
} from './telemetry-events';
export type {
  WorkflowInvokedProperties,
  ArchonStartedProperties,
  ChatTurnProperties,
  DeploymentShapeProperties,
  WorkflowTerminalProperties,
  WorkflowShapeProperties,
  WorkflowAncestryProperties,
  PromptCharsBucket,
  WorkflowCancelReason,
  WorkflowExitReason,
  WorkflowErrorClass,
  WorkflowNodeType,
  WorkflowTelemetrySource,
} from './telemetry-events';
export { isTelemetryDisabled, getTelemetryStatus, resetTelemetryId } from './telemetry-consent';
export type { TelemetryStatus, TelemetryDisabledReason } from './telemetry-consent';
export { shutdownTelemetry } from './telemetry-transport';
