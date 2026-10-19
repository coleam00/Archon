import { createLogger } from '@archon/paths';
import { GitFailure } from './errors';
import { execFileAsync } from './exec';
import { addSafeDirectory } from './repo';
import { toRepoPath } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/**
 * Trust a path the operator registers when ownership is git's only objection,
 * as for a bind mount owned by another user. Registration is the operator's
 * trust decision, the same one cloning makes for its destination. Nothing is
 * written for a path git already accepts or refuses for another reason, so a
 * non-repository is never trusted. Only the exact path is granted: git matches
 * the repository top level, so a subdirectory of a foreign-owned repo stays
 * refused. Pass a canonical (realpath) path, which is what git compares.
 */
export async function trustRegisteredPath(path: string): Promise<void> {
  const probe = (scope: string[]): Promise<unknown> =>
    execFileAsync('git', ['-C', path, ...scope, 'rev-parse', '--git-dir'], { timeout: 10000 });
  try {
    await probe([]);
    return;
  } catch (error) {
    // Git refuses ownership with its fatal exit 128. Anything else (a timeout, a
    // signal, a missing git) is not a refusal the grant could answer.
    if (!(error instanceof GitFailure && error.code === 128)) return;
  }
  try {
    await probe(['-c', `safe.directory=${path}`]);
  } catch {
    // Not an ownership refusal. The caller's own probe reports the original failure.
    return;
  }
  await addSafeDirectory(toRepoPath(path));
  getLog().info({ path }, 'safe_directory_registration_granted');
}
