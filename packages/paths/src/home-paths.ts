/**
 * Archon home and workspace paths: where `ARCHON_HOME` is, what lives directly
 * under it, and whether a path is inside it or its workspaces tree.
 */

import { join, normalize, resolve, sep, relative, isAbsolute, parse } from 'path';
import type { PlatformPath } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
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
export function isDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.WORKSPACE_PATH === '/workspace' ||
    (env.HOME === '/root' && Boolean(env.WORKSPACE_PATH)) ||
    env.ARCHON_DOCKER === 'true'
  );
}

/**
 * Detect if running inside WSL (Windows Subsystem for Linux).
 *
 * Two signals (either is sufficient):
 *   - `WSL_DISTRO_NAME` env var is set (always true inside a WSL distro)
 *   - `/proc/sys/kernel/osrelease` contains "microsoft" (lower-cased)
 *
 * Used by callers that need to emit Windows-host-friendly URIs
 * (`vscode://vscode-remote/wsl+<distro>/...` instead of `vscode://file/...`)
 * when the server is inside WSL but the browser is on the Windows host.
 */
export function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;

  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    return release.includes('microsoft');
  } catch {
    // Unable to read the fallback signal; return false conservatively. This
    // can be a false negative (WSL with the env var absent and an unreadable
    // /proc/sys/kernel/osrelease), in which case callers fall back to the
    // plain vscode://file/... URI.
    return false;
  }
}

/**
 * Return the configured `WSL_DISTRO_NAME` value (`Ubuntu`, `Debian`, …) if
 * present, otherwise `undefined`. WSL sets this env var in every distro
 * shell; it may also be set manually to opt into the WSL URI path.
 *
 * Note this only reads the env var — `isWSL()` may still be true via the
 * `/proc` fallback while this returns `undefined`. Without the env var we
 * don't know what distro to put into a
 * `vscode://vscode-remote/wsl+<distro>/...` URI, and guessing is worse than
 * a sentinel that callers can fall back on.
 */
export function getWSLDistroName(): string | undefined {
  return process.env.WSL_DISTRO_NAME ?? undefined;
}

/**
 * Get the Archon home directory
 * - Docker: /.archon
 * - Local: ~/.archon (or ARCHON_HOME env var)
 */
export function getArchonHome(env: NodeJS.ProcessEnv = process.env): string {
  if (isDocker(env)) {
    return '/.archon';
  }

  const envHome = env.ARCHON_HOME;
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

type PathSemantics = Pick<
  PlatformPath,
  'resolve' | 'relative' | 'isAbsolute' | 'sep' | 'normalize' | 'parse'
>;

const hostPathSemantics: PathSemantics = { resolve, relative, isAbsolute, sep, normalize, parse };

export interface PathInsideOptions {
  /** Count `candidate` naming `root` itself as inside. Default: only descendants are inside. */
  includeRoot?: boolean;
  /**
   * Compare the normalized spellings instead of resolved paths: no resolution
   * against the process cwd (a relative path is never inside an absolute root)
   * and exact case on every platform. Guards whose contract has always been a
   * spelling comparison use this so moving onto the shared helper cannot make
   * them admit a path they rejected before, such as a case variant on Windows
   * that a case-sensitive directory would resolve somewhere else.
   */
  lexical?: boolean;
  /** Defaults to this host; tests pass `path.win32` or `path.posix` to evaluate another platform. */
  pathApi?: PathSemantics;
}

/**
 * True when `candidate` is inside `root`, compared segment by segment so a
 * sibling such as `workspaces-old` or a `.archon/workspaces` fragment under
 * another root never matches.
 *
 * By default both paths are resolved, so on Windows either separator works and
 * the comparison ignores case. See {@link PathInsideOptions.lexical} for the
 * spelling comparison.
 */
export function isPathInside(
  root: string,
  candidate: string,
  { includeRoot = false, lexical = false, pathApi = hostPathSemantics }: PathInsideOptions = {}
): boolean {
  if (lexical) {
    const base = trimTrailingSep(pathApi.normalize(root), pathApi);
    const target = trimTrailingSep(pathApi.normalize(candidate), pathApi);
    if (target === base) return includeRoot;
    return target.startsWith(base.endsWith(pathApi.sep) ? base : base + pathApi.sep);
  }
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  if (rel === '') return includeRoot;
  return rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/** Drop one trailing separator (normalize has already collapsed repeats), keeping a filesystem root such as `/` or `C:\`. */
function trimTrailingSep(p: string, pathApi: PathSemantics): string {
  return p.endsWith(pathApi.sep) && p.length > pathApi.parse(p).root.length ? p.slice(0, -1) : p;
}

/**
 * True when `candidate` is inside this host's Archon workspaces root, the tree
 * Archon clones into and manages. The one answer to "is this path Archon-managed".
 */
export function isInsideArchonWorkspaces(candidate: string): boolean {
  return isPathInside(getArchonWorkspacesPath(), candidate);
}

/**
 * Ensure the workspaces directory exists and return its path.
 * Safe to call on a fresh install before any workspace is registered.
 */
export async function ensureArchonWorkspacesPath(): Promise<string> {
  const path = getArchonWorkspacesPath();
  await mkdir(path, { recursive: true });
  return path;
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
 * Get the ephemeral scratch area (~/.archon/temp/).
 * Contents are per-process throwaway — each consumer creates a uniquely named
 * subdirectory and removes it when done (currently: dry-run simulations).
 */
export function getArchonTempPath(): string {
  return join(getArchonHome(), 'temp');
}

/**
 * Get the global config file path
 */
export function getArchonConfigPath(archonHome: string = getArchonHome()): string {
  return join(archonHome, 'config.yaml');
}

/** Path to the compiled CLI discovery manifest (`<ARCHON_HOME>/install.json`). */
export function getInstallManifestPath(): string {
  return join(getArchonHome(), 'install.json');
}

/** Path where the auto-provisioned encryption key is stored (~/.archon/credential-key). */
export function getCredentialKeyPath(): string {
  return join(getArchonHome(), 'credential-key');
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
export function getArchonEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getArchonHome(env), '.env');
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

export function getServerDistDir(version: string): string {
  return join(getArchonHome(), 'server', version);
}

/**
 * Returns the path to the cached web UI distribution for a given version.
 * Example: ~/.archon/web-dist/v0.3.2/
 */
export function getWebDistDir(version: string): string {
  return join(getArchonHome(), 'web-dist', version);
}

/**
 * True when `candidate` resolves inside `ARCHON_HOME`.
 *
 * Every storage key kind composes under `ARCHON_HOME` — including the `_cwd`
 * pseudo-project since #2200 — so this is the trust boundary for any path that
 * did NOT come straight from {@link getProjectStoragePaths}. In practice that
 * means a persisted `workflow_runs.output_root`: the engine only ever writes an
 * in-tree value, so an out-of-tree one is corruption or a hand edit, and acting
 * on it would let a relative or whitespace root scatter a run's artifacts AND
 * its shared state under whatever the server's cwd happens to be.
 *
 * A lexical comparison: a relative path is never inside the absolute home, and
 * case must match exactly even on Windows.
 */
export function isInsideArchonHome(candidate: string): boolean {
  return isPathInside(getArchonHome(), candidate, { includeRoot: true, lexical: true });
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
