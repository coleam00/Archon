/**
 * Standalone repository clone/register logic.
 * Extracted from command-handler.ts for reuse by REST endpoints.
 */
import {
  codebaseSourceSchema,
  type CodebaseSource,
  type ProjectBaseBranchInspection,
} from '../schemas/codebase';
import { loadRepoConfig } from '../config/config-loader';
import { access, rm, stat } from 'fs/promises';
import { join, basename, resolve } from 'path';
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
  getDefaultRemote,
  findRepoRoot,
  inspectRemoteBranches,
  validateBranchName,
  ConfiguredBaseBranchNotFoundError,
  InvalidBaseBranchError,
} from '@archon/git';
import { findCodebaseForCheckoutPath } from '../services/codebase-checkout-resolver';
import {
  allocateProjectName,
  remoteIdentity,
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
  parseOwnerRepo,
  resolveRepoProjectIdentity,
  slugifyFolderName,
} from '@archon/paths';
import { findCommandFiles } from '../utils/commands';
import { createLogger } from '@archon/paths';
import { resolveGitHubTokenFromEnv } from '../github-auth/config';
import type { IGitHubAppAuthProvider } from '../github-auth/types';
import { installCredentialHelper } from '../github-auth/credential-helper-install';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('clone');
  return cachedLog;
}

/**
 * Parse a URL safely, returning null for non-URL strings (e.g. bare host/path).
 */
function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

type BuildForgeCredentials = (token: string) => CloneCredentials;

const tokenAsUsername: BuildForgeCredentials = token => ({ username: token, password: '' });
const tokenAsOAuth2Password: BuildForgeCredentials = token => ({
  username: 'oauth2',
  password: token,
});

/** Forge auth config: how to resolve a token and turn it into clone credentials. */
interface ForgeAuthEntry {
  hostPattern: string;
  resolveToken: () => string | undefined;
  buildCredentials: BuildForgeCredentials;
}

/** Known exact-hostname → credential source + clone credential mappings. */
const FORGE_AUTH: ForgeAuthEntry[] = [
  {
    hostPattern: 'github.com',
    resolveToken: resolveGitHubTokenFromEnv,
    buildCredentials: githubTokenCredentials,
  },
  {
    hostPattern: 'gitlab.com',
    resolveToken: () => process.env.GITLAB_TOKEN,
    buildCredentials: tokenAsOAuth2Password,
  },
  {
    hostPattern: 'gitea.com',
    resolveToken: () => process.env.GITEA_TOKEN,
    buildCredentials: tokenAsUsername,
  },
];

/** Resolve forge-specific credentials without adding them to the repository URL. */
export function resolveForgeAuth(url: string): CloneCredentials | undefined {
  // Extract hostname from URL (or from bare host/path like "github.com/owner/repo")
  let hostname: string;
  const parsed = safeParseUrl(url);
  if (parsed) {
    hostname = parsed.hostname.toLowerCase();
  } else {
    // Bare host/path form: take everything before the first slash
    hostname = url.split('/')[0].toLowerCase();
  }
  const authority = parsed?.host.toLowerCase() ?? hostname;

  // 1. Exact known-host match
  for (const entry of FORGE_AUTH) {
    if (hostname === entry.hostPattern) {
      const token = entry.resolveToken();
      return token ? entry.buildCredentials(token) : undefined;
    }
  }

  // 2. Self-hosted: the clone authority must equal a configured *_URL authority.
  //    A hostname that merely looks like a forge (gitlab.attacker.example) gets no
  //    token, because anyone who can submit a clone URL controls that hostname.
  const URL_FORGE: {
    urlEnvVar: string;
    tokenEnvVar: string;
    buildCredentials: BuildForgeCredentials;
  }[] = [
    {
      urlEnvVar: 'GITEA_URL',
      tokenEnvVar: 'GITEA_TOKEN',
      buildCredentials: tokenAsUsername,
    },
    {
      urlEnvVar: 'GITLAB_URL',
      tokenEnvVar: 'GITLAB_TOKEN',
      buildCredentials: tokenAsOAuth2Password,
    },
    {
      urlEnvVar: 'FORGEJO_URL',
      tokenEnvVar: 'GITEA_TOKEN',
      buildCredentials: tokenAsUsername,
    },
  ];
  for (const entry of URL_FORGE) {
    const forgeUrl = process.env[entry.urlEnvVar];
    if (forgeUrl) {
      const forgeParsed = safeParseUrl(forgeUrl);
      if (forgeParsed?.host.toLowerCase() === authority) {
        const token = process.env[entry.tokenEnvVar];
        if (token) return entry.buildCredentials(token);
      }
    }
  }

  return undefined;
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
  if (!parsed || parsed.hostname !== 'github.com') return null;
  if (parsed.protocol === 'http:')
    throw new ProjectRegistrationError('GitHub App URLs require HTTPS.');
  if (parsed.protocol !== 'https:') return null;
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

export class ProjectRegistrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectRegistrationError';
  }
}

