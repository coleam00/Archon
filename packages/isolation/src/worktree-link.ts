/**
 * Worktree file linking
 *
 * Symlinks git-ignored paths from a new worktree to the canonical repo, so every
 * worktree shares one copy of a large cache, log or metadata directory.
 *
 * POSIX only. Windows refuses `linkFiles` (see `assertLinkFilesSupported`).
 */

import { lstat, mkdir, readlink, stat, symlink, unlink } from 'fs/promises';
import { dirname, join } from 'path';

import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';

import { isPathWithinRoot, parseCopyFileEntry } from './worktree-copy';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('worktree-link');
  return cachedLog;
}

/**
 * Refuse a non-empty `worktree.linkFiles` on Windows. Without elevated rights
 * the only directory link Windows offers is a junction, and Git for Windows
 * treats a junction as a real directory: `git worktree remove`, or an agent's
 * `git clean -fdx` in the worktree, walks into it and deletes the shared
 * content in the canonical repo. Archon cannot guard the second, so it makes
 * no link at all.
 */
export function assertLinkFilesSupported(
  linkFiles: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32' || !linkFiles?.length) return;
  throw new Error(
    'worktree.linkFiles is not supported on Windows: a directory link there is a junction, ' +
      'which git treats as a real directory, so removing or cleaning the worktree would delete ' +
      'the shared content in the canonical repo. Remove worktree.linkFiles (copyFiles still works), ' +
      "or set linkFiles: [] in the project's .archon/config.yaml to turn off a global list."
  );
}

/**
 * Link each configured entry into the worktree. Each entry fails on its own and
 * is logged: a missing link costs speed, never correctness, so worktree creation
 * goes on.
 *
 * @returns The entries that are linked after this call, including links an
 *   earlier call already made.
 */
export async function linkWorktreeFiles(
  canonicalRepoPath: string,
  worktreePath: string,
  entries: string[]
): Promise<string[]> {
  const linked: string[] = [];
  for (const raw of entries) {
    let entry: string;
    try {
      // `cache/` names the same path as `cache`, and a symlink path cannot end in a separator.
      entry = parseCopyFileEntry(raw).source.replace(/[\\/]+$/, '');
    } catch (error) {
      getLog().error({ entry: raw, err: error }, 'invalid_config_entry');
      continue;
    }
    if (await linkWorktreeFile(canonicalRepoPath, worktreePath, entry)) linked.push(entry);
  }
  return linked;
}

async function linkWorktreeFile(
  canonicalRepoPath: string,
  worktreePath: string,
  entry: string
): Promise<boolean> {
  if (!isPathWithinRoot(canonicalRepoPath, entry) || !isPathWithinRoot(worktreePath, entry)) {
    getLog().error(
      { entry, canonicalRepoPath, worktreePath, reason: 'Link path escapes its root' },
      'path_traversal_blocked'
    );
    return false;
  }
  const source = join(canonicalRepoPath, entry);
  const destination = join(worktreePath, entry);

  try {
    // Never replace what is already there: a checked-out path, an earlier link,
    // or anything a setup step put in place.
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      if (existing.isSymbolicLink() && (await readlink(destination)) === source) {
        getLog().debug({ entry }, 'worktree_link_already_present');
        return true;
      }
      getLog().warn({ entry, destination }, 'worktree_link_skipped_exists');
      return false;
    }

    // A missing source becomes a directory now. Otherwise the first run's tool
    // would create a real, unshared directory in its worktree, and nothing would
    // ever be shared.
    await stat(source).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(source, { recursive: true });
    });

    await mkdir(dirname(destination), { recursive: true });
    // POSIX needs no link type; Windows never gets here (assertLinkFilesSupported).
    await symlink(source, destination);
  } catch (error) {
    getLog().error({ entry, source, destination, err: error }, 'worktree_link_failed');
    return false;
  }

  return keepIfIgnored(worktreePath, entry, destination);
}

/**
 * A link git does not ignore shows in `git status`, and an agent that commits
 * everything would commit an absolute symlink into the target repo. Git treats
 * a symlink as a file, so a directory-only pattern such as `cache/` does not
 * match it. Exit status 0 means ignored; anything else removes the link.
 */
async function keepIfIgnored(
  worktreePath: string,
  entry: string,
  destination: string
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', worktreePath, 'check-ignore', '-q', '--', entry], {
      timeout: 10000,
    });
    getLog().debug({ entry }, 'worktree_file_linked');
    return true;
  } catch (error) {
    await unlink(destination).catch((unlinkError: unknown) => {
      getLog().error({ entry, destination, err: unlinkError }, 'worktree_link_remove_failed');
    });
    getLog().warn(
      {
        entry,
        err: error,
        fix: `Ignore the path itself in .gitignore (\`${entry}\`), not only as a directory (\`${entry}/\`): git sees a symlink as a file`,
      },
      'worktree_link_not_ignored'
    );
    return false;
  }
}
