/**
 * Resolve which variant a wire `DagNode` is, by mode-field presence.
 *
 * The mode fields are mutually exclusive in a valid node, so for well-formed
 * input any presence order resolves identically. For malformed/ambiguous nodes
 * the priority order below is a builder-specific choice so resolution stays
 * deterministic (the engine has no fallback — it rejects nodes whose mode-field
 * count is not exactly one): `loop → approval → cancel → bash → script →
 * command → prompt`.
 */
import type { VariantId, WireDagNode } from '../types';

/**
 * Resolve the variant of a wire node by mode-field presence, or `null` when no
 * mode field is present at all (malformed or future-schema input). Import paths
 * use this strict form so an unrecognizable node surfaces an issue instead of
 * silently becoming an empty prompt node.
 */
export function detectVariantOrNull(node: WireDagNode): VariantId | null {
  if (node.loop !== undefined) return 'loop';
  if (node.approval !== undefined) return 'approval';
  if (node.cancel !== undefined) return 'cancel';
  if (node.bash !== undefined) return 'bash';
  if (node.script !== undefined) return 'script';
  if (node.command !== undefined) return 'command';
  if (node.prompt !== undefined) return 'prompt';
  return null;
}

/** Resolve the variant of a wire node by mode-field presence. Defaults to `prompt`. */
export function detectVariant(node: WireDagNode): VariantId {
  return detectVariantOrNull(node) ?? 'prompt';
}
