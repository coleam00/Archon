import { randomUUID } from 'node:crypto';
import { realpath, rename, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitCheckoutIdentity, GitFailure } from '@archon/git';
import {
  createLogger,
  isPathInside,
  getProjectStoragePaths,
  resolveProjectStorageKey,
  parseOwnerRepo,
  toSafeNameSegment,
} from '@archon/paths';
import type { Codebase } from '../schemas/codebase';

export type ProjectIdentity = Pick<Codebase, 'kind' | 'name' | 'default_cwd'> &
  Partial<Pick<Codebase, 'repository_url'>>;

export function storageRoot(project: ProjectIdentity): string {
  return getProjectStoragePaths(resolveProjectStorageKey(project, project.default_cwd)).root;
}

async function existingPhysicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function isCheckoutRegistered(
  path: string,
  registered: RegisteredProjects
): Promise<boolean> {
  const checkout = (await existingPhysicalPath(path)) ?? resolve(path);
  for (const project of registered) {
    if (await projectClaimsCheckout(project, checkout)) return true;
  }
  return false;
}

type RegisteredProjects = readonly Pick<ProjectIdentity, 'kind' | 'name' | 'default_cwd'>[];

/**
 * `locked` holds the registration lock and calls `detachIfUnregistered` once it may read the
 * registrations; an unregistered checkout moves to a hidden sibling no registration names.
 * `remove` deletes the moved checkout after `locked` settles, also when `locked` rejects after
 * the move: moving it back could replace a checkout registered at `path` once the lock is gone.
 */
