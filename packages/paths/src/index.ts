// Archon path resolution utilities
export {
  expandTilde,
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  getAppArchonBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logArchonPaths,
  validateAppDefaultsPaths,
  parseOwnerRepo,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
  findMarkdownFilesRecursive,
} from './archon-paths';

// Logger
export { createLogger, setLogLevel, getLogLevel, rootLogger } from './logger';
export type { Logger } from './logger';

// Build-time constants (rewritten by scripts/build-binaries.sh)
export { BUNDLED_IS_BINARY, BUNDLED_VERSION, BUNDLED_GIT_COMMIT } from './bundled-build';
