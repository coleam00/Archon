import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitCheckoutIdentity } from '@archon/git';
import {
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
  registered: readonly Pick<ProjectIdentity, 'kind' | 'default_cwd'>[]
): Promise<boolean> {
  const checkout = (await existingPhysicalPath(path)) ?? resolve(path);
  for (const project of registered) {
    const physicalCwd = await existingPhysicalPath(project.default_cwd);
    const cwd = physicalCwd ?? resolve(project.default_cwd);
    if (
      isPathInside(checkout, cwd, { includeRoot: true }) ||
      isPathInside(cwd, checkout, { includeRoot: true })
    )
      return true;
    if (project.kind !== 'folder' && physicalCwd) {
      const identity = await getGitCheckoutIdentity(physicalCwd);
      for (const metadata of [identity.gitDir, identity.commonGitDir]) {
        if (isPathInside(checkout, await realpath(metadata), { includeRoot: true })) return true;
      }
    }
  }
  return false;
}

export async function assertProjectRegistrationAvailable(
  project: ProjectIdentity,
  registered: readonly ProjectIdentity[]
): Promise<void> {
  const remote = project.kind !== 'folder' && project.repository_url;
  if (remote) {
    const identity = await remoteIdentity(remote, project.default_cwd);
    for (const existing of registered) {
      if (
        existing.kind !== 'folder' &&
        existing.repository_url &&
        (await remoteIdentity(existing.repository_url, existing.default_cwd)) === identity
      ) {
        throw new Error(
          `Project "${existing.name}" is already registered at ${existing.default_cwd}. ` +
            'Two clones of one remote cannot be separate projects; use worktrees for parallel checkouts.'
        );
      }
    }
  }
  const root = storageRoot(project).toLowerCase();
  const conflict = registered.find(
    existing => existing.name === project.name || storageRoot(existing).toLowerCase() === root
  );
  if (conflict) {
    throw new Error(
      `Project storage for "${project.name}" is already owned by "${conflict.name}" at ${conflict.default_cwd}. ` +
        'Registration was refused; retry to allocate a free name.'
    );
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
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(cleaned);
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
