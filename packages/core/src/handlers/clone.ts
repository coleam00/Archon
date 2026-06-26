/**
 * Standalone repository clone/register logic.
 * Extracted from command-handler.ts for reuse by REST endpoints.
 */
import { access, rm } from 'fs/promises';
import { join, basename, resolve } from 'path';
import * as codebaseDb from '../db/codebases';
import { sanitizeError } from '../utils/credential-sanitizer';
import { execFileAsync } from '@archon/git';
import {
  expandTilde,
  getCommandFolderSearchPaths,
  ensureProjectStructure,
  getProjectSourcePath,
  createProjectSourceSymlink,
  parseOwnerRepo,
} from '@archon/paths';
import { findMarkdownFilesRecursive } from '../utils/commands';
import { createLogger } from '@archon/paths';
import { resolveDefaultAssistant } from '../config/resolve-assistant';

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

/** Forge auth config: which env var to check and what auth URL scheme to use. */
interface ForgeAuthEntry {
  hostPattern: string;
  envVar: string;
  /** URL user-info prefix (e.g. 'oauth2:' for GitLab, empty for GitHub). */
  scheme: string;
}

/** Known exact-hostname → env-var + scheme mappings. */
const FORGE_AUTH: ForgeAuthEntry[] = [
  { hostPattern: 'github.com', envVar: 'GH_TOKEN', scheme: '' },
  { hostPattern: 'gitlab.com', envVar: 'GITLAB_TOKEN', scheme: 'oauth2:' },
  { hostPattern: 'gitea.com', envVar: 'GITEA_TOKEN', scheme: '' },
];

/**
 * Resolve forge-specific authentication token and URL scheme for a repository URL.
 * Returns the token and auth scheme prefix, or empty values if no token is available.
 */
/** Well-known self-hosted hostname label patterns → env var + scheme. */
const SELF_HOSTED_FORGE: { label: string; envVar: string; scheme: string }[] = [
  { label: 'gitlab', envVar: 'GITLAB_TOKEN', scheme: 'oauth2:' },
  { label: 'gitea', envVar: 'GITEA_TOKEN', scheme: '' },
  { label: 'forgejo', envVar: 'GITEA_TOKEN', scheme: '' },
];

