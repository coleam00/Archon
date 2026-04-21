/**
 * HarneesLab path resolution utilities
 *
 * Directory structure:
 * ~/.archon/                              # User-level legacy default (ARCHON_HOME)
 * ~/.harneeslab/                          # User-level opt-in (HARNEESLAB_HOME)
 * ├── workspaces/owner/repo/             # Project-centric layout
 * │   ├── source/                        # Clone or symlink → local path
 * │   ├── worktrees/                     # Git worktrees for this project
 * │   ├── artifacts/runs/{workflow-id}/  # Workflow artifacts (NEVER in git)
 * │   └── logs/{workflow-id}.jsonl       # Workflow execution logs
 * ├── worktrees/                         # Legacy global worktrees (for repos not in workspaces/)
 * └── config.yaml                        # Global config
 *
 * For Docker: /.harneeslab/ when HARNEESLAB_DOCKER=true, otherwise legacy /.archon/
 */

import { join, dirname, normalize, basename } from 'path';
import { homedir } from 'os';
import { access, mkdir, symlink, lstat, readdir, readlink, rm } from 'fs/promises';
import { createLogger } from './logger';

const HARNEESLAB_HOME_ENV = 'HARNEESLAB_HOME';
const LEGACY_ARCHON_HOME_ENV = 'ARCHON_HOME';
const HARNEESLAB_DOCKER_ENV = 'HARNEESLAB_DOCKER';
const LEGACY_ARCHON_DOCKER_ENV = 'ARCHON_DOCKER';
const HARNEESLAB_DOCKER_HOME = '/.harneeslab';
const LEGACY_ARCHON_HOME_DIR = '.archon';
const LEGACY_ARCHON_DOCKER_HOME = '/.archon';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('archon-paths');
  return cachedLog;
}

/**
 * Expand ~ to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith('~')) {
    const pathAfterTilde = path.slice(1).replace(/^[/\\]/, '');
    return join(homedir(), pathAfterTilde);
  }
  return path;
}

/**
 * Detect if running in Docker container
 */
export function isDocker(): boolean {
  return (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env[HARNEESLAB_DOCKER_ENV] === 'true' ||
    process.env[LEGACY_ARCHON_DOCKER_ENV] === 'true'
  );
}

/**
 * Get the HarneesLab home directory.
 *
 * The function name stays getArchonHome for API compatibility while the fork
 * migrates runtime naming. HARNEESLAB_HOME is the preferred override;
 * ARCHON_HOME remains a legacy fallback. The default local directory remains
 * ~/.archon in this compatibility phase so existing users keep their data.
 */
export function getArchonHome(): string {
  if (isDocker()) {
    const harneeslabHome = process.env[HARNEESLAB_HOME_ENV];
    if (harneeslabHome) {
      return expandTilde(validateHomeEnv(HARNEESLAB_HOME_ENV, harneeslabHome));
    }
    const legacyArchonHome = process.env[LEGACY_ARCHON_HOME_ENV];
    if (legacyArchonHome) {
      return expandTilde(validateHomeEnv(LEGACY_ARCHON_HOME_ENV, legacyArchonHome));
    }
    if (process.env[HARNEESLAB_DOCKER_ENV] === 'true') {
      return HARNEESLAB_DOCKER_HOME;
    }
    return LEGACY_ARCHON_DOCKER_HOME;
  }

  const harneeslabHome = process.env[HARNEESLAB_HOME_ENV];
  if (harneeslabHome) {
    return expandTilde(validateHomeEnv(HARNEESLAB_HOME_ENV, harneeslabHome));
  }

  const legacyArchonHome = process.env[LEGACY_ARCHON_HOME_ENV];
  if (legacyArchonHome) {
    return expandTilde(validateHomeEnv(LEGACY_ARCHON_HOME_ENV, legacyArchonHome));
  }

  return join(homedir(), LEGACY_ARCHON_HOME_DIR);
}

function validateHomeEnv(name: string, value: string): string {
  if (value === 'undefined') {
    throw new Error(
      `${name} is set to the literal string "undefined". ` +
        'This indicates a bug where an undefined value was coerced to a string. ' +
        `Unset ${name} or provide a valid path.`
    );
  }
  return value;
}

/**
 * Get the workspaces directory (where repos are cloned)
 */
export function getArchonWorkspacesPath(): string {
  return join(getArchonHome(), 'workspaces');
}

/**
 * Get the global worktrees directory (~/.archon/worktrees/).
 * Used as the legacy fallback for repos not registered under workspaces/.
 * New project registrations use getProjectWorktreesPath(owner, repo) instead.
 */