function rejectExistingChoice(options: RegistrationOptions): void {
  if (options.baseBranch !== undefined)
    throw new ProjectRegistrationError(
      '--base-branch applies only to initial registration. This project is already registered; use --base for a run override.'
    );
}

async function claimProjectName(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebases'>,
  project: ProjectIdentity
): Promise<string> {
  return allocateProjectName(project, await codebases.listCodebases());
}

async function findRegisteredRemote(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebases'>,
  remoteUrl: string
): Promise<Codebase | null> {
  const identity = remoteIdentity(remoteUrl);
  for (const project of await codebases.listCodebases()) {
    if (project.kind === 'folder') continue;
    let registeredUrl = project.repository_url;
    // Older chat registrations omitted repository_url even for remote-backed repos.
    if (!registeredUrl) {
      try {
        registeredUrl = await effectiveRegistrationUrl(project.default_cwd);
      } catch (error) {
        throw new ProjectRegistrationError(
          `Cannot verify the remote owned by project "${project.name}" at ${project.default_cwd}. ` +
            'Restore access to that checkout or repair it with /update-project before registering another repository. ' +
            `Git error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    if (registeredUrl && remoteIdentity(registeredUrl) === identity) return project;
  }
  return null;
}

async function effectiveRegistrationUrl(path: string): Promise<string | null> {
  const remote = await registrationRemote(path);
  if (!remote) return null;
  const { stdout } = await execFileAsync('git', ['-C', path, 'remote', 'get-url', remote]);
  return stdout.trim() || null;
}

async function registrationRemote(path: string): Promise<string | null> {
  const config = await loadRepoConfig(path);
  return config.worktree?.remote?.trim() || (await getDefaultRemote(toRepoPath(path)));
}

async function validateRegistrationChoice(
  path: string,
  options: RegistrationOptions
): Promise<void> {
  if (options.baseBranch === undefined) return;
  try {
    await validateBranchName(options.baseBranch);
  } catch (error) {
    if (error instanceof InvalidBaseBranchError) throw new ProjectRegistrationError(error.message);
    throw error;
  }
  const remote = await registrationRemote(path);
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
    if (
      validated.url.startsWith('/') ||
      validated.url.startsWith('~') ||
      validated.url.startsWith('.')
    )
      return inspectProjectBaseBranch({ path: validated.url });
    result = await inspectRemoteBranches({
      kind: 'url',
      url: validated.url,
      credentials: await repositoryCredentials(validated.url, options),
    });
  } else {
    const path = await canonicalizeProjectPath(source.path);
    const repoRoot = await findRepoRoot(path);
    if (!repoRoot) return { kind: 'folder' };
    const remote = await registrationRemote(path);
    if (!remote) {
      const { stdout } = await execFileAsync('git', ['-C', path, 'remote']);
      return {
        kind: 'repo',
        defaultBranch: null,
        reason: stdout.trim() ? 'ambiguous_remote' : 'no_remote',
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

/** Register a new repository or reload an existing project's commands. */
async function registerRepoAtPath(
  codebases: IWorkflowHostStore['codebases'],
  targetPath: string,
  name: string,
  repositoryUrl: string | null,
  existing: Codebase | null,
  options: RegistrationOptions
): Promise<RegisterResult> {
  if (existing) rejectExistingChoice(options);
  const codebase =
    existing ??
    (await codebases.createCodebase({
      name,
      repository_url: repositoryUrl ?? undefined,
      default_cwd: targetPath,
      default_branch: options.baseBranch ?? null,
    }));
  targetPath = existing?.default_cwd ?? targetPath;

  // Auto-load commands if found
  let commandsLoaded = 0;
  for (const folder of getCommandFolderSearchPaths()) {
    const commandPath = join(targetPath, folder);
    try {
      await access(commandPath);
    } catch {
      continue; // Folder doesn't exist, try next
    }
    // Command loading errors should NOT be swallowed
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
    repositoryUrl: existing ? existing.repository_url : repositoryUrl,
    defaultCwd: targetPath,
    defaultBranch: codebase.default_branch ?? null,
    commandCount: commandsLoaded,
    alreadyExisted: existing !== null,
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

/**
 * Clone a repository from a URL and register it in the supplied store.
 * Local paths (starting with /, ~, or .) are delegated to registerRepository
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
  if (repoUrl.startsWith('/') || repoUrl.startsWith('~') || repoUrl.startsWith('.')) {
    const resolvedPath = repoUrl.startsWith('~') ? expandTilde(repoUrl) : resolve(repoUrl);
    return registerRepository(codebases, resolvedPath, options);
  }

  const appSource = appRepository(repoUrl, options);
  const derived = deriveRepoCloneTarget(repoUrl);
  const { workingUrl } = derived;
  const urlNoGit = workingUrl.replace(/\.git$/, '');
  const existing =
    (await codebases.findCodebaseByRepoUrl(urlNoGit)) ??
    (await codebases.findCodebaseByRepoUrl(urlNoGit + '.git')) ??
    (await findRegisteredRemote(codebases, workingUrl));
  if (existing) {
    rejectExistingChoice(options);
    if (appSource) await setupAppRepository(existing.default_cwd);
    return registerRepoAtPath(
      codebases,
      existing.default_cwd,
      existing.name,
      workingUrl,
      existing,
      options
    );
  }

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
  let directoryExists = false;
  try {
    await access(join(targetPath, '.git'));
    directoryExists = true;
  } catch {
    // A missing checkout can be cloned; git reports other destination failures.
  }
  if (directoryExists) {
    throw new Error(
      `Directory already exists: ${targetPath}\n\nNo matching codebase found in database. Remove the directory and re-clone.`
    );
  }

  if (options.baseBranch !== undefined) {
    try {
      await validateBranchName(options.baseBranch);
    } catch (error) {
      if (error instanceof InvalidBaseBranchError)
        throw new ProjectRegistrationError(error.message);
      throw error;
    }
  }

  const credentials = await repositoryCredentials(workingUrl, options);

  // Create project structure (source/, worktrees/, artifacts/, logs/)
  await ensureProjectStructure(ownerName, repoName);

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

  try {
    getLog().debug({ path: targetPath }, 'safe_directory_added');
    if (appSource) await setupAppRepository(targetPath);
    await validateRegistrationChoice(targetPath, options);
  } catch (error) {
    // Any failure here leaves a clone with no registration, which would block a retry.
    await rm(targetPath, { recursive: true });
    throw error;
  }

  const result = await registerRepoAtPath(codebases, targetPath, name, workingUrl, null, options);
  getLog().info({ url: workingUrl, targetPath }, 'clone_completed');
  return result;
}

/**
 * Register an existing local repository in the supplied store (no git clone).
 */
export async function registerRepository(
  codebases: IWorkflowHostStore['codebases'],
  localPath: string,
  options: RegistrationOptions = {}
): Promise<RegisterResult> {
  localPath = await canonicalizeProjectPath(localPath);
  // Validate path exists and is a git repo
  try {
    await execFileAsync('git', ['-C', localPath, 'rev-parse', '--git-dir']);
  } catch (error) {
    throw new Error(`Path is not a git repository: ${localPath} (${(error as Error).message})`);
  }

  // Git's physical common directory proves linked-checkout ownership without
  // conflating separate clones, remotes, names, or branches (#1192).
  const existing = await findCodebaseForCheckoutPath(localPath, codebases);
  if (existing) {
    rejectExistingChoice(options);
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

  const remoteUrl = await effectiveRegistrationUrl(localPath);

  // Extract repo name from directory name
  const repoName = basename(localPath);

  // Try to build owner/repo name from remote URL
  let name = repoName;
  if (remoteUrl) {
    const cleaned = remoteUrl.replace(/\.git$/, '').replace(/\/+$/, '');
    let workingRemote = cleaned;
    const sshRemoteMatch = /^git@([^:]+):(.+)$/.exec(cleaned);
    if (sshRemoteMatch) {
      workingRemote = `https://${sshRemoteMatch[1]}/${sshRemoteMatch[2]}`;
    }
    const parts = workingRemote.split('/');
    const r = parts.pop();
    const o = parts.pop();
    if (o && r) {
      name = `${o}/${r}`;
    }
  }

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

  await validateRegistrationChoice(localPath, options);
  name = await claimProjectName(codebases, {
    kind: 'repo',
    name: options.name?.trim() || name,
    default_cwd: localPath,
  });

  // Create project structure and source symlink
  const identity = resolveRepoProjectIdentity(name, localPath);
  if (!identity)
    throw new ProjectRegistrationError(`Cannot derive project storage for ${localPath}`);
  const { owner: projOwner, repo: projRepo } = identity;
  await ensureProjectStructure(projOwner, projRepo);
  await createProjectSourceSymlink(projOwner, projRepo, localPath);
  getLog().info(
    { owner: projOwner, repo: projRepo, path: getProjectSourcePath(projOwner, projRepo) },
    'project_structure_created'
  );

  // default_cwd is the real local path (not the symlink)
  return registerRepoAtPath(codebases, localPath, name, remoteUrl, null, options);
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