export function resolveForgeAuth(url: string): { token: string | undefined; scheme: string } {
  // Extract hostname from URL (or from bare host/path like "github.com/owner/repo")
  let hostname: string;
  const parsed = safeParseUrl(url);
  if (parsed) {
    hostname = parsed.hostname.toLowerCase();
  } else {
    // Bare host/path form: take everything before the first slash
    hostname = url.split('/')[0].toLowerCase();
  }

  // 1. Exact known-host match
  for (const entry of FORGE_AUTH) {
    if (hostname === entry.hostPattern) {
      const token = process.env[entry.envVar];
      if (token) {
        return { token, scheme: entry.scheme };
      }
      return { token: undefined, scheme: '' };
    }
  }

  // 2. Self-hosted: check if any hostname label matches a known forge name
  //    e.g. "gitlab.mycompany.com" has labels ["gitlab", "mycompany", "com"]
  const labels = hostname.split('.');
  for (const entry of SELF_HOSTED_FORGE) {
    if (labels.includes(entry.label)) {
      const token = process.env[entry.envVar];
      if (token) {
        return { token, scheme: entry.scheme };
      }
      return { token: undefined, scheme: '' };
    }
  }

  // 3. Explicit URL match: compare clone hostname against configured *_URL env vars.
  //    Handles self-hosted instances where the hostname doesn't contain a forge name
  //    (e.g. git.example.com with GITEA_URL=https://git.example.com).
  const URL_FORGE: { urlEnvVar: string; tokenEnvVar: string; scheme: string }[] = [
    { urlEnvVar: 'GITEA_URL', tokenEnvVar: 'GITEA_TOKEN', scheme: '' },
    { urlEnvVar: 'GITLAB_URL', tokenEnvVar: 'GITLAB_TOKEN', scheme: 'oauth2:' },
    { urlEnvVar: 'FORGEJO_URL', tokenEnvVar: 'GITEA_TOKEN', scheme: '' },
  ];
  for (const entry of URL_FORGE) {
    const forgeUrl = process.env[entry.urlEnvVar];
    if (forgeUrl) {
      const forgeParsed = safeParseUrl(forgeUrl);
      if (forgeParsed?.hostname.toLowerCase() === hostname) {
        const token = process.env[entry.tokenEnvVar];
        if (token) {
          return { token, scheme: entry.scheme };
        }
      }
    }
  }

  return { token: undefined, scheme: '' };
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

async function detectCurrentGitBranch(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', targetPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 }
    );
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Shared logic: register a repo at a given path in the DB and load commands.
 */
async function registerRepoAtPath(
  targetPath: string,
  name: string,
  repositoryUrl: string | null
): Promise<RegisterResult> {
  const suggestedAssistant = await resolveDefaultAssistant(targetPath);
  const detectedBranch = await detectCurrentGitBranch(targetPath);

  // Check if a codebase with this name already exists (dedup by project identity)
  const existing = await codebaseDb.findCodebaseByName(name);
  if (existing) {
    // Determine if the new path is "better" (local > archon-managed clone)
    const isNewPathLocal = !targetPath.includes('/.archon/workspaces/');
    const isExistingPathManaged = existing.default_cwd.includes('/.archon/workspaces/');
    const shouldUpdateCwd = isNewPathLocal && isExistingPathManaged;

    const updates: {
      default_cwd?: string;
      repository_url?: string | null;
      default_branch?: string | null;
    } = {};
    if (shouldUpdateCwd) {
      updates.default_cwd = targetPath;
      updates.default_branch = detectedBranch;
    } else if (!existing.default_branch && detectedBranch) {
      updates.default_branch = detectedBranch;
    }
    // Fill in repository_url if the existing record doesn't have one
    if (!existing.repository_url && repositoryUrl) {
      updates.repository_url = repositoryUrl;
    }
    if (Object.keys(updates).length > 0) {
      await codebaseDb.updateCodebase(existing.id, updates);
    }

    // Still reload commands for the existing codebase
    const effectiveCwd = shouldUpdateCwd ? targetPath : existing.default_cwd;
    const effectiveDefaultBranch =
      updates.default_branch !== undefined
        ? updates.default_branch
        : (existing.default_branch ?? null);
    let commandsLoaded = 0;
    for (const folder of getCommandFolderSearchPaths()) {
      const commandPath = join(effectiveCwd, folder);
      try {
        await access(commandPath);
      } catch {
        continue;
      }
      const markdownFiles = await findMarkdownFilesRecursive(commandPath);
      if (markdownFiles.length > 0) {
        const commands = { ...(await codebaseDb.getCodebaseCommands(existing.id)) };
        markdownFiles.forEach(({ commandName, relativePath }) => {
          commands[commandName] = {
            path: join(folder, relativePath),
            description: `From ${folder}`,
          };
        });
        await codebaseDb.updateCodebaseCommands(existing.id, commands);
        commandsLoaded = markdownFiles.length;
        break;
      }
    }

    return {
      codebaseId: existing.id,
      name: existing.name,
      repositoryUrl: existing.repository_url,
      defaultCwd: shouldUpdateCwd ? targetPath : existing.default_cwd,
      defaultBranch: effectiveDefaultBranch,
      commandCount: commandsLoaded,
      alreadyExisted: true,
    };
  }

  // No existing codebase — create new
  const codebase = await codebaseDb.createCodebase({
    name,
    repository_url: repositoryUrl ?? undefined,
    default_cwd: targetPath,
    default_branch: detectedBranch,
    ai_assistant_type: suggestedAssistant,
  });

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
    const markdownFiles = await findMarkdownFilesRecursive(commandPath);
    if (markdownFiles.length > 0) {
      const commands = { ...(await codebaseDb.getCodebaseCommands(codebase.id)) };
      markdownFiles.forEach(({ commandName, relativePath }) => {
        commands[commandName] = {
          path: join(folder, relativePath),
          description: `From ${folder}`,
        };
      });
      await codebaseDb.updateCodebaseCommands(codebase.id, commands);
      commandsLoaded = markdownFiles.length;
      break;
    }
  }

  return {
    codebaseId: codebase.id,
    name: codebase.name,
    repositoryUrl: repositoryUrl,
    defaultCwd: targetPath,
    defaultBranch: codebase.default_branch ?? null,
    commandCount: commandsLoaded,
    alreadyExisted: false,
  };
}

/**
 * Normalize a repo URL: strip trailing slashes and convert SSH to HTTPS.
 */