export function getArchonWorktreesPath(): string {
  return join(getArchonHome(), 'worktrees');
}

/**
 * Get the global config file path
 */
export function getArchonConfigPath(): string {
  return join(getArchonHome(), 'config.yaml');
}

/**
 * Get command folder search paths for a repository
 * Returns folders in priority order (first match wins)
 *
 * Order:
 * 1. .archon/commands (always - user's custom commands)
 * 2. .archon/commands/defaults (bundled default commands)
 * 3. configuredFolder (if specified in config)
 *
 * @param configuredFolder - Optional additional folder from config
 */
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands', '.archon/commands/defaults'];

  // Add configured folder if specified (and not already in paths)
  if (
    configuredFolder &&
    configuredFolder !== '.archon/commands' &&
    configuredFolder !== '.archon/commands/defaults'
  ) {
    paths.push(configuredFolder);
  }

  return paths;
}

/**
 * Get workflow folder search paths for a repository
 * Returns folders in priority order (first match wins)
 */
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows'];
}

/**
 * Recursively find all .md files in a directory and its subdirectories.
 * Skips hidden directories and node_modules.
 */
export async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = ''
): Promise<{ commandName: string; relativePath: string }[]> {
  const results: { commandName: string; relativePath: string }[] = [];
  const fullPath = join(rootPath, relativePath);

  let entries;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return results;
    throw err;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      const subResults = await findMarkdownFilesRecursive(rootPath, join(relativePath, entry.name));
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push({
        commandName: basename(entry.name, '.md'),
        relativePath: join(relativePath, entry.name),
      });
    }
  }

  return results;
}

/**
 * Get the path to the app's base directory
 * This is where default commands/workflows are stored for copying to new repos
 *
 * In Docker: /app/.archon
 * Locally: {repo_root}/.archon
 */
export function getAppArchonBasePath(): string {
  // This file is at packages/paths/src/archon-paths.ts
  // Go up from src → paths → packages → repo root
  // import.meta.dir = packages/paths/src
  const repoRoot = dirname(dirname(dirname(import.meta.dir)));
  return join(repoRoot, '.archon');
}

/**
 * Get the path to the app's bundled default commands directory
 */
export function getDefaultCommandsPath(): string {
  return join(getAppArchonBasePath(), 'commands', 'defaults');
}

/**
 * Get the path to the app's bundled default workflows directory
 */
export function getDefaultWorkflowsPath(): string {
  return join(getAppArchonBasePath(), 'workflows', 'defaults');
}

/**
 * Returns the path to the cached web UI distribution for a given version.
 * Example: ~/.archon/web-dist/v0.3.2/
 */
export function getWebDistDir(version: string): string {
  return join(getArchonHome(), 'web-dist', version);
}

// =============================================================================
// Project-centric path functions
// =============================================================================

/** Valid characters for owner/repo segments (GitHub-compatible, no path traversal) */
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Parse "owner/repo" from a codebase name string.
 * Returns null if the name doesn't match exactly "owner/repo" format (no nested slashes).
 * Rejects path traversal characters and non-GitHub-compatible names.
 */
export function parseOwnerRepo(name: string): { owner: string; repo: string } | null {
  const parts = name.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  if (!SAFE_NAME.test(owner) || !SAFE_NAME.test(repo)) return null;
  return { owner, repo };
}

/**
 * Get the project root directory for a given owner/repo.
 * Returns: ~/.archon/workspaces/owner/repo/
 */
export function getProjectRoot(owner: string, repo: string): string {
  return join(getArchonWorkspacesPath(), owner, repo);
}

/**
 * Get the source directory (clone or symlink target) for a project.
 * Returns: ~/.archon/workspaces/owner/repo/source/
 */
export function getProjectSourcePath(owner: string, repo: string): string {
  return join(getProjectRoot(owner, repo), 'source');
}

/**
 * Get the worktrees directory for a project.
 * Returns: ~/.archon/workspaces/owner/repo/worktrees/
 */
export function getProjectWorktreesPath(owner: string, repo: string): string {
  return join(getProjectRoot(owner, repo), 'worktrees');
}

/**
 * Get the artifacts directory for a project.
 * Returns: ~/.archon/workspaces/owner/repo/artifacts/
 */
export function getProjectArtifactsPath(owner: string, repo: string): string {
  return join(getProjectRoot(owner, repo), 'artifacts');
}

/**
 * Get the logs directory for a project.
 * Returns: ~/.archon/workspaces/owner/repo/logs/
 */
export function getProjectLogsPath(owner: string, repo: string): string {
  return join(getProjectRoot(owner, repo), 'logs');
}

