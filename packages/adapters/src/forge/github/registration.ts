import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { resolveSavedCheckout } from '@archon/core/services/registration-remote';
import * as codebaseDb from '@archon/core/db/codebases';
import { getCommandFolderSearchPaths, getProjectSourcePath } from '@archon/paths';
import { getLog } from './log';

/**
 * Get or create codebase for repository
 * Returns: codebase record, path to use, and whether it's new
 * Always uses canonical path (not worktree paths) for codebase registration
 */
export async function getOrCreateCodebaseForRepo(
  webUrl: string,
  owner: string,
  repo: string
): Promise<{
  codebase: { id: string; name: string; default_cwd: string };
  repoPath: string;
  isNew: boolean;
}> {
  // Try both with and without .git suffix to match existing clones
  const repoUrlNoGit = `${webUrl}/${owner}/${repo}`;
  const repoUrlWithGit = `${repoUrlNoGit}.git`;

  let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
  existing ??= await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);

  // Canonical path uses the project source/ subdirectory so that worktrees/,
  // artifacts/, and logs/ live as siblings of the cloned repo (not nested
  // inside it). Mirrors the CLI /clone path; see issue #1547.
  const canonicalPath = getProjectSourcePath(owner, repo);

  if (existing) {
    const checkout = await resolveSavedCheckout(existing, repoUrlNoGit);
    if (checkout !== existing.default_cwd) {
      await codebaseDb.updateCodebase(existing, { default_cwd: checkout });
      existing.default_cwd = checkout;
      getLog().info(
        { codebaseName: existing.name, canonicalPath: checkout },
        'github.stale_worktree_path_fixed'
      );
    }

    getLog().info(
      { codebaseName: existing.name, path: existing.default_cwd },
      'github.existing_codebase_found'
    );
    return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
  }

  const codebase = await codebaseDb.createManagedCodebase({
    name: `${owner}/${repo}`,
    repository_url: repoUrlNoGit, // Store without .git for consistency
    default_cwd: canonicalPath,
  });

  getLog().info(
    { codebaseName: codebase.name, path: codebase.default_cwd },
    'github.codebase_created'
  );
  return { codebase, repoPath: codebase.default_cwd, isNew: true };
}

/**
 * Auto-detect and load commands from .archon/commands/ (or configured folder)
 */
export async function autoDetectAndLoadCommands(
  repoPath: string,
  codebaseId: string
): Promise<void> {
  const commandFolders = getCommandFolderSearchPaths();

  for (const folder of commandFolders) {
    try {
      const fullPath = join(repoPath, folder);
      await access(fullPath);

      const files = (await readdir(fullPath)).filter(f => f.endsWith('.md'));
      if (files.length === 0) continue;

      const commands = await codebaseDb.getCodebaseCommands(codebaseId);
      files.forEach(file => {
        commands[file.replace('.md', '')] = {
          path: join(folder, file),
          description: `From ${folder}`,
        };
      });

      await codebaseDb.updateCodebaseCommands(codebaseId, commands);
      getLog().info({ commandCount: files.length, folder }, 'github.commands_loaded');
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // Folder not existing is expected - silently continue to next folder
      if (err.code === 'ENOENT') {
        continue;
      }
      // Log unexpected errors (database failures, permission issues) but don't fail setup
      getLog().error({ err, folder, errorCode: err.code }, 'github.commands_load_error');
      continue;
    }
  }
}
