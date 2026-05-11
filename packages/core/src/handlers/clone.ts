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
  commandCount: number;
  alreadyExisted: boolean;
}

/**
 * Shared logic: register a repo at a given path in the DB and load commands.
 */
async function registerRepoAtPath(
  targetPath: string,
  name: string,
  repositoryUrl: string | null
): Promise<RegisterResult> {
  // Auto-detect assistant type based on SDK folder conventions.
  // Built-in providers use well-known folders (.claude/, .codex/).
  // Falls back to first registered built-in provider if no folder detected.
  const { getRegisteredProviders } = await import('@archon/providers');
  const defaultProvider = getRegisteredProviders().find(p => p.builtIn)?.id ?? 'claude';
  let suggestedAssistant = defaultProvider;
  const codexFolder = join(targetPath, '.codex');
  const claudeFolder = join(targetPath, '.claude');

  try {
    await access(codexFolder);
    suggestedAssistant = 'codex';
    getLog().debug({ path: codexFolder }, 'assistant_detected_codex');
  } catch {
    try {
      await access(claudeFolder);
      suggestedAssistant = 'claude';
      getLog().debug({ path: claudeFolder }, 'assistant_detected_claude');
    } catch {
      getLog().debug({ provider: defaultProvider }, 'assistant_default_from_registry');
    }
  }

  // Check if a codebase with this name already exists (dedup by project identity)
  const existing = await codebaseDb.findCodebaseByName(name);
  if (existing) {
    // Determine if the new path is "better" (local > archon-managed clone)
    const isNewPathLocal = !targetPath.includes('/.archon/workspaces/');
    const isExistingPathManaged = existing.default_cwd.includes('/.archon/workspaces/');
    const shouldUpdateCwd = isNewPathLocal && isExistingPathManaged;

    const updates: { default_cwd?: string; repository_url?: string | null } = {};
    if (shouldUpdateCwd) {
      updates.default_cwd = targetPath;
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
      commandCount: commandsLoaded,
      alreadyExisted: true,
    };
  }

  // No existing codebase — create new
  const codebase = await codebaseDb.createCodebase({
    name,
    repository_url: repositoryUrl ?? undefined,
    default_cwd: targetPath,
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
  if (normalizedUrl.startsWith('git@github.com:')) {
    workingUrl = normalizedUrl.replace('git@github.com:', 'https://github.com/');
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

  // Build clone command with authentication if GitHub token is available
  let cloneUrl = workingUrl;
  const ghToken = process.env.GH_TOKEN;

  if (ghToken && workingUrl.includes('github.com')) {
    if (workingUrl.startsWith('https://github.com')) {
      cloneUrl = workingUrl.replace('https://github.com', `https://${ghToken}@github.com`);
    } else if (workingUrl.startsWith('http://github.com')) {
      cloneUrl = workingUrl.replace('http://github.com', `https://${ghToken}@github.com`);
    } else if (!workingUrl.startsWith('http')) {
      cloneUrl = `https://${ghToken}@${workingUrl}`;
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
    if (cleaned.startsWith('git@github.com:')) {
      workingRemote = cleaned.replace('git@github.com:', 'https://github.com/');
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
