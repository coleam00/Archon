import { existsSync } from 'fs';
import { join } from 'path';
import { BUNDLED_GIT_COMMIT, BUNDLED_IS_BINARY, createLogger } from '@archon/paths';
import { execFileAsync } from './exec';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/** The Archon checkout this package runs from, when Archon runs from source. */
const ARCHON_SOURCE_ROOT = join(import.meta.dir, '../../..');

/** Git variables that select a repository other than the one at git's working directory. */
const REPOSITORY_SELECTORS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
]);

/**
 * `env` without the variables that would point git at another repository than the one at
 * its working directory. A process can inherit them (a git hook exports `GIT_DIR` and
 * `GIT_INDEX_FILE`), and every git it spawns would then read or write that repository.
 * Names compare case-insensitively because Windows reads the environment that way.
 */
export function withoutRepositorySelectors(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !REPOSITORY_SELECTORS.has(key.toUpperCase()))
  );
}

export interface ArchonCommit {
  /** Short hash. */
  sha: string;
  /** Committer date (ISO 8601); null in a compiled binary, which embeds only the hash. */
  committedAt: string | null;
}

/**
 * The commit the running Archon came from: the build-time hash in a binary, the source
 * checkout's HEAD in source. Never the caller's working directory, which is usually some
 * other repository. A long-lived process should read it once at startup: the checkout can
 * move after the process loaded its code, and a later read would name code that is not
 * running. Undefined when there is no commit to name, such as a binary built without one or
 * a source tree without git metadata.
 */
export async function readArchonCommit(
  sourceRoot = ARCHON_SOURCE_ROOT
): Promise<ArchonCommit | undefined> {
  if (BUNDLED_IS_BINARY) {
    return BUNDLED_GIT_COMMIT === 'unknown'
      ? undefined
      : { sha: BUNDLED_GIT_COMMIT, committedAt: null };
  }
  // Git would otherwise walk up from a tree without its own `.git` (a directory, or a
  // worktree's file) and name the commit of whatever checkout encloses it.
  if (!existsSync(join(sourceRoot, '.git'))) {
    getLog().debug({ sourceRoot }, 'archon_commit.no_git_metadata');
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%h%n%cI'], {
      cwd: sourceRoot,
      env: withoutRepositorySelectors(process.env),
      timeout: 5000,
    });
    const [sha, committedAt] = stdout.trim().split('\n');
    if (!sha || !committedAt) throw new Error(`unexpected git log output: ${stdout}`);
    return { sha, committedAt };
  } catch (err) {
    // The checkout has git metadata, so this is unexpected (git missing from PATH, a
    // checkout owned by another user, a corrupt repository). Callers still answer without
    // a commit; the warning is the only place the reason surfaces.
    getLog().warn({ err, sourceRoot }, 'archon_commit.read_failed');
    return undefined;
  }
}
