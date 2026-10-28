/**
 * Standalone repository clone/register logic.
 * Extracted from command-handler.ts for reuse by REST endpoints.
 */
import {
  codebaseSourceSchema,
  type CodebaseSource,
  type ProjectBaseBranchInspection,
} from '../schemas/codebase';
import { access, rm, stat } from 'fs/promises';
import { join, basename, isAbsolute, resolve } from 'path';
import type { IWorkflowHostStore } from '../workflows/host-store';
import type { Codebase } from '../types';
import {
  cloneRepository as cloneGitRepository,
  execFileAsync,
  addSafeDirectory,
  toRepoPath,
  validateCloneUrl,
  type CloneCredentials,
  githubTokenCredentials,
  findRepoRoot,
  resolveGitHubHost,
  trustRegisteredPath,
  inspectRemoteBranches,
  validateBranchName,
  ConfiguredBaseBranchNotFoundError,
  InvalidBaseBranchError,
} from '@archon/git';
import {
  ProjectRegistrationError,
  assertCheckoutRemote,
  assertSavedCheckoutRemote,
  findRemoteOwner,
  effectiveRegistrationUrl,
  registrationRemotes,
} from '../services/registration-remote';
export { ProjectRegistrationError } from '../services/registration-remote';

import { findCodebaseForCheckoutPath } from '../services/codebase-checkout-resolver';
import { assertAbsoluteDefaultCwd } from '../utils/codebase-path';
import {
  allocateProjectName,
  type ProjectIdentity,
} from '../services/project-registration-identity';
import { quoteCommandArg } from '../utils/command-args';
import {
  expandTilde,
  canonicalizeProjectPath,
  getCommandFolderSearchPaths,
  ensureProjectStructure,
  ensureFolderProjectStructure,
  getFolderProjectRoot,
  getProjectSourcePath,
  createProjectSourceSymlink,
  ProjectSourceOccupiedError,
  parseOwnerRepo,
  resolveRepoProjectIdentity,
  slugifyFolderName,
} from '@archon/paths';
import { findCommandFiles } from '../utils/commands';
import { createLogger } from '@archon/paths';
import type { IGitHubAppAuthProvider } from '../github-auth/types';
import { installCredentialHelper } from '../github-auth/credential-helper-install';
import { resolveForgeAuth, safeParseUrl } from './forge-auth';
export { resolveForgeAuth } from './forge-auth';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('clone');
  return cachedLog;
}

export interface RegisterResult {
  codebaseId: string;
  name: string;
  repositoryUrl: string | null;
  defaultCwd: string;
  defaultBranch: string | null;
  commandCount: number;
  alreadyExisted: boolean;
}

export interface RegistrationOptions {
  name?: string;
  baseBranch?: string;
}

export interface CloneOptions extends RegistrationOptions {
  githubAppAuth?: Pick<IGitHubAppAuthProvider, 'getInstallationToken'>;
}

function appRepository(url: string, options: CloneOptions): { owner: string; repo: string } | null {
  if (!options.githubAppAuth) return null;
  const parsed = safeParseUrl(url);
  const github = new URL(resolveGitHubHost().webUrl);
  if (!parsed || parsed.host.toLowerCase() !== github.host) return null;
  if (parsed.protocol === 'http:' && github.protocol === 'https:')
    throw new ProjectRegistrationError('GitHub App URLs require HTTPS.');
  if (parsed.protocol !== github.protocol) return null;
  const identity = parseOwnerRepo(
    parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .slice(1)
  );
  if (!identity)
    throw new ProjectRegistrationError('GitHub App URLs must identify an owner/repository.');
  return identity;
}

async function repositoryCredentials(
  url: string,
  options: CloneOptions
): Promise<CloneCredentials | undefined> {
  const repository = appRepository(url, options);
  return repository && options.githubAppAuth
    ? githubTokenCredentials(
        await options.githubAppAuth.getInstallationToken(repository.owner, repository.repo)
      )
    : resolveForgeAuth(url);
}

async function setupAppRepository(path: string): Promise<void> {
  const result = await installCredentialHelper(path);
  if (result.kind === 'failed') {
    throw new Error(
      `GitHub App repository setup requires the credential helper: ${result.error.message}`,
      { cause: result.error }
    );
  }
}

