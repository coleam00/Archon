/**
 * Read this run's node outcomes: the engine's listing at `NODE_OUTCOMES_FILE`, one
 * entry per node invocation with its state. The listing is the engine's, read across
 * a boundary this pack cannot import types over, so its envelope is checked rather
 * than assumed.
 */

import { readFileSync } from 'node:fs';
import { isObject, type ListedArtifact } from './typed.ts';

export type LoopFrame = { readonly groupId: string; readonly iteration: number };

export interface NodeOutcome {
  /** The step path: a loop body node is `<group>.<id>`. */
  readonly node_id: string;
  readonly state: string;
  readonly loop_group_path?: readonly LoopFrame[];
}

/** The listing's entries in the engine's order, or undefined when it cannot be read. */
export function readOutcomes(file: string | undefined): readonly NodeOutcome[] | undefined {
  if (file === undefined || file === '') return undefined;
  try {
    const listing: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(listing) || !Array.isArray(listing.nodes)) return undefined;
    const nodes = listing.nodes.filter(
      (entry): entry is NodeOutcome =>
        isObject(entry) && typeof entry.node_id === 'string' && typeof entry.state === 'string'
    );
    return nodes.length === listing.nodes.length ? nodes : undefined;
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
 * The latest outcome of the node that produced a typed artifact. A typed artifact names
 * its producer by bare node id and loop frames; the outcome's `node_id` is the step
 * path, which is that id or ends in `.` plus it. The artifact's own invocation fixes
 * the exact path, and the last entry for that path is the node's latest invocation.
 */
export function latestOutcomeOf(
  outcomes: readonly NodeOutcome[],
  artifact: ListedArtifact
): NodeOutcome | undefined {
  const { nodeId } = artifact;
  if (nodeId === undefined) return undefined;
  const own = outcomes.find(
    entry =>
      (entry.node_id === nodeId || entry.node_id.endsWith(`.${nodeId}`)) &&
      sameFrames(entry.loop_group_path, artifact.loopGroupPath)
  );
  return own && [...outcomes].reverse().find(entry => entry.node_id === own.node_id);
}
