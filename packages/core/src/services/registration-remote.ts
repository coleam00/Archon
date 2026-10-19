import { existsSync, type Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { execFileAsync, getDefaultRemote, isWorktreePath, toRepoPath } from '@archon/git';
import { createLogger, getProjectSourcePath, parseOwnerRepo } from '@archon/paths';
import { loadRepoConfig } from '../config/config-loader';
import type { Codebase } from '../schemas/codebase';
import {
  remoteIdentity,
  resolveRegistrationUrl,
  storageRoot,
  type ProjectIdentity,
} from './project-registration-identity';

export class ProjectRegistrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectRegistrationError';
  }
}

export async function registrationRemotes(path: string): Promise<{
  selected: string | null;
  names: string[];
}> {
  const config = await loadRepoConfig(path).catch((error: unknown) => {
    throw new ProjectRegistrationError(
      `Cannot read registration config at ${path}/.archon/config.yaml: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  });
  const selected = config.worktree?.remote?.trim() || (await getDefaultRemote(toRepoPath(path)));
  if (selected) return { selected, names: [] };
  const { stdout } = await execFileAsync('git', ['-C', path, 'remote']);
  const names = stdout
    .split(/\r?\n/)
    .map(name => name.trim())
    .filter(Boolean);
  return { selected: null, names };
}

export async function effectiveRegistrationUrl(
  path: string,
  remote: string
): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['-C', path, 'remote', 'get-url', remote]);
  return stdout.trim() ? resolveRegistrationUrl(stdout.trim(), path) : null;
}

/**
 * A saved checkout belongs to a repository when any of its remotes points there.
 * Registration stores the URL of the remote worktree.remote selects at that
 * time. A project registered earlier, or under another selection, still owns a
 * checkout whose config now selects a different remote, so any remote with the
 * routed identity proves ownership. A registered path may be a subdirectory
 * of its checkout; `requireRoot` refuses one for paths that must be a clone root.
 */
export async function assertCheckoutRemote(
  path: string,
  remoteUrl: string,
  requireRoot = false
): Promise<void> {
  try {
    if (requireRoot) {
      // Git would otherwise read the remotes of a checkout that encloses path.
      const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-prefix']);
      if (stdout.trim()) throw new Error(`${path} is not the root of a Git checkout.`);
    }
    const expected = await remoteIdentity(remoteUrl, path);
    const { stdout } = await execFileAsync('git', ['-C', path, 'remote']);
    const names = stdout.split(/\r?\n/).map(name => name.trim());
    const observed = new Set<string>();
    for (const name of names) {
      if (!name) continue;
      const url = (
        await execFileAsync('git', ['-C', path, 'remote', 'get-url', name])
      ).stdout.trim();
      if (!url) continue;
      const identity = await remoteIdentity(resolveRegistrationUrl(url, path), path);
      if (identity === expected) return;
      observed.add(identity);
    }
    if (observed.size) {
      // Registrations save either requested or already-expanded URLs. Keep direct
      // matches above. A command-local remote preserves rewrite spelling without
      // letting Git interpret a relative URL as an existing remote's name.
      let expansionRemote = 'archon-ownership';
      while (names.includes(expansionRemote)) expansionRemote += '-';
      const { stdout: expanded } = await execFileAsync('git', [
        '-C',
        path,
        '-c',
        `remote.${expansionRemote}.url=${remoteUrl.trim()}`,
        'ls-remote',
        '--get-url',
        '--',
        expansionRemote,
      ]);
      if (expanded.trim() && observed.has(await remoteIdentity(expanded.trim(), path))) return;
    }
    throw new Error('No checkout remote matches the registered repository.');
  } catch (error) {
    throw new ProjectRegistrationError(
      `Cannot verify checkout ownership at ${path}. ` +
        'Restore its original checkout or use /update-project to set its path explicitly.',
      { cause: error }
    );
  }
}

/**
 * Verify a project's saved checkout with {@link assertCheckoutRemote}. A path
 * confirmed missing has nothing to verify, nor has the empty managed source/
 * that project setup creates before the first clone (or a failed clone leaves
 * behind). A non-empty managed source must be its own clone. A path that cannot
 * be inspected has unknown ownership and is refused.
 */
export async function assertSavedCheckoutRemote(
  path: string,
  remoteUrl: string,
  managedSource: string | null
): Promise<void> {
  const isManagedSource = managedSource !== null && resolve(path) === resolve(managedSource);
  const checkout = isManagedSource ? resolve(path) : path;
  let target: Stats | null;
  try {
    target = await inspectPath(checkout);
  } catch (error) {
    throw new ProjectRegistrationError(
      `Cannot verify checkout ownership at ${path}. Restore its original checkout or use /update-project to set its path explicitly.`,
      { cause: error }
    );
  }
  if (!target) return;
  if (isManagedSource && (await readdir(checkout)).length === 0) return;
  await assertCheckoutRemote(checkout, remoteUrl, isManagedSource);
}

/** Null only when the path is confirmed absent; any other inspection failure throws. */
async function inspectPath(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The checkout forge events use for a saved project. A saved path that is a
 * worktree, or a worktrees/ path whose checkout is gone, is stale: the
 * project's managed source replaces it once that source proves ownership.
 * Managed spellings are normalized. Callers persist a returned path that
 * differs from the saved one.
 */
export async function resolveSavedCheckout(
  project: Pick<Codebase, 'name' | 'default_cwd'>,
  remoteUrl: string,
  recovery = 'Restore its original checkout or use /update-project to set its path explicitly.'
): Promise<string> {
  const identity = parseOwnerRepo(project.name);
  const managedSource = identity && getProjectSourcePath(identity.owner, identity.repo);
  const saved = project.default_cwd;
  if (managedSource !== null && resolve(saved) === resolve(managedSource)) {
    await assertSavedCheckoutRemote(saved, remoteUrl, managedSource);
    return resolve(saved);
  }
  const stale =
    (await isWorktreePath(saved)) ||
    (/[\\/]worktrees[\\/]/.test(saved) && !existsSync(join(saved, '.git')));
  if (!stale) {
    await assertSavedCheckoutRemote(saved, remoteUrl, managedSource);
    return saved;
  }
  if (!managedSource) {
    throw new ProjectRegistrationError(
      `Cannot safely repair checkout for project "${project.name}" at ${saved}. ${recovery}`
    );
  }
  await assertSavedCheckoutRemote(managedSource, remoteUrl, managedSource);
  return managedSource;
}

async function readableRemoteIdentity(project: ProjectIdentity): Promise<string | null> {
  if (project.kind === 'folder') return null;
  try {
    // Older chat registrations omitted repository_url even for remote-backed repos. Git
    // would resolve a relative stored path against this process's directory instead.
    let url = project.repository_url;
    if (!url && isAbsolute(project.default_cwd)) {
      // A checkout with several remotes and none selected registers without a URL
      // and owns none of them: matching every remote would reroute forge events.
      const { selected } = await registrationRemotes(project.default_cwd);
      url = selected ? await effectiveRegistrationUrl(project.default_cwd, selected) : null;
    }
    return url ? await remoteIdentity(url, project.default_cwd) : null;
  } catch (error) {
    // An unreadable checkout has unknown ownership; it must not veto other projects.
    const unavailable = new ProjectRegistrationError(
      `Cannot verify the remote owned by project "${project.name}" at ${project.default_cwd}. ` +
        'Restore access to that checkout or repair it with /update-project. ' +
        `Remote error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
    createLogger('registration.remote').warn(
      { err: unavailable },
      'registration.lookup_legacy_unavailable'
    );
    return null;
  }
}

type RemoteOwnerCandidate = ProjectIdentity & Pick<Codebase, 'created_at'>;

/**
 * The project that owns a remote. Older binaries could register one remote
 * several times; those rows keep routing to the oldest one, and registration
 * refuses the remote as owned by it.
 */
export async function findRemoteOwner<T extends RemoteOwnerCandidate>(
  registered: readonly T[],
  remoteUrl: string,
  cwd = process.cwd()
): Promise<T | null> {
  return remoteIdentityOwner(registered, await remoteIdentity(remoteUrl, cwd));
}

async function remoteIdentityOwner<T extends RemoteOwnerCandidate>(
  registered: readonly T[],
  identity: string
): Promise<T | null> {
  const owners: T[] = [];
  for (const project of registered) {
    if ((await readableRemoteIdentity(project)) === identity) owners.push(project);
  }
  owners.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (owners.length > 1) {
    createLogger('registration.remote').warn(
      { owners: owners.map(project => ({ name: project.name, path: project.default_cwd })) },
      'registration.remote_duplicate_owners'
    );
  }
  return owners[0] ?? null;
}

export async function assertProjectRegistrationAvailable(
  project: ProjectIdentity,
  registered: readonly RemoteOwnerCandidate[]
): Promise<void> {
  const identity =
    project.kind === 'folder'
      ? null
      : project.repository_url
        ? await remoteIdentity(project.repository_url, project.default_cwd)
        : await readableRemoteIdentity(project);
  if (identity) {
    const existing = await remoteIdentityOwner(registered, identity);
    if (existing) {
      throw new ProjectRegistrationError(
        `Project "${existing.name}" is already registered at ${existing.default_cwd}. ` +
          'Two clones of one remote cannot be separate projects; use worktrees for parallel checkouts.'
      );
    }
  }
  const name = project.name.toLowerCase();
  const root = storageRoot(project).toLowerCase();
  const conflict = registered.find(
    existing => existing.name.toLowerCase() === name || storageRoot(existing).toLowerCase() === root
  );
  if (conflict) {
    throw new ProjectRegistrationError(
      `Project storage for "${project.name}" is already owned by "${conflict.name}" at ${conflict.default_cwd}. ` +
        'Registration was refused; retry to allocate a free name.'
    );
  }
}
