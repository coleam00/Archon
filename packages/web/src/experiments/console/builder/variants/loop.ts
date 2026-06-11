/** Loop variant: defaults + sparse fromDag/toDag conversion. */
import type { LoopNodeData, WireDagNode } from '../types';
import { ifDefined } from './if-defined';

/** Default loop config for a freshly-created loop node. */
export function defaultLoopData(): LoopNodeData {
  return { prompt: '', until: 'COMPLETE', max_iterations: 10, fresh_context: false };
}

/**
 * Build `LoopNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `loop` mode field is absent — importers must check field
 * presence first; defaults for new nodes come from `defaultLoopData()`.
 */
export function loopFromDag(variantSpecific: Partial<WireDagNode>): LoopNodeData {
  const loop = variantSpecific.loop;
  if (loop === undefined) {
    throw new Error(
      "loopFromDag: wire node has no 'loop' field — use defaultLoopData() for new nodes"
    );
  }
  return {
    prompt: loop.prompt,
    until: loop.until,
    max_iterations: loop.max_iterations,
    // Engine default is false but the generated type makes it required, so it is
    // always present on the wire and must be carried verbatim across the round-trip.
    fresh_context: loop.fresh_context,
    ...ifDefined('until_bash', loop.until_bash),
    ...ifDefined('interactive', loop.interactive),
    ...ifDefined('gate_message', loop.gate_message),
  };
}

/** Serialize `LoopNodeData` to the sparse `{ loop: … }` wire fragment. */
export function loopToDag(data: LoopNodeData): Partial<WireDagNode> {
  return {
    loop: {
      prompt: data.prompt,
      until: data.until,
      max_iterations: data.max_iterations,
      fresh_context: data.fresh_context,
      ...ifDefined('until_bash', data.until_bash),
      ...ifDefined('interactive', data.interactive),
      ...ifDefined('gate_message', data.gate_message),
    },
  };
}