/** A clone source that names a local directory, which registers in place instead of cloning. */
function localCloneSource(url: string): string | null {
  if (url.startsWith('~')) return expandTilde(url);
  return isAbsolute(url) || url.startsWith('.') ? resolve(url) : null;
}

function rejectExistingChoice(options: RegistrationOptions): void {
  if (options.baseBranch !== undefined)
    throw new ProjectRegistrationError(
      '--base-branch applies only to initial registration. This project is already registered; use --base for a run override.'
    );
}

function refuseOccupiedSource(error: unknown): never {
  if (!(error instanceof ProjectSourceOccupiedError)) throw error;
  throw new ProjectRegistrationError(
    `${error.message}. Inspect ${error.sourcePath} and repair the registration. ` +
      'Preserve the workspace state, artifacts and logs.',
    { cause: error }
  );
}

async function claimProjectName(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebaseClaims'>,
  project: ProjectIdentity
): Promise<string> {
  return allocateProjectName(project, await codebases.listCodebaseClaims());
}

async function findRegisteredRemote(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebaseClaims'>,
  remoteUrl: string
): Promise<Codebase | null> {
  const owner = await findRemoteOwner(await codebases.listCodebaseClaims(), remoteUrl);
  if (owner) assertAbsoluteDefaultCwd(owner.default_cwd, owner.name);
  return owner;
}

async function validateRegistrationChoice(
  path: string,
  options: RegistrationOptions
): Promise<void> {
  if (options.baseBranch === undefined) return;
  await validateBaseBranchSyntax(options.baseBranch);
  const { selected: remote } = await registrationRemotes(path);
  if (!remote) {
    getLog().warn({ path }, 'registration.base_branch_no_remote');
    return;
  }
  const result = await inspectRemoteBranches({ kind: 'local', repoPath: toRepoPath(path), remote });
  if (result.status === 'unavailable') {
    getLog().warn(
      { path, remote, evidence: result.evidence },
      'registration.base_branch_remote_unavailable'
    );
  } else if (!result.branches.some(branch => branch === options.baseBranch)) {
    throw new ConfiguredBaseBranchNotFoundError(options.baseBranch, remote);
  }
}

export type { ProjectBaseBranchInspection } from '../schemas/codebase';

export async function inspectProjectBaseBranch(
  source: CodebaseSource,
  options: CloneOptions = {}
): Promise<ProjectBaseBranchInspection> {
  source = codebaseSourceSchema.parse(source);
  let result;
  if (source.url !== undefined) {
    const validated = validateCloneUrl(source.url);
    if (!validated.ok) throw new ProjectRegistrationError(validated.error);
    const localPath = localCloneSource(validated.url);
    if (localPath) return inspectProjectBaseBranch({ path: localPath });
    result = await inspectRemoteBranches({
      kind: 'url',
      url: validated.url,
      credentials: await repositoryCredentials(validated.url, options),
    });
  } else {
    const path = await canonicalizeProjectPath(source.path);
    const repoRoot = await findRepoRoot(path);
    if (!repoRoot) return { kind: 'folder' };
    const { selected: remote, names } = await registrationRemotes(path);
    if (!remote) {
      return {
        kind: 'repo',
        defaultBranch: null,
        reason: names.length ? 'ambiguous_remote' : 'no_remote',
      };
    }
    result = await inspectRemoteBranches({ kind: 'local', repoPath: toRepoPath(path), remote });
  }
  if (result.status === 'unavailable') {
    getLog().warn({ evidence: result.evidence }, 'registration.prefill_remote_unavailable');
    return { kind: 'repo', defaultBranch: null, reason: 'remote_unavailable' };
  }
  return {
    kind: 'repo',
    defaultBranch: result.defaultBranch,
    reason: result.defaultBranch ? null : 'unknown_head',
  };
}

