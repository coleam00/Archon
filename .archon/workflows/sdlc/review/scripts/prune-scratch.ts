/**
 * Remove this run's reviewer scratch worktrees: see ../../.shared/scratch.ts.
 *
 * Only the review's own directories, one per lens and the deciding agent's: delivery
 * runs simplify beside the review, and its scratch worktrees are still in use when
 * the review settles. Simplify prunes its own.
 */

import { artifactsDir, refuse, report } from '../../.shared/io.ts';
import { REVIEW_LENSES } from '../../.shared/review-policy.ts';
import { pruneScratch, scratchDir } from '../../.shared/scratch.ts';

try {
  const removed = [...REVIEW_LENSES, 'synthesize'].flatMap(lens => pruneScratch(scratchDir(artifactsDir(), lens)));
  report(`prune-scratch: removed ${String(removed.length)} scratch worktree(s)`);
} catch (error) {
  refuse(`prune-scratch: ${error instanceof Error ? error.message : String(error)}`);
}
