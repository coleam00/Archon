/**
 * Project and codebase paths: a project's identity, its storage key, and the
 * directory tree under `workspaces/` that every project kind gets.
 */

import { join, normalize, basename, resolve, relative } from 'path';
import { createHash } from 'node:crypto';
import { mkdir, symlink, lstat, readdir, readlink, realpath, rm } from 'fs/promises';
import { createLogger } from './logger';
import { expandTilde, getArchonWorkspacesPath, isPathInside } from './home-paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('archon-paths');
  return cachedLog;
}

/**
 * Canonicalize a directory path into the single form stored in and looked up
 * from `remote_agent_codebases.default_cwd`.
 *
 * Every writer and every reader of that column MUST resolve through this one
 * function. The column is matched by exact string equality (and by a
 * separator-anchored prefix), so two call sites using two different
 * canonicalizers silently stop finding each other's rows. That is issue #2927:
 * on Windows `fs/promises.realpath` expands an 8.3 short component
 * (`C:\Users\RUNNER~1\…` → `C:\Users\runneradmin\…`) while `fs.realpathSync`
 * does not, so a folder project registered by the CLI became invisible to every
 * later command run in that same directory.
 *
 * `fs/promises.realpath` is the chosen implementation for two reasons. It is the
 * only variant whose Windows short-name behaviour has actually been observed
 * here (`fs.realpathSync.native` is believed equivalent but is unverified on
 * Windows, so nothing depends on it). And expansion is what makes this a
 * canonicalization at all: the long name is the one name a directory has, so
 * the non-expanding variant would leave two spellings of one directory able to
 * register two rows.
 *
 * Fail-safe: a path that cannot be resolved (missing, unreadable parent, race)
 * canonicalizes to its own absolute form rather than throwing, so a lookup still
 * gets an answer to reject. Nothing is swallowed — callers that require the path
 * to exist detect it immediately afterwards (`registerFolder` stats the result;
 * a reader misses the lookup and reports an unregistered directory).
 */
export async function canonicalizeProjectPath(path: string): Promise<string> {
  const absolute = resolve(expandTilde(path));
  try {
    return await realpath(absolute);
  } catch (err) {
    getLog().debug({ err, path: absolute }, 'paths.canonicalize_project_path_failed');
    return absolute;
  }
}

/** Valid characters for owner/repo segments (GitHub-compatible, no path traversal) */
const SAFE_NAME_CHARS = 'a-zA-Z0-9._-';
const SAFE_NAME = new RegExp(`^[${SAFE_NAME_CHARS}]+$`);
const UNSAFE_NAME_CHAR = new RegExp(`[^${SAFE_NAME_CHARS}]`, 'g');

