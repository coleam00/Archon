import { execFileAsync, getDefaultRemote, toRepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';
import { loadRepoConfig } from '../config/config-loader';
import type { Codebase } from '../schemas/codebase';
import { remoteIdentity, resolveRegistrationUrl } from './project-registration-identity';

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

export async function findRegisteredRemote(
  registered: readonly Codebase[],
  remoteUrl: string,
  purpose: 'lookup' | 'registration' = 'lookup',
  cwd = process.cwd()
): Promise<Codebase | null> {
  const identity = await remoteIdentity(remoteUrl, cwd);
  const matches: Codebase[] = [];
  const failures: ProjectRegistrationError[] = [];
  for (const project of registered) {
    if (project.kind === 'folder') continue;
    try {
      // Older chat registrations omitted repository_url even for remote-backed repos.
      const registeredUrl =
        project.repository_url || (await effectiveRegistrationUrl(project.default_cwd));
      if (
        registeredUrl &&
        (await remoteIdentity(registeredUrl, project.default_cwd)) === identity
      ) {
        matches.push(project);
      }
    } catch (error) {
      failures.push(
        new ProjectRegistrationError(
          `Cannot verify the remote owned by project "${project.name}" at ${project.default_cwd}. ` +
            'Restore access to that checkout or repair it with /update-project before registering another repository. ' +
            `Remote error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      );
    }
  }
  if (matches.length > 1) {
    throw new ProjectRegistrationError(
      `Multiple projects own this remote: ${matches.map(project => `"${project.name}" at ${project.default_cwd}`).join(', ')}. Repair the registrations with /update-project before continuing.`
    );
  }
  // Routing a readable owner does not claim new storage. Readable legacy
  // duplicates still make routing ambiguous; unreadable unrelated rows do not.
  if (failures.length && (purpose === 'registration' || matches.length === 0)) throw failures[0];
  for (const error of failures) {
    createLogger('registration.remote').warn(
      { err: error },
      'registration.lookup_legacy_unavailable'
    );
  }
  return matches[0] ?? null;
}
