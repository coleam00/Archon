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
  // Everything but the prompt source is copied as it is, so a loop field this
  // file does not name still survives the round-trip.
  const { prompt, command, ...rest } = loop;
  return {
    // Exactly one prompt source survives the round-trip. A command-backed loop
    // keeps `command` (never collapsed to an empty prompt); a prompt-backed
    // loop keeps `prompt`. A wire node carrying BOTH is invalid per the engine
    // schema — the importer flags it (see nodeFromDag) and `prompt` wins here
    // so the flagged node stays deterministically editable.
    ...(typeof prompt === 'string'
      ? { prompt }
      : typeof command === 'string'
        ? { command }
        : { prompt: '' }),
    ...rest,
    ...ifDefined('timeout', variantSpecific.timeout),
  };
}

/** Serialize `LoopNodeData` to the sparse `{ loop: … }` wire fragment. */
export function loopToDag(data: LoopNodeData): Partial<WireDagNode> {
  const { timeout, prompt, command, ...rest } = data;
  return {
    loop: {
      // Emit exactly the prompt source the node carries (one-of invariant).
      // A node with neither (transient editing state) exports `prompt: ''`
      // so the engine's own "requires prompt or command" validation fires.
      ...(command !== undefined ? { command } : { prompt: prompt ?? '' }),
      ...rest,
    },
    ...ifDefined('timeout', timeout),
  };
}
