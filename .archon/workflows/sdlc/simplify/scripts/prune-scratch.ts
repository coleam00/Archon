/**
 * Remove this run's reviewer scratch worktrees: see ../../.shared/scratch.ts.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_LENS: the one lens directory to remove, or '' for every lens's.
 */

import { artifactsDir, refuse, report, trimmed } from '../../.shared/io.ts';
import { pruneScratch, scratchDir } from '../../.shared/scratch.ts';

try {
  const removed = pruneScratch(scratchDir(artifactsDir(), trimmed(process.env.INPUTS_LENS)));
  report(`prune-scratch: removed ${String(removed.length)} scratch worktree(s)`);
} catch (error) {
  refuse(`prune-scratch: ${error instanceof Error ? error.message : String(error)}`);
}
