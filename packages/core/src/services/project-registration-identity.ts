import {
  canonicalizeProjectPath,
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

export async function isCheckoutRegistered(
  path: string,
  registered: readonly Pick<ProjectIdentity, 'default_cwd'>[]
): Promise<boolean> {
  const checkout = await canonicalizeProjectPath(path);
  for (const project of registered) {
    const cwd = await canonicalizeProjectPath(project.default_cwd);
    if (
      isPathInside(checkout, cwd, { includeRoot: true }) ||
      isPathInside(cwd, checkout, { includeRoot: true })
    )
      return true;
  }
  return false;
}

export function assertProjectRegistrationAvailable(
  project: ProjectIdentity,
  registered: readonly ProjectIdentity[]
): void {
  const remote = project.kind !== 'folder' && project.repository_url;
  const remoteOwner =
    remote &&
    registered.find(
      existing =>
        existing.kind !== 'folder' &&
        existing.repository_url &&
        remoteIdentity(existing.repository_url) === remoteIdentity(remote)
    );
  if (remoteOwner) {
    throw new Error(
      `Project "${remoteOwner.name}" is already registered at ${remoteOwner.default_cwd}. ` +
        'Two clones of one remote cannot be separate projects; use worktrees for parallel checkouts.'
    );
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

/** Compare transport spellings without conflating hosts, ports or case-sensitive repo paths. */
export function remoteIdentity(url: string): string {
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