/** Replace each character {@link parseOwnerRepo} rejects in a segment with `-`. */
export function toSafeNameSegment(value: string): string {
  return value.replace(UNSAFE_NAME_CHAR, '-');
}

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
 * Resolve the `{ owner, repo }` storage identity for a registered *repo*-kind
 * codebase. This is the single source of truth that keeps `registerRepository()`
 * (which creates the on-disk `owner/repo` tree), the log/artifact path
 * resolvers, and the worktree base (`getWorktreeBase()` in `@archon/git`) in
 * agreement — a mismatch between them dropped no-remote repos' logs/artifacts
 * into `<cwd>/.archon` instead of `ARCHON_HOME` (#2132), and later split
 * worktrees and storage across two different workspace trees (#2227).
 *
 * - A `name` in exact `owner/repo` form (clones, web-registered repos) → that
 *   owner/repo.
 * - Otherwise — most commonly a no-remote local repo registered under its bare
 *   directory basename — the working directory's basename scoped under the
 *   `_local` pseudo-owner, mirroring what registration writes to disk.
 *   `basename()` never contains a path separator, so the only traversal risk is
 *   `..`; that, `.`, and an empty segment return null so the caller can fall
 *   back to cwd-local storage.
 */
export function resolveRepoProjectIdentity(
  name: string,
  cwd: string
): { owner: string; repo: string } | null {
  const parsed = parseOwnerRepo(name);
  if (parsed) return parsed;
  const repo = basename(cwd);
  if (repo === '' || repo === '.' || repo === '..') return null;
  return { owner: '_local', repo };
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
 * Restrict a workflow name or scope key to a single filesystem-safe path
 * segment. Any character outside `[a-zA-Z0-9_-]` becomes `_`, so a stray
 * separator or `..` can never escape the scopes directory. Distinct inputs can
 * collide (e.g. `a.b` and `a_b`) — scope dirs hold per-node files keyed by node
 * id, so a collision co-mingles two scopes' artifacts rather than corrupting
 * either. Falls back to `'_'` for an empty input.
 */
export function sanitizeScopeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.length > 0 ? safe : '_';
}

/**
 * The storage identity of a project, in the exact three shapes Archon can
 * resolve. This is the *one* key the whole codebase derives output paths from:
 * a registered repo (`owner/repo` or the `_local/<basename>` pseudo-owner), a
 * folder project (`_folder/<slug>`), or an unregistered working directory
 * (`@cwd/<basename>-<digest>`).
 *
 * It exists because the identity → storage rule was previously implemented
 * three times at three different levels of correctness (the executor handled
 * all kinds, the CLI's `continue` handled two, the two HTTP artifact routes
 * handled one), so a folder project's artifacts were unreachable from the
 * console while the run wrote them happily to disk (#2200).
 */
export type ProjectStorageKey =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'folder'; slug: string }
  | { kind: 'cwd'; cwd: string };

/**
 * The output roots every project kind has. Composed from one project root so
 * the tree is identical no matter which key resolved it.
 */
export interface ProjectStoragePaths {
  /** `~/.archon/workspaces/<...>/` — the project root all output hangs off. */
  root: string;
  /** Parent of the `runs/` and `scopes/` layouts. */
  artifactsRoot: string;
  /** Directory holding `<run-id>.jsonl` execution logs. */
  logsDir: string;
  /** `$STATE_DIR` — per-PROJECT cross-run state, shared by every workflow. */
  stateRoot: string;
  /**
   * Parent of the `runs/<run-id>/` layout holding each run's frozen workflow source.
   *
   * A sibling of `artifactsRoot`, deliberately not inside it: `$ARTIFACTS_DIR` is the
   * run's output channel, handed to every node and listed for humans, and the frozen
   * pack is neither an output nor something a node should be able to reach by that
   * path.
   */
  workflowSourceRoot: string;
}

/**
 * Resolve the {@link ProjectStorageKey} for a codebase row (or its absence).
 * This is the single source of truth that keeps the executor, both HTTP
 * artifact routes, and the CLI in agreement about where a run's output lives.
 *
 * Branch order matches what registration writes to disk:
 * - `kind: 'folder'` → `_folder/<slug>`, slugified from the display name
 *   ({@link slugifyFolderName}); folder projects never have an `owner/repo`
 *   name.
 * - anything else (including a NULL/absent `kind` on rows created before the
 *   column existed) → repo-kind, via {@link resolveRepoProjectIdentity}, which
 *   is the only thing that bridges the DB's bare basename for no-remote local
 *   repos to the `_local/<basename>` pseudo-owner on disk.
 * - no codebase, or a name+cwd that resolves to nothing → the unregistered
 *   working directory itself.
 *
 * Takes a structural value object rather than a `Codebase` row type on purpose:
 * `@archon/paths` has zero `@archon/*` dependencies and must stay that way.
 */
export function resolveProjectStorageKey(
  codebase: { kind?: string | null; name: string; default_cwd: string } | null | undefined,
  cwd: string
): ProjectStorageKey {
  if (codebase) {
    if (codebase.kind === 'folder') {
      return { kind: 'folder', slug: slugifyFolderName(codebase.name) };
    }
    const identity = resolveRepoProjectIdentity(codebase.name, codebase.default_cwd);
    if (identity) {
      return { kind: 'repo', owner: identity.owner, repo: identity.repo };
    }
  }
  return { kind: 'cwd', cwd };
}

/**
 * Compose the output roots for a storage key. Every kind resolves UNDER
 * `ARCHON_HOME` — including `'cwd'`, which maps to the `@cwd` namespace.
 *
 * The `'cwd'` mapping is deliberately external: the engine used to write an unregistered
 * run's artifacts and logs to `<cwd>/.archon/`, i.e. into the user's repository, where a
 * worktree teardown destroyed them and `git status` showed them. Relocating it is a breaking
 * change accepted in #2200 so that EVERY run's output is retrievable from one tree.
 *
 * An unregistered directory keys on a lexical SHA-256 of `resolve(cwd)`: pass a
 * {@link canonicalizeProjectPath} path to match the CLI's key. `@` starts no repo
 * owner, and 190 basename bytes + '-' + 64 hex digits fit a 255-byte name.
 */
export function getProjectStoragePaths(key: ProjectStorageKey): ProjectStoragePaths {
  let root: string;
  switch (key.kind) {
    case 'repo':
      root = getProjectRoot(key.owner, key.repo);
      break;
    case 'folder':
      root = getFolderProjectRoot(key.slug);
      break;
    case 'cwd': {
      const cwd = resolve(key.cwd);
      const name = sanitizeScopeSegment(basename(cwd)).slice(0, 190);
      root = getProjectRoot('@cwd', `${name}-${createHash('sha256').update(cwd).digest('hex')}`);
      break;
    }
  }
  return getStoragePathsForRoot(root);
}

/**
 * The project key a storage root is filed under: its path below the workspaces
 * directory with `/` separators (`owner/repo`, `_folder/<slug>`, `@cwd/<basename>-<digest>`).
 * Project-scoped state documents use it as their identity, so every surface that
 * names a project derives it here. A root outside the workspaces directory has
 * no key and throws rather than yielding a `..` path.
 */
export function projectKeyForStorageRoot(root: string): string {
  const workspaces = getArchonWorkspacesPath();
  if (!isPathInside(workspaces, root))
    throw new Error(`Project storage root is not inside the workspaces directory: ${root}`);
  return relative(resolve(workspaces), resolve(root)).split('\\').join('/');
}

/** {@link projectKeyForStorageRoot} for a codebase row, or for an unregistered `cwd`. */
export function projectKeyForCodebase(
  codebase: { kind?: string | null; name: string; default_cwd: string } | null | undefined,
  cwd: string
): string {
  return projectKeyForStorageRoot(
    getProjectStoragePaths(resolveProjectStorageKey(codebase, cwd)).root
  );
}

/**
 * Compose the output roots from an already-resolved project root — the branch
 * taken when a run recorded its `output_root` at start and must NOT re-derive
 * identity (a renamed codebase would otherwise orphan its artifacts, #1192).
 * Shares the layout rule with {@link getProjectStoragePaths} so a persisted root
 * and a freshly-derived one can never disagree about where `artifacts/` lives.
 *
 * Callers passing a value that came from the DB must gate it on
 * {@link isInsideArchonHome} first — this function is a pure composer and
 * trusts its input.
 */
export function getStoragePathsForRoot(root: string): ProjectStoragePaths {
  return {
    root,
    artifactsRoot: join(root, 'artifacts'),
    logsDir: join(root, 'logs'),
    stateRoot: join(root, 'state'),
    workflowSourceRoot: join(root, 'workflow-source'),
  };
}

// =============================================================================
// Folder-project ("_folder") path functions
// =============================================================================
//
// Folder projects (kind: 'folder') run without Archon-managed git — a multi-repo root
// or a plain ops folder. They run in place at their real directory, so there is
// no `source/` symlink and no `worktrees/` directory. Their named artifact and
// log storage lives under a `_folder` pseudo-owner, mirroring the `_local`
// pseudo-owner convention used for locally-registered repos.

/**
 * Slugify a folder-project display name into a filesystem-safe segment.
 * Lowercases, keeps `[a-z0-9._-]`, collapses any other run of characters to a
 * single `-`, and trims leading/trailing `-`. The result always satisfies
 * {@link SAFE_NAME}. Falls back to `'folder'` when the name slugifies to empty
 * (e.g. a name that is entirely separators or unicode).
 *
 * Distinct display names can slugify alike (e.g. "My App" and "my-app" both →
 * "my-app"); registration suffixes a new project's name until its slug is free.
 */
export function slugifyFolderName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 && SAFE_NAME.test(slug) ? slug : 'folder';
}