async function loadRepositoryCommands(
  codebases: IWorkflowHostStore['codebases'],
  codebase: Codebase,
  targetPath: string,
  repositoryUrl: string | null,
  alreadyExisted: boolean
): Promise<RegisterResult> {
  // Auto-load commands if found
  let commandsLoaded = 0;
  for (const folder of getCommandFolderSearchPaths()) {
    const commandPath = join(targetPath, folder);
    try {
      await access(commandPath);
    } catch (error) {
      // The project is already registered; an unreadable command folder only skips its commands.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        getLog().warn({ err: error, path: commandPath }, 'registration.command_folder_unavailable');
      }
      continue;
    }
    const markdownFiles = await findCommandFiles(commandPath);
    if (markdownFiles.length > 0) {
      const commands = { ...(await codebases.getCodebaseCommands(codebase.id)) };
      markdownFiles.forEach(({ commandName, relativePath }) => {
        commands[commandName] = {
          path: join(folder, relativePath),
          description: `From ${folder}`,
        };
      });
      await codebases.updateCodebaseCommands(codebase.id, commands);
      commandsLoaded = markdownFiles.length;
      break;
    }
  }

  return {
    codebaseId: codebase.id,
    name: codebase.name,
    repositoryUrl,
    defaultCwd: targetPath,
    defaultBranch: codebase.default_branch ?? null,
    commandCount: commandsLoaded,
    alreadyExisted,
  };
}

function deriveRepoCloneTarget(validatedUrl: string): {
  workingUrl: string;
  ownerName: string;
  repoName: string;
  targetPath: string;
} {
  const workingUrl = validatedUrl.replace(/\/+$/, '');

  const urlParts = workingUrl.replace(/\.git$/, '').split('/');
  const repoName = urlParts.pop() ?? 'unknown';
  const ownerName = urlParts.pop() ?? 'unknown';

  // Clone into project-centric source/ directory
  const targetPath = getProjectSourcePath(ownerName, repoName);

  return { workingUrl, ownerName, repoName, targetPath };
}

async function cloneCheckout(
  workingUrl: string,
  targetPath: string,
  credentials: CloneCredentials | undefined
): Promise<void> {
  await addSafeDirectory(toRepoPath(targetPath));
  const cloneResult = await cloneGitRepository(
    workingUrl,
    toRepoPath(targetPath),
    credentials ? { credentials } : undefined
  );
  if (!cloneResult.ok) {
    let detail: string;
    switch (cloneResult.error.code) {
      case 'not_a_repo':
        detail = 'Repository not found or unavailable. Check the URL and repository access.';
        break;
      case 'permission_denied':
        detail = 'Authentication failed. Check the configured forge token and repository access.';
        break;
      case 'no_space':
        detail = 'No space left at the clone destination.';
        break;
      case 'unknown':
        detail = cloneResult.error.message;
        break;
      default:
        detail = 'Git clone failed.';
        break;
    }
    throw new Error(`Failed to clone repository: ${detail}`);
  }
}

