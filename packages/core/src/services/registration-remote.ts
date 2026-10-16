import { execFileAsync, getDefaultRemote, toRepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';
import { loadRepoConfig } from '../config/config-loader';
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
  const config = await loadRepoConfig(path, { strict: true }).catch((error: unknown) => {
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

export function ambiguousRegistrationRemote(
  path: string,
  names: readonly string[]
): ProjectRegistrationError {
  return new ProjectRegistrationError(
    `Cannot select a remote for ${path}: ${names.join(', ')}. Set worktree.remote in .archon/config.yaml before registering this repository.`
  );
}

export async function registrationRemote(path: string): Promise<string | null> {
  const { selected, names } = await registrationRemotes(path);
  if (!selected && names.length > 0) throw ambiguousRegistrationRemote(path, names);
  return selected;
}

export async function effectiveRegistrationUrl(
  path: string,
  remote?: string
): Promise<string | null> {
  const selected = remote ?? (await registrationRemote(path));
  if (!selected) return null;
  const { stdout } = await execFileAsync('git', ['-C', path, 'remote', 'get-url', selected]);
  return stdout.trim() ? resolveRegistrationUrl(stdout.trim(), path) : null;
}

export async function assertCheckoutRemote(path: string, remoteUrl: string): Promise<void> {
  try {
    const checkoutUrl = await effectiveRegistrationUrl(path);
    if (
      !checkoutUrl ||
      (await remoteIdentity(checkoutUrl, path)) !== (await remoteIdentity(remoteUrl))
    ) {
      throw new Error('Checkout remote does not match the registered repository.');
    }
  } catch (error) {
    throw new ProjectRegistrationError(
      `Cannot verify checkout ownership at ${path}. ` +
        'Restore its original checkout or use /update-project to set its path explicitly.',
      { cause: error }
    );
  }
}

async function readableRemoteIdentity(project: ProjectIdentity): Promise<string | null> {
  if (project.kind === 'folder') return null;
  try {
    // Older chat registrations omitted repository_url even for remote-backed repos.
    const url = project.repository_url || (await effectiveRegistrationUrl(project.default_cwd));
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

/** The project that owns a remote; registration refuses a remote that several rows claim. */
export async function findRegisteredRemote<T extends ProjectIdentity>(
  registered: readonly T[],
  remoteUrl: string,
  cwd = process.cwd()
): Promise<T | null> {
  return soleRemoteIdentityOwner(registered, await remoteIdentity(remoteUrl, cwd));
}

/**
 * Routing fallback after an exact stored-URL match missed. Older binaries could
 * register one remote twice, so a remote several rows claim routes nowhere
 * rather than failing every event; registering it again is then refused.
 */
export async function findRoutableRemoteOwner<T extends ProjectIdentity>(
  registered: readonly T[],
  remoteUrl: string
): Promise<T | null> {
  const owners = await remoteIdentityOwners(registered, await remoteIdentity(remoteUrl));
  return owners.length === 1 ? (owners[0] ?? null) : null;
}

async function remoteIdentityOwners<T extends ProjectIdentity>(
  registered: readonly T[],
  identity: string
): Promise<T[]> {
  const owners: T[] = [];
  for (const project of registered) {
    if ((await readableRemoteIdentity(project)) === identity) owners.push(project);
  }
  return owners;
}

async function soleRemoteIdentityOwner<T extends ProjectIdentity>(
  registered: readonly T[],
  identity: string
): Promise<T | null> {
  const owners = await remoteIdentityOwners(registered, identity);
  if (owners.length > 1) {
    throw new ProjectRegistrationError(
      `Multiple projects own this remote: ${owners.map(project => `"${project.name}" at ${project.default_cwd}`).join(', ')}. Remove the duplicate registrations with /remove-project before continuing.`
    );
  }
  return owners[0] ?? null;
}

export async function assertProjectRegistrationAvailable(
  project: ProjectIdentity,
  registered: readonly ProjectIdentity[]
): Promise<void> {
  const identity =
    project.kind === 'folder'
      ? null
      : project.repository_url
        ? await remoteIdentity(project.repository_url, project.default_cwd)
        : await readableRemoteIdentity(project);
  if (identity) {
    const existing = await soleRemoteIdentityOwner(registered, identity);
    if (existing) {
      throw new ProjectRegistrationError(
        `Project "${existing.name}" is already registered at ${existing.default_cwd}. ` +
          'Two clones of one remote cannot be separate projects; use worktrees for parallel checkouts.'
      );
    }
  }
  const root = storageRoot(project).toLowerCase();
  const conflict = registered.find(
    existing => existing.name === project.name || storageRoot(existing).toLowerCase() === root
  );
  if (conflict) {
    throw new ProjectRegistrationError(
      `Project storage for "${project.name}" is already owned by "${conflict.name}" at ${conflict.default_cwd}. ` +
        'Registration was refused; retry to allocate a free name.'
    );
  }
}