/**
 * Get the project root directory for a folder project.
 * Returns: ~/.archon/workspaces/_folder/<slug>/
 */
export function getFolderProjectRoot(slug: string): string {
  return join(getArchonWorkspacesPath(), '_folder', slug);
}

/**
 * Get the artifacts directory for a folder project.
 * Returns: ~/.archon/workspaces/_folder/<slug>/artifacts/
 */
export function getFolderProjectArtifactsPath(slug: string): string {
  return join(getFolderProjectRoot(slug), 'artifacts');
}

/**
 * Get the logs directory for a folder project.
 * Returns: ~/.archon/workspaces/_folder/<slug>/logs/
 */
export function getFolderProjectLogsPath(slug: string): string {
  return join(getFolderProjectRoot(slug), 'logs');
}

/**
 * Ensure the on-disk storage directories for a folder project exist.
 * Creates artifacts/ and logs/ under _folder/<slug>/ (no source/ or worktrees/ —
 * folder projects run at their real path and are never git-isolated).
 */
export async function ensureFolderProjectStructure(slug: string): Promise<void> {
  const dirs = [getFolderProjectArtifactsPath(slug), getFolderProjectLogsPath(slug)];
  await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })));
}

/** A project's `source` path already holds something other than the requested checkout. */
export class ProjectSourceOccupiedError extends Error {
  constructor(
    readonly sourcePath: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectSourceOccupiedError';
  }
}

