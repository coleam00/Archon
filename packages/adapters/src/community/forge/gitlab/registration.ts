import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { resolveSavedCheckout } from '@archon/core/services/registration-remote';
import * as codebaseDb from '@archon/core/db/codebases';
import { getCommandFolderSearchPaths, getProjectSourcePath } from '@archon/paths';
import { getLog } from './log';

export async function getOrCreateCodebaseForRepo(
  gitlabUrl: string,
  projectPath: string
): Promise<{
  codebase: { id: string; name: string; default_cwd: string };
  repoPath: string;
  isNew: boolean;
}> {
  const repoUrlNoGit = `${gitlabUrl}/${projectPath}`;
  const repoUrlWithGit = `${repoUrlNoGit}.git`;

  let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
  existing ??= await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);

  // Canonical path uses the project source/ subdirectory so that worktrees/,
  // artifacts/, and logs/ live as siblings of the cloned repo (not nested
  // inside it). For nested GitLab namespaces (group/subgroup/repo), the
  // namespace becomes the owner, the leaf segment becomes the repo. Mirrors
  // the CLI /clone path; see issue #1547.
  const segments = projectPath.split('/');
  const gitlabRepo = segments[segments.length - 1];
  const gitlabOwner = segments.slice(0, -1).join('/');
  const canonicalPath = getProjectSourcePath(gitlabOwner, gitlabRepo);

  if (existing) {
    const checkout = await resolveSavedCheckout(
      existing,
      repoUrlNoGit,
      'Restoring its original checkout preserves its storage. Before using /update-project to move it, identify and migrate its existing storage root; see the legacy nested GitLab recovery guidance in Troubleshooting.'
    );
    if (checkout !== existing.default_cwd) {
      await codebaseDb.updateCodebase(existing, { default_cwd: checkout });
      existing.default_cwd = checkout;
      getLog().info(
        { codebaseName: existing.name, canonicalPath: checkout },
        'gitlab.stale_worktree_path_fixed'
      );
    }

    getLog().info(
      { codebaseName: existing.name, path: existing.default_cwd },
      'gitlab.existing_codebase_found'
    );
    return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
  }

  const codebase = await codebaseDb.createManagedCodebase({
    name: projectPath,
    repository_url: repoUrlNoGit,
    default_cwd: canonicalPath,
  });

  getLog().info(
    { codebaseName: codebase.name, path: codebase.default_cwd },
    'gitlab.codebase_created'
  );
  return { codebase, repoPath: codebase.default_cwd, isNew: true };
}

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
      getLog().info({ commandCount: files.length, folder }, 'gitlab.commands_loaded');
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        continue;
      }
      getLog().error({ err, folder, errorCode: err.code }, 'gitlab.commands_load_error');
      continue;
    }
  }
}
