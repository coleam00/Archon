/**
 * Settle the review round's lenses: how each lens node of this round ended, as the
 * engine recorded it, so synthesis reads completion as data instead of inferring it.
 *
 * This node runs after every lens has settled (`all_done`). Its lens siblings share
 * its include prefix and its loop frames, so this round's lens entries in the engine's
 * node outcomes are the ones whose step path is this node's path with its own id
 * replaced by the lens id, at this node's loop frames. A lens the round left out
 * reads `skipped`; a lens whose outcome cannot be read reads `unreadable`, which
 * synthesis treats like any other incomplete lens.
 */

import { REVIEW_LENSES, type ReviewLens } from '../../.shared/review-policy.ts';
import { emit, refuse } from '../../.shared/io.ts';
import { readOutcomes, sameFrames, type LoopFrame } from '../../.shared/outcomes.ts';

/** This node's id in the review block; its path ends in it. */
const SELF = 'review-complete';

try {
  const execution = JSON.parse(process.env.ARCHON_NODE_EXECUTION ?? '') as {
    path: string;
    invocation: { loopPath: LoopFrame[] };
  };
  if (!execution.path.endsWith(SELF)) throw new Error(`this node's path ${execution.path} does not end in ${SELF}`);
  const prefix = execution.path.slice(0, -SELF.length);
  const outcomes = readOutcomes(process.env.NODE_OUTCOMES_FILE);
  const state = (lens: ReviewLens): string =>
    outcomes === undefined
      ? 'unreadable'
      : ([...outcomes].reverse().find(
          entry => entry.node_id === prefix + lens && sameFrames(entry.loop_group_path, execution.invocation.loopPath)
        )?.state ?? 'unreadable');
  emit(Object.fromEntries(REVIEW_LENSES.map(lens => [lens, state(lens)])));
} catch (error) {
  refuse(`lens-outcomes: ${error instanceof Error ? error.message : String(error)}`);
}