/** Reuse a registered checkout, recloning it only when it is the missing managed source. */
async function reuseRegisteredCheckout(
  codebases: IWorkflowHostStore['codebases'],
  existing: Codebase,
  workingUrl: string,
  options: CloneOptions,
  appSource: ReturnType<typeof appRepository>
): Promise<RegisterResult> {
  rejectExistingChoice(options);
  const identity = resolveRepoProjectIdentity(existing.name, existing.default_cwd);
  const managedSource = identity && getProjectSourcePath(identity.owner, identity.repo);
  const isManaged =
    managedSource !== null && resolve(existing.default_cwd) === resolve(managedSource);
  const checkoutPath = isManaged ? resolve(existing.default_cwd) : existing.default_cwd;
  let missing = false;
  try {
    await access(join(checkoutPath, '.git'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    missing = true;
  }
  if (missing) {
    if (!identity || !isManaged)
      throw new ProjectRegistrationError(
        `Project "${existing.name}" checkout is missing at ${existing.default_cwd}. Restore that checkout or repair its path with /update-project.`
      );
    const remoteUrl = existing.repository_url ?? workingUrl;
    await assertSavedCheckoutRemote(existing.default_cwd, remoteUrl, managedSource);
    const credentials = await repositoryCredentials(workingUrl, options);
    await ensureProjectStructure(identity.owner, identity.repo).catch(refuseOccupiedSource);
    await cloneCheckout(workingUrl, checkoutPath, credentials);
  } else if (existing.repository_url) {
    await assertSavedCheckoutRemote(existing.default_cwd, existing.repository_url, managedSource);
  }
  if (appSource) await setupAppRepository(checkoutPath);
  if (checkoutPath !== existing.default_cwd) {
    await codebases.updateCodebase(existing, { default_cwd: checkoutPath });
  }
  return loadRepositoryCommands(codebases, existing, checkoutPath, existing.repository_url, true);
}

async function assertCloneDestinationAvailable(targetPath: string): Promise<void> {
  let directoryExists = false;
  try {
    await access(join(targetPath, '.git'));
    directoryExists = true;
  } catch {
    // A missing checkout can be cloned; git reports other destination failures.
  }
  if (directoryExists) {
    throw new ProjectRegistrationError(
      `Directory already exists: ${targetPath}\n\nNo matching codebase found in database. Remove the directory and re-clone.`
    );
  }
}

async function validateBaseBranchSyntax(baseBranch: string | undefined): Promise<void> {
  if (baseBranch !== undefined) {
    try {
      await validateBranchName(baseBranch);
    } catch (error) {
      if (error instanceof InvalidBaseBranchError)
        throw new ProjectRegistrationError(error.message);
      throw error;
    }
  }
}

/**
 * Clone a repository from a URL and register it in the supplied store.
 * Local paths (absolute, or starting with ~ or .) are delegated to registerRepository
 * to avoid wrong owner/repo naming. See #383 for broader rethink.
 */
export async function cloneRepository(
  codebases: IWorkflowHostStore['codebases'],
  repoUrl: string,
  options: CloneOptions = {}
): Promise<RegisterResult> {
  const validatedUrl = validateCloneUrl(repoUrl);
  if (!validatedUrl.ok) {
    throw new Error(`Failed to clone repository: ${validatedUrl.error}`);
  }
  repoUrl = validatedUrl.url;

  // Local paths should be registered (symlink), not cloned (copied)
  const localPath = localCloneSource(repoUrl);
  if (localPath) return registerRepository(codebases, localPath, options);

  const appSource = appRepository(repoUrl, options);
  const derived = deriveRepoCloneTarget(repoUrl);
  const { workingUrl } = derived;
  const existing = await findRegisteredRemote(codebases, workingUrl);
  if (existing) return reuseRegisteredCheckout(codebases, existing, workingUrl, options, appSource);

  const name = await claimProjectName(codebases, {
    kind: 'repo',
    name: `${derived.ownerName}/${derived.repoName}`,
    default_cwd: derived.targetPath,
  });
  const { owner: ownerName, repo: repoName } = parseOwnerRepo(name) ?? {
    owner: derived.ownerName,
    repo: derived.repoName,
  };
  const targetPath = getProjectSourcePath(ownerName, repoName);
  await assertCloneDestinationAvailable(targetPath);
  await validateBaseBranchSyntax(options.baseBranch);

  const credentials = await repositoryCredentials(workingUrl, options);
  await ensureProjectStructure(ownerName, repoName).catch(refuseOccupiedSource);
  await cloneCheckout(workingUrl, targetPath, credentials);

  let codebase: Codebase;
  try {
    getLog().debug({ path: targetPath }, 'safe_directory_added');
    if (appSource) await setupAppRepository(targetPath);
    await validateRegistrationChoice(targetPath, options);
    codebase = await codebases.createCodebase({
      name,
      repository_url: workingUrl,
      default_cwd: targetPath,
      default_branch: options.baseBranch ?? null,
    });
  } catch (error) {
    // A failed delete leaves the checkout at its detached path, not at targetPath.
    let leftover = targetPath;
    try {
      await codebases.removeUnregisteredCheckout(targetPath, detached => {
        leftover = detached;
        return rm(detached, { recursive: true });
      });
    } catch (cleanupError) {
      getLog().error({ path: leftover, err: cleanupError }, 'registration.checkout_cleanup_failed');
      throw new AggregateError(
        [error, cleanupError],
        `${error instanceof Error ? error.message : String(error)} ` +
          `Checkout cleanup failed at ${leftover}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error }
      );
    }
    throw error;
  }

  const result = await loadRepositoryCommands(codebases, codebase, targetPath, workingUrl, false);
  getLog().info({ url: workingUrl, targetPath }, 'clone_completed');
  return result;
}

/** Register an existing local repository in the supplied store (no git clone). */
export async function registerRepository(
  codebases: IWorkflowHostStore['codebases'],
  localPath: string,
  options: RegistrationOptions = {}
): Promise<RegisterResult> {
  localPath = await canonicalizeProjectPath(localPath);
  await trustRegisteredPath(localPath);
  // Validate path exists and is a git repo
  try {
    await execFileAsync('git', ['-C', localPath, 'rev-parse', '--git-dir']);
  } catch (error) {
    throw new Error(`Path is not a git repository: ${localPath} (${(error as Error).message})`);
  }

  // Git's physical common directory proves linked-checkout ownership without
  // conflating separate clones, remotes, names, or branches (#1192).
  const existing = await findCodebaseForCheckoutPath(localPath, {
    findCodebaseByDefaultCwd: codebases.findCodebaseByDefaultCwd,
    listCodebaseClaims: codebases.listCodebaseClaims,
  });
  if (existing) {
    rejectExistingChoice(options);
    if (existing.repository_url)
      await assertCheckoutRemote(existing.default_cwd, existing.repository_url);
    return existingRegistration(existing);
  }

  const remoteUrl = await unclaimedRegistrationRemote(codebases, localPath);
  await validateRegistrationChoice(localPath, options);
  const name = await claimProjectName(codebases, {
    kind: 'repo',
    name: options.name?.trim() || registrationName(localPath, remoteUrl),
    default_cwd: localPath,
  });
  await createRegisteredProjectStorage(name, localPath);

  // default_cwd is the real local path (not the symlink)
  const codebase = await codebases.createCodebase({
    name,
    repository_url: remoteUrl ?? undefined,
    default_cwd: localPath,
    default_branch: options.baseBranch ?? null,
  });
  return loadRepositoryCommands(codebases, codebase, localPath, remoteUrl, false);
}

function existingRegistration(existing: Codebase): RegisterResult {
  return {
    codebaseId: existing.id,
    name: existing.name,
    repositoryUrl: existing.repository_url,
    defaultCwd: existing.default_cwd,
    defaultBranch: existing.default_branch ?? null,
    commandCount: 0,
    alreadyExisted: true,
  };
}

/**
 * The checkout's selected remote URL, or null when none is selected. Refuses a
 * remote another project already owns.
 */
async function unclaimedRegistrationRemote(
  codebases: IWorkflowHostStore['codebases'],
  localPath: string
): Promise<string | null> {
  const { selected, names } = await registrationRemotes(localPath);
  // With several remotes and none selected, the checkout registers without a
  // URL, as before remote selection existed. It is refused when another project
  // already owns one of its remotes, but it owns none of them itself, so a
  // later clone of one still registers separately.
  for (const remote of selected ? [] : names) {
    const url = await effectiveRegistrationUrl(localPath, remote);
    const owner = url && (await findRegisteredRemote(codebases, url));
    if (owner) {
      throw new ProjectRegistrationError(
        `Project "${owner.name}" is already registered at ${owner.default_cwd}. ` +
          'Two clones of one remote cannot be separate projects; use worktrees for parallel checkouts.'
      );
    }
  }
  if (!selected) return null;
  const remoteUrl = await effectiveRegistrationUrl(localPath, selected);
  const registeredRemote = remoteUrl ? await findRegisteredRemote(codebases, remoteUrl) : null;
  if (registeredRemote) {
    throw new ProjectRegistrationError(
      `Project "${registeredRemote.name}" is already registered at ${registeredRemote.default_cwd}, ` +
        `a different clone of the same remote than ${localPath}. Two clones of one remote ` +
        'cannot be separate projects: use worktrees for parallel checkouts (`git worktree add` ' +
        `from ${registeredRemote.default_cwd}, or run workflows with --branch). If this checkout ` +
        `replaces the registered one, run /update-project ${quoteCommandArg(registeredRemote.name)} ` +
        quoteCommandArg(localPath)
    );
  }
  return remoteUrl;
}

/** `owner/repo` from the remote URL, else the checkout's directory name. */
function registrationName(localPath: string, remoteUrl: string | null): string {
  if (!remoteUrl) return basename(localPath);
  const cleaned = remoteUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const sshRemoteMatch = /^git@([^:]+):(.+)$/.exec(cleaned);
  const workingRemote = sshRemoteMatch
    ? `https://${sshRemoteMatch[1]}/${sshRemoteMatch[2]}`
    : cleaned;
  const parts = workingRemote.split('/');
  const r = parts.pop();
  const o = parts.pop();
  return o && r ? `${o}/${r}` : basename(localPath);
}

/** Create the project structure and its source symlink to the real checkout. */
async function createRegisteredProjectStorage(name: string, localPath: string): Promise<void> {
  const identity = resolveRepoProjectIdentity(name, localPath);
  if (!identity)
    throw new ProjectRegistrationError(`Cannot derive project storage for ${localPath}`);
  const { owner: projOwner, repo: projRepo } = identity;
  await ensureProjectStructure(projOwner, projRepo).catch(refuseOccupiedSource);
  await createProjectSourceSymlink(projOwner, projRepo, localPath).catch(refuseOccupiedSource);
  getLog().info(
    { owner: projOwner, repo: projRepo, path: getProjectSourcePath(projOwner, projRepo) },
    'project_structure_created'
  );
}

/**
 * Build an accurate path-validation error from a `stat` failure —
 * `ENOENT` really is "does not exist", but `EACCES`/`ENOTDIR`/`ELOOP` are not,
 * and mislabeling them "Path does not exist" sends the user chasing a typo
 * instead of a permissions/symlink problem. The raw errno message is preserved.
 */
function pathValidationError(path: string, error: Error): Error {
  const reasonByCode: Record<string, string> = {
    EACCES: 'Permission denied',
    ENOTDIR: 'A path segment is not a directory',
    ELOOP: 'Too many symbolic links',
  };
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const reason = reasonByCode[code] ?? 'Path does not exist';
  return new Error(`${reason}: ${path} (${error.message})`);
}

/**
 * Register a folder project (`kind: 'folder'`). Archon applies no git machinery;
 * runs happen in place by default. The directory may or may not be a git
 * repository; git operations belong to the user and agent.
 *
 * Unlike {@link registerRepository}, this performs NO git validation and creates
 * NO `source/` symlink: a folder project runs in place at its real path. Named
 * artifact/log storage lives under `~/.archon/workspaces/_folder/<slug>/`.
 */
export async function registerFolder(
  codebases: IWorkflowHostStore['codebases'],
  localPath: string,
  name?: string,
  options: RegistrationOptions = {}
): Promise<RegisterResult> {
  if (options.baseBranch !== undefined)
    throw new ProjectRegistrationError(
      'Folder projects have no base branch; remove --base-branch.'
    );
  // `canonicalizeProjectPath` is the one canonicalizer for `default_cwd`; the CLI
  // gate, `archon doctor` and `/register-project` all resolve through it, so a
  // symlinked root (macOS `/tmp` → `/private/tmp`) or a Windows 8.3 short path
  // registers under exactly the string those lookups will ask for (#2927).
  const resolvedPath = await canonicalizeProjectPath(localPath);

  // The stat below is the existence gate: canonicalization is fail-safe and
  // returns the unresolved path, so a missing/unreadable path surfaces here with
  // its real errno rather than being registered. It also rejects a symlink to a
  // file, which realpath resolves happily (no git check on this path).
  let isDirectory = false;
  try {
    isDirectory = (await stat(resolvedPath)).isDirectory();
  } catch (error) {
    throw pathValidationError(resolvedPath, error as Error);
  }
  if (!isDirectory) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }

  // Already registered by path — return the existing record unchanged.
  const existing = await codebases.findCodebaseByDefaultCwd(resolvedPath);
  if (existing) {
    if (existing.kind !== 'folder') {
      throw new ProjectRegistrationError(
        `Project "${existing.name}" is already registered as a repo at ${resolvedPath}; cannot register it as a folder project.`
      );
    }
    rejectExistingChoice(options);
    return existingRegistration(existing);
  }

  const projectName = await claimProjectName(codebases, {
    kind: 'folder',
    name: name?.trim() || basename(resolvedPath),
    default_cwd: resolvedPath,
  });
  const slug = slugifyFolderName(projectName);

  // Create the _folder/<slug>/{artifacts,logs} storage structure (no source/,
  // no worktrees/ — folder projects are never git-isolated).
  await ensureFolderProjectStructure(slug);

  const codebase = await codebases.createCodebase({
    name: projectName,
    default_cwd: resolvedPath,
    kind: 'folder',
  });

  getLog().info(
    {
      name: projectName,
      path: resolvedPath,
      id: codebase.id,
      slug,
      storage: getFolderProjectRoot(slug),
    },
    'project.register_folder_completed'
  );

  return {
    codebaseId: codebase.id,
    name: codebase.name,
    repositoryUrl: null,
    defaultCwd: resolvedPath,
    defaultBranch: null,
    commandCount: 0,
    alreadyExisted: false,
  };
}
