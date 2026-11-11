/** Finding one node's outcome in the engine's listing of this run's node outcomes. */

import { type NodeOutcomesListing, outcomes } from 'archon:script';
import type { TypedOutput } from './inputs.ts';

type NodeOutcome = NodeOutcomesListing['nodes'][number];
export type LoopFrame = NonNullable<NodeOutcome['loop_group_path']>[number];

/** The listing's entries in the engine's order, or undefined when it cannot be read. */
export function readOutcomes(): readonly NodeOutcome[] | undefined {
  try {
    return outcomes().nodes;
  } catch {
    return undefined;
  }
}

/** Whether two loop-frame lists name the same invocation; absent frames mean top level. */
export function sameFrames(left: readonly LoopFrame[] = [], right: readonly LoopFrame[] = []): boolean {
  return (
    left.length === right.length &&
    left.every((frame, index) => frame.groupId === right[index]?.groupId && frame.iteration === right[index]?.iteration)
  );
}

/**
 * The latest outcome of the node that produced a typed output. A typed output names
 * its producer by bare node id and loop frames; the outcome's `node_id` is the step
 * path, which is that id or ends in `.` plus it. The output's own invocation fixes
 * the exact path, and the last entry for that path is the node's latest invocation.
 */
export function latestOutcomeOf(
  listed: readonly NodeOutcome[],
  output: Pick<TypedOutput<unknown>, 'node' | 'loop'>
): NodeOutcome | undefined {
  const frames = output.loop.map(frame => ({ groupId: frame.group, iteration: frame.iteration }));
  const own = listed.find(
    entry =>
      (entry.node_id === output.node || entry.node_id.endsWith(`.${output.node}`)) &&
      sameFrames(entry.loop_group_path, frames)
  );
  return own && [...listed].reverse().find(entry => entry.node_id === own.node_id);
}
