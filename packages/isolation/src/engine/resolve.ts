/**
 * Worktree engine selection.
 *
 * Maps `.archon/config.yaml > worktree.engine` to a `WorktreeEngine` instance.
 * Engines are stateless (the worktrunk preflight cache is the one exception,
 * and sharing it is desirable), so one singleton per engine id suffices.
 */

import { WORKTREE_ENGINE_IDS, type WorktreeEngine, type WorktreeEngineId } from './types';
import { GitWorktreeEngine } from './git-engine';
import { WorktrunkEngine } from './worktrunk-engine';

const engines: Record<WorktreeEngineId, WorktreeEngine> = {
  git: new GitWorktreeEngine(),
  worktrunk: new WorktrunkEngine(),
};

function isWorktreeEngineId(value: string): value is WorktreeEngineId {
  return (WORKTREE_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * Resolve the configured engine id to an engine instance.
 *
 * `undefined` / empty-after-trim → the default git engine (zero behavior
 * change for existing users). Any other unrecognized value throws — a typo'd
 * engine must not silently fall back to git (Fail Fast).
 */
export function resolveWorktreeEngine(engine: string | undefined): WorktreeEngine {
  const trimmed = engine?.trim();
  if (!trimmed) {
    return engines.git;
  }
  if (!isWorktreeEngineId(trimmed)) {
    throw new Error(
      `.archon/config.yaml worktree.engine must be one of ${WORKTREE_ENGINE_IDS.map(id => `'${id}'`).join(', ')} (got: '${trimmed}').`
    );
  }
  return engines[trimmed];
}