export async function removeCheckoutUnlessRegistered(
  path: string,
  remove: (detached: string) => Promise<void>,
  locked: (
    detachIfUnregistered: (readRegistered: () => Promise<RegisteredProjects>) => Promise<void>
  ) => Promise<unknown>
): Promise<void> {
  let detached: string | undefined;
  try {
    await locked(async readRegistered => {
      // SQLite may replay a transaction after COMMIT; the checkout must move only once.
      if (detached) return;
      if (!(await isCheckoutRegistered(path, await readRegistered()))) {
        detached = await detachCheckout(path);
      }
    });
  } catch (error) {
    if (!detached) throw error;
    const moved = detached;
    await remove(moved).catch((removeError: unknown) => {
      throw new AggregateError(
        [error, removeError],
        `${errorMessage(error)} Removing the checkout detached to ${moved} also failed: ${errorMessage(removeError)}`,
        { cause: error }
      );
    });
    throw error;
  }
  if (detached) await remove(detached);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A same-directory rename is one short step under the registration lock, so the slow
 * recursive delete can run after it.
 */
async function detachCheckout(path: string): Promise<string> {
  const checkout = resolve(path);
  const detached = join(dirname(checkout), `.${basename(checkout)}.removing-${randomUUID()}`);
  await rename(checkout, detached);
  return detached;
}

/**
 * A project claims a checkout that contains, or sits inside, its path, and a repository
 * also claims the Git directories its checkout keeps elsewhere.
 */
async function projectClaimsCheckout(
  project: Pick<ProjectIdentity, 'kind' | 'name' | 'default_cwd'>,
  checkout: string
): Promise<boolean> {
  // An invalid relative stored path names no checkout; resolving it would claim this process's directory.
  if (!isAbsolute(project.default_cwd)) return false;
  const physicalCwd = await readablePhysicalPath(project);
  const cwd = physicalCwd ?? resolve(project.default_cwd);
  if (
    isPathInside(checkout, cwd, { includeRoot: true }) ||
    isPathInside(cwd, checkout, { includeRoot: true })
  )
    return true;
  if (project.kind === 'folder' || !physicalCwd) return false;
  const metadata = await readableGitMetadata(physicalCwd);
  return metadata.some(dir => isPathInside(checkout, dir, { includeRoot: true }));
}

/**
 * A registered project's physical path. An unreadable path is compared lexically
 * instead: one broken project must not block cleanup for every other checkout.
 */
async function readablePhysicalPath(
  project: Pick<ProjectIdentity, 'name' | 'default_cwd'>
): Promise<string | null> {
  try {
    return await existingPhysicalPath(project.default_cwd);
  } catch (error) {
    createLogger('registration.identity').warn(
      { err: error, project: project.name, path: project.default_cwd },
      'registration.checkout_identity_unavailable'
    );
    return null;
  }
}

/** A registered checkout's Git directories, which a linked worktree keeps outside itself. */
async function readableGitMetadata(cwd: string): Promise<string[]> {
  try {
    const identity = await getGitCheckoutIdentity(cwd);
    return await Promise.all([identity.gitDir, identity.commonGitDir].map(dir => realpath(dir)));
  } catch (error) {
    // The project's own path is still protected by the containment check; its broken
    // Git metadata must not block cleanup for every other checkout.
    createLogger('registration.identity').warn(
      { err: error, path: cwd },
      'registration.checkout_identity_unavailable'
    );
    return [];
  }
}

/**
 * The `n`th candidate name for a project. A repo's storage root comes from an
 * `owner/repo` name, or from its folder name when the name is bare, so a repo
 * suffix is written as a safe `owner/repo` pair (bare names under `_local`) for
 * the root to move with it.
 */
function candidateName(kind: Codebase['kind'], derived: string, n: number): string {
  if (n === 1) return derived;
  if (kind === 'folder') return `${derived}-${n}`;
  const { owner, repo } = parseOwnerRepo(derived) ?? { owner: '_local', repo: derived };
  return `${owner}/${toSafeNameSegment(repo)}-${n}`;
}

export function allocateProjectName(
  project: ProjectIdentity,
  registered: readonly ProjectIdentity[]
): string {
  // Chat finds a project by name case-insensitively, and workspace storage may
  // live on a case-insensitive filesystem.
  const names = new Set(registered.map(codebase => codebase.name.toLowerCase()));
  const roots = new Set(registered.map(project => storageRoot(project).toLowerCase()));
  for (let n = 1; ; n++) {
    const name = candidateName(project.kind, project.name, n);
    if (
      !names.has(name.toLowerCase()) &&
      !roots.has(storageRoot({ ...project, name }).toLowerCase())
    )
      return name;
  }
}

export function resolveRegistrationUrl(url: string, cwd: string): string {
  const value = url.trim();
  if (value.startsWith('file:')) return fileURLToPath(value);
  if (isAbsolute(value)) return resolve(value);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^[^/]+:/.test(value)) return resolve(cwd, value);
  return value;
}

async function localRemoteIdentity(path: string): Promise<string> {
  // Local targets without a repository retain their path identity: Git may
  // rewrite that spelling to a repository elsewhere. Access errors still surface.
  const physicalPath = await existingPhysicalPath(path);
  if (!physicalPath) return `file:${path}`;
  if (!(await stat(physicalPath)).isDirectory()) return `file:${physicalPath}`;
  try {
    const { commonGitDir } = await getGitCheckoutIdentity(physicalPath);
    return `file:${await realpath(commonGitDir)}`;
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'not_repository')
      return `file:${physicalPath}`;
    throw error;
  }
}

/** Compare transport spellings without conflating hosts, ports or case-sensitive repo paths. */
export async function remoteIdentity(url: string, cwd = process.cwd()): Promise<string> {
  url = resolveRegistrationUrl(url, cwd);
  if (isAbsolute(url)) return localRemoteIdentity(url);
  const cleaned = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const scp = !cleaned.includes('://') ? /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(cleaned) : null;
  let parsed: URL | undefined;
  try {
    parsed = new URL(cleaned);
  } catch {
    // SCP-style and local Git remotes need no URL parser.
  }
  const host = (scp?.[1] ?? parsed?.host ?? '').toLowerCase();
  const path = scp?.[2] ?? parsed?.pathname.replace(/^\//, '') ?? cleaned;
  return `${host}/${host === 'github.com' ? path.toLowerCase() : path}`;
}
