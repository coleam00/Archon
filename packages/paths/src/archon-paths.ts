/**
 * Archon path resolution utilities
 *
 * Directory structure:
 * ~/.archon/                              # User-level (ARCHON_HOME)
 * ├── workspaces/owner/repo/             # Project-centric layout
 * │   ├── source/                        # Clone or symlink → local path
 * │   ├── worktrees/                     # Git worktrees for this project
 * │   ├── artifacts/runs/{workflow-id}/  # Workflow artifacts (NEVER in git)
 * │   └── logs/{workflow-id}.jsonl       # Workflow execution logs
 * ├── worktrees/                         # Legacy global worktrees (for repos not in workspaces/)
 * └── config.yaml                        # Global config
 *
 * For Docker: /.archon/
 */

import { join, dirname, normalize, basename } from 'path';
import { homedir } from 'os';
import { access, mkdir, symlink, lstat, readdir, readlink, rm } from 'fs/promises';
import { createLogger } from './logger';

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
    process.env.ARCHON_DOCKER === 'true'
  );
}

/**
 * Get the Archon home directory
 * - Docker: /.archon
 * - Local: ~/.archon (or ARCHON_HOME env var)
 */
export function getArchonHome(): string {
  if (isDocker()) {
    return '/.archon';
  }

  const envHome = process.env.ARCHON_HOME;
  if (envHome) {
    if (envHome === 'undefined') {
      throw new Error(
        'ARCHON_HOME is set to the literal string "undefined". ' +
          'This indicates a bug where an undefined value was coerced to a string. ' +
          'Unset ARCHON_HOME or provide a valid path.'
      );
    }
    return expandTilde(envHome);
  }

  return join(homedir(), '.archon');
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
 * Get the home-scoped workflows directory (`~/.archon/workflows/`).
 * Workflows placed here are discovered from every repo and apply globally —
 * overridden per-filename by the same name under `<repoRoot>/.archon/workflows/`.
 *
 * Direct child of `~/.archon/`, matching the convention for `workspaces/`,
 * `archon.db`, `config.yaml`, etc. Replaces the prior `~/.archon/.archon/workflows/`
 * location which was an artifact of reusing the repo-relative discovery helper.
 */
export function getHomeWorkflowsPath(): string {
  return join(getArchonHome(), 'workflows');
}

/**
 * Get the home-scoped commands directory (`~/.archon/commands/`).
 * Commands placed here are resolvable from every repo and apply globally —
 * overridden per-filename by the same name under `<repoRoot>/.archon/commands/`.
 * Command resolution precedence: repo > home > bundled.
 */
export function getHomeCommandsPath(): string {
  return join(getArchonHome(), 'commands');
}

/**
 * Get the home-scoped scripts directory (`~/.archon/scripts/`).
 * Scripts placed here are available to every workflow's `script:` nodes —
 * overridden per-name by the same name under `<repoRoot>/.archon/scripts/`.
 * Script resolution precedence: repo > home.
 */
export function getHomeScriptsPath(): string {
  return join(getArchonHome(), 'scripts');
}

/**
 * Legacy home-scoped workflows directory (`~/.archon/.archon/workflows/`).
 * Retained only so discovery can DETECT files there and emit a one-time
 * deprecation warning pointing at the migration command. Archon no longer
 * reads workflows from this path — it's a signal, not a source.
 */
export function getLegacyHomeWorkflowsPath(): string {
  return join(getArchonHome(), '.archon', 'workflows');
}

/**
 * Get the home-scope archon env file path (~/.archon/.env).
 * This is the archon-owned env location loaded by every entry point.
 */
export function getArchonEnvPath(): string {
  return join(getArchonHome(), '.env');
}

/**
 * Get the repo-scope archon env file path (<cwd>/.archon/.env).
 * This is the archon-owned env location loaded with override: true AFTER the home
 * env, so per-project values win over user-wide defaults.
 *
 * Note: <cwd>/.env (without the .archon/ prefix) is the USER's — it is stripped at
 * boot by stripCwdEnv() and never loaded by Archon.
 */
export function getRepoArchonEnvPath(cwd: string): string {
  return join(cwd, '.archon', '.env');
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
 *
 * `maxDepth` caps how many folders deep the walk descends. Depth is counted as
 * the number of folder boundaries between `rootPath` and the file — so at
 * `maxDepth: 1`, files at `rootPath/file.md` (depth 0) and `rootPath/group/file.md`
 * (depth 1) are included, but `rootPath/group/sub/file.md` (depth 2) is not.
 * Default is `Infinity` (no cap) for backwards compatibility with callers that
 * want to copy arbitrary subtrees (e.g. clone handlers).
 */
export async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = '',
  options?: { maxDepth?: number }
): Promise<{ commandName: string; relativePath: string }[]> {
  const maxDepth = options?.maxDepth ?? Infinity;
  const currentDepth = relativePath ? relativePath.split(/[/\\]/).filter(Boolean).length : 0;
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
      // Skip descending if we're already at the depth cap — files at deeper
      // levels are silently ignored (matches the convention that `.archon/*/`
      // folders support one level of grouping like `defaults/`).
      if (currentDepth >= maxDepth) continue;
      const subResults = await findMarkdownFilesRecursive(
        rootPath,
        join(relativePath, entry.name),
        options
      );
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