function normalizeRepoUrl(rawUrl: string): {
  workingUrl: string;
  ownerName: string;
  repoName: string;
  targetPath: string;
} {
  const normalizedUrl = rawUrl.replace(/\/+$/, '');

  let workingUrl = normalizedUrl;
  // Convert SSH URLs (git@host:owner/repo) to HTTPS for any host
  const sshMatch = /^git@([^:]+):(.+)$/.exec(normalizedUrl);
  if (sshMatch) {
    workingUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  const urlParts = workingUrl.replace(/\.git$/, '').split('/');
  const repoName = urlParts.pop() ?? 'unknown';
  const ownerName = urlParts.pop() ?? 'unknown';

  // Clone into project-centric source/ directory
  const targetPath = getProjectSourcePath(ownerName, repoName);

  return { workingUrl, ownerName, repoName, targetPath };
}

/**
 * Clone a repository from a URL and register it in the database.
 * Local paths (starting with /, ~, or .) are delegated to registerRepository
 * to avoid wrong owner/repo naming. See #383 for broader rethink.
 */
export async function cloneRepository(repoUrl: string): Promise<RegisterResult> {
  // Local paths should be registered (symlink), not cloned (copied)
  if (repoUrl.startsWith('/') || repoUrl.startsWith('~') || repoUrl.startsWith('.')) {
    const resolvedPath = repoUrl.startsWith('~') ? expandTilde(repoUrl) : resolve(repoUrl);
    return registerRepository(resolvedPath);
  }

  const { workingUrl, ownerName, repoName, targetPath } = normalizeRepoUrl(repoUrl);

  // Check if source directory already has a git repo
  let directoryExists = false;
  try {
    await access(join(targetPath, '.git'));
    directoryExists = true;
  } catch {
    // Directory doesn't exist or isn't a git repo, proceed with clone
  }

  if (directoryExists) {
    // Directory exists - try to find existing codebase by repo URL
    const urlNoGit = workingUrl.replace(/\.git$/, '');
    const urlWithGit = urlNoGit + '.git';

    const existingCodebase =
      (await codebaseDb.findCodebaseByRepoUrl(urlNoGit)) ??
      (await codebaseDb.findCodebaseByRepoUrl(urlWithGit));

    if (existingCodebase) {
      return {
        codebaseId: existingCodebase.id,
        name: existingCodebase.name,
        repositoryUrl: existingCodebase.repository_url,
        defaultCwd: existingCodebase.default_cwd,
        defaultBranch: existingCodebase.default_branch ?? null,
        commandCount: 0,
        alreadyExisted: true,
      };
    }

    // Directory exists but no codebase found
    throw new Error(
      `Directory already exists: ${targetPath}\n\nNo matching codebase found in database. Remove the directory and re-clone.`
    );
  }

  // Create project structure (source/, worktrees/, artifacts/, logs/)
  await ensureProjectStructure(ownerName, repoName);

  getLog().info({ url: workingUrl, targetPath }, 'clone_started');

  // Build clone command with authentication using forge-specific tokens
  let cloneUrl = workingUrl;
  const { token: forgeToken, scheme: authScheme } = resolveForgeAuth(workingUrl);

  if (forgeToken) {
    const parsed = safeParseUrl(workingUrl);
    if (parsed) {
      cloneUrl = `https://${authScheme}${forgeToken}@${parsed.hostname}${parsed.pathname}`;
    } else if (!workingUrl.startsWith('http')) {
      // Bare host/path form (e.g. github.com/owner/repo)
      cloneUrl = `https://${authScheme}${forgeToken}@${workingUrl}`;
    }
    getLog().debug('clone_authenticated');
  }

  // Remove the empty source/ directory before cloning (git clone requires non-existent target)
  try {
    await rm(targetPath, { recursive: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await execFileAsync('git', ['clone', cloneUrl, targetPath]);
  } catch (error) {
    const safeErr = sanitizeError(error as Error);
    throw new Error(`Failed to clone repository: ${safeErr.message}`);
  }

  // Add to git safe.directory
  await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', targetPath]);
  getLog().debug({ path: targetPath }, 'safe_directory_added');

  const result = await registerRepoAtPath(targetPath, `${ownerName}/${repoName}`, workingUrl);
  getLog().info({ url: workingUrl, targetPath }, 'clone_completed');
  return result;
}

/**
 * Register an existing local repository in the database (no git clone).
 */
export async function registerRepository(localPath: string): Promise<RegisterResult> {
  // Validate path exists and is a git repo
  try {
    await execFileAsync('git', ['-C', localPath, 'rev-parse', '--git-dir']);
  } catch (error) {
    throw new Error(`Path is not a git repository: ${localPath} (${(error as Error).message})`);
  }

  // Check if already registered by path
  const existing = await codebaseDb.findCodebaseByDefaultCwd(localPath);
  if (existing) {
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

  // Get remote URL (optional — local-only repos may not have one)
  let remoteUrl: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'remote', 'get-url', 'origin']);
    remoteUrl = stdout.trim() || null;
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (!msg.includes('No such remote')) {
      getLog().warn({ path: localPath, err: error }, 'remote_url_fetch_unexpected_error');
    }
  }

  // Extract repo name from directory name
  const repoName = basename(localPath);

  // Try to build owner/repo name from remote URL
  let name = repoName;
  let ownerName = '_local';
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
      ownerName = o;
    }
  }

  // Create project structure and source symlink
  const parsed = parseOwnerRepo(name);
  const projOwner = parsed?.owner ?? ownerName;
  const projRepo = parsed?.repo ?? repoName;
  await ensureProjectStructure(projOwner, projRepo);
  await createProjectSourceSymlink(projOwner, projRepo, localPath);
  getLog().info(
    { owner: projOwner, repo: projRepo, path: getProjectSourcePath(projOwner, projRepo) },
    'project_structure_created'
  );

  // default_cwd is the real local path (not the symlink)
  return registerRepoAtPath(localPath, name, remoteUrl);
}