/**
 * Get the artifacts directory for a specific workflow run.
 * Returns: ~/.archon/workspaces/owner/repo/artifacts/runs/{id}/
 */
export function getRunArtifactsPath(owner: string, repo: string, workflowRunId: string): string {
  return join(getProjectArtifactsPath(owner, repo), 'runs', workflowRunId);
}

/**
 * Get the log file path for a specific workflow run.
 * Returns: ~/.archon/workspaces/owner/repo/logs/{id}.jsonl
 */
export function getRunLogPath(owner: string, repo: string, workflowRunId: string): string {
  return join(getProjectLogsPath(owner, repo), `${workflowRunId}.jsonl`);
}

/**
 * Resolve the project root path from a working directory path.
 * If the path is under ~/.archon/workspaces/owner/repo/..., returns the project root.
 * Returns null if the path is not under the workspaces directory.
 */
export function resolveProjectRootFromCwd(cwd: string): string | null {
  const workspacesPath = getArchonWorkspacesPath();
  if (!cwd.startsWith(workspacesPath)) return null;

  // Path after workspaces/: "owner/repo/..." or "owner/repo"
  const relative = cwd.substring(workspacesPath.length + 1); // +1 for trailing slash
  const parts = relative.split(/[/\\]/).filter(p => p.length > 0);
  if (parts.length < 2) return null;

  return join(workspacesPath, parts[0], parts[1]);
}

/**
 * Create the project directory structure (source/, worktrees/, artifacts/, logs/).
 * Safe to call multiple times - uses recursive mkdir.
 */
export async function ensureProjectStructure(owner: string, repo: string): Promise<void> {
  const dirs = [
    getProjectSourcePath(owner, repo),
    getProjectWorktreesPath(owner, repo),
    getProjectArtifactsPath(owner, repo),
    getProjectLogsPath(owner, repo),
  ];

  await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })));
}

/**
 * Create a symlink at the project source path pointing to a local directory.
 * If the symlink already exists and points to the same target, it's a no-op.
 * If it exists and points elsewhere, it throws an error.
 */
export async function createProjectSourceSymlink(
  owner: string,
  repo: string,
  targetPath: string
): Promise<void> {
  const linkPath = getProjectSourcePath(owner, repo);

  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      // Symlink already exists - check if it points to the right place
      const existing = await readlink(linkPath);
      if (normalize(existing) === normalize(targetPath)) {
        return; // Already correct
      }
      throw new Error(
        `Source symlink at ${linkPath} already points to ${existing}, expected ${targetPath}`
      );
    }
    if (stats.isDirectory()) {
      // Check if it's a real clone (has contents) vs empty dir from ensureProjectStructure
      const entries = await readdir(linkPath);
      if (entries.length > 0) {
        // Real directory with contents (e.g., from /clone) - don't overwrite
        return;
      }
      // Empty directory from ensureProjectStructure - will be replaced with symlink below
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
    // ENOENT is expected - symlink doesn't exist yet
  }

  // Remove the empty directory created by ensureProjectStructure (force handles ENOENT)
  await rm(linkPath, { recursive: true, force: true });
  await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Log the Archon paths configuration (for startup)
 */
export function logArchonPaths(): void {
  const home = getArchonHome();
  const workspaces = getArchonWorkspacesPath();
  const worktrees = getArchonWorktreesPath();
  const config = getArchonConfigPath();

  getLog().info({ home, workspaces, worktrees, config }, 'paths_configured');
}

/**
 * Validate that app defaults paths exist and are accessible (for startup)
 * Logs verification status and warnings if paths don't exist
 */
export async function validateAppDefaultsPaths(): Promise<void> {
  const commandsPath = getDefaultCommandsPath();
  const workflowsPath = getDefaultWorkflowsPath();

  const commandsOk = await checkPathAccessible(commandsPath, 'commands');
  const workflowsOk = await checkPathAccessible(workflowsPath, 'workflows');

  if (!commandsOk && !workflowsOk) {
    getLog().warn('app_defaults_not_available');
  } else if (commandsOk && workflowsOk) {
    getLog().info({ commands: commandsPath, workflows: workflowsPath }, 'app_defaults_verified');
  }
  // Partial availability already logged warnings above for individual paths
}

/**
 * Check if a path is accessible, logging a warning if not.
 * Returns true if the path is accessible, false otherwise.
 */
async function checkPathAccessible(path: string, label: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      getLog().warn({ path }, `app_default_${label}_not_found`);
    } else {
      getLog().warn({ path, err, code: err.code }, `app_default_${label}_inaccessible`);
    }
    return false;
  }
}
