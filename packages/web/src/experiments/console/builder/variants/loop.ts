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
    // Exactly one prompt source survives the round-trip. A command-backed loop
    // keeps `command` (never collapsed to an empty prompt); a prompt-backed
    // loop keeps `prompt`. A wire node carrying BOTH is invalid per the engine
    // schema — the importer flags it (see nodeFromDag) and `prompt` wins here
    // so the flagged node stays deterministically editable.
    ...(typeof loop.prompt === 'string'
      ? { prompt: loop.prompt }
      : typeof loop.command === 'string'
        ? { command: loop.command }
        : { prompt: '' }),
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
      // Emit exactly the prompt source the node carries (one-of invariant).
      // A node with neither (transient editing state) exports `prompt: ''`
      // so the engine's own "requires prompt or command" validation fires.
      ...(data.command !== undefined ? { command: data.command } : { prompt: data.prompt ?? '' }),
      until: data.until,
      max_iterations: data.max_iterations,
      fresh_context: data.fresh_context,
      ...ifDefined('until_bash', data.until_bash),
      ...ifDefined('interactive', data.interactive),
      ...ifDefined('gate_message', data.gate_message),
    },
  };
}
