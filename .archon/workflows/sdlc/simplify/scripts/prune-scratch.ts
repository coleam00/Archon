/**
 * Remove this run's reviewer scratch worktrees: see ../../.shared/scratch.ts.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_LENS: the one lens directory to remove, or '' for every lens's.
 */

import { artifactsDir, input, refuse } from 'archon:script';
import { pruneScratch, scratchDir } from '../../.shared/scratch.ts';

try {
  const removed = pruneScratch(scratchDir(artifactsDir(), input('lens').trim()));
  console.log(`prune-scratch: removed ${String(removed.length)} scratch worktree(s)`);
} catch (error) {
  refuse(`prune-scratch: ${error instanceof Error ? error.message : String(error)}`);
}
