/**
 * Resolve which variant a wire `DagNode` is, by field presence.
 *
 * The mode fields are mutually exclusive in a valid node, so for well-formed
 * input any presence order resolves identically. The priority order here matches
 * the engine discriminant so malformed/ambiguous nodes resolve deterministically:
 * `loop → approval → cancel → bash → script → command → prompt`.
 */
import type { VariantId, WireDagNode } from '../types';

/** Resolve the variant of a wire node by mode-field presence. Defaults to `prompt`. */
export function detectVariant(node: WireDagNode): VariantId {
  if (node.loop !== undefined) return 'loop';
  if (node.approval !== undefined) return 'approval';
  if (node.cancel !== undefined) return 'cancel';
  if (node.bash !== undefined) return 'bash';
  if (node.script !== undefined) return 'script';
  if (node.command !== undefined) return 'command';
  return 'prompt';
}