/**
 * Create the project directory structure (source/, worktrees/, artifacts/, logs/).
 * Safe to call multiple times - uses recursive mkdir.
 */
export async function ensureProjectStructure(owner: string, repo: string): Promise<void> {
  const source = getProjectSourcePath(owner, repo);
  const dirs = [
    getProjectWorktreesPath(owner, repo),
    getProjectArtifactsPath(owner, repo),
    getProjectLogsPath(owner, repo),
  ];

  await Promise.all([
    mkdir(source, { recursive: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new ProjectSourceOccupiedError(
          source,
          `Source path at ${source} is occupied by a file or broken link`
        );
      }
      throw error;
    }),
    ...dirs.map(dir => mkdir(dir, { recursive: true })),
  ]);
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

  const stats = await lstat(linkPath).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return null;
  });
  if (stats?.isSymbolicLink()) {
    const existing = await readlink(linkPath);
    if (normalize(existing) === normalize(targetPath)) return;
    throw new ProjectSourceOccupiedError(
      linkPath,
      `Source symlink at ${linkPath} already points to ${existing}, expected ${targetPath}`
    );
  }
  if (stats) {
    if (!stats.isDirectory()) {
      throw new ProjectSourceOccupiedError(
        linkPath,
        `Source path at ${linkPath} already contains a file; expected ${targetPath}`
      );
    }
    const entries = await readdir(linkPath);
    if (entries.length > 0) {
      if ((await realpath(linkPath)) === (await realpath(targetPath))) return;
      throw new ProjectSourceOccupiedError(
        linkPath,
        `Source directory at ${linkPath} already contains another checkout; expected ${targetPath}`
      );
    }
  }

  // Remove the empty directory created by ensureProjectStructure (force handles ENOENT)
  await rm(linkPath, { recursive: true, force: true });
  await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}
