import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitCheckoutIdentity } from '@archon/git';
import {
  createLogger,
  isPathInside,
  getProjectStoragePaths,
  resolveProjectStorageKey,
  parseOwnerRepo,
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

export async function isCheckoutRegistered(
  path: string,
  registered: readonly Pick<ProjectIdentity, 'kind' | 'name' | 'default_cwd'>[]
): Promise<boolean> {
  const checkout = (await existingPhysicalPath(path)) ?? resolve(path);
  for (const project of registered) {
    const physicalCwd = await readablePhysicalPath(project);
    const cwd = physicalCwd ?? resolve(project.default_cwd);
    if (
      isPathInside(checkout, cwd, { includeRoot: true }) ||
      isPathInside(cwd, checkout, { includeRoot: true })
    )
      return true;
    if (project.kind !== 'folder' && physicalCwd) {
      for (const metadata of await readableGitMetadata(physicalCwd)) {
        if (isPathInside(checkout, metadata, { includeRoot: true })) return true;
      }
    }
  }
  return false;
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
  return `${owner}/${repo.replace(/[^a-zA-Z0-9._-]/g, '-')}-${n}`;
}

export function allocateProjectName(
  project: ProjectIdentity,
  registered: readonly ProjectIdentity[]
): string {
  const names = new Set(registered.map(codebase => codebase.name));
  // Workspace storage may live on a case-insensitive filesystem.
  const roots = new Set(registered.map(project => storageRoot(project).toLowerCase()));
  for (let n = 1; ; n++) {
    const name = candidateName(project.kind, project.name, n);
    if (!names.has(name) && !roots.has(storageRoot({ ...project, name }).toLowerCase()))
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

/** Compare transport spellings without conflating hosts, ports or case-sensitive repo paths. */
export async function remoteIdentity(url: string, cwd = process.cwd()): Promise<string> {
  url = resolveRegistrationUrl(url, cwd);
  // Missing local targets retain their stored spelling; access errors must surface.
  if (isAbsolute(url)) {
    const physicalPath = await existingPhysicalPath(url);
    if (!physicalPath) return `file:${url}`;
    if (!(await stat(physicalPath)).isDirectory()) return `file:${physicalPath}`;
    const { commonGitDir } = await getGitCheckoutIdentity(physicalPath);
    return `file:${await realpath(commonGitDir)}`;
  }
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
