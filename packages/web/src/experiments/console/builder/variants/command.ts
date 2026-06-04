/** Command variant: defaults + sparse fromDag/toDag conversion. */
import type { CommandNodeData, WireDagNode } from '../types';

/** Default command config (empty name) for a freshly-created command node. */
export function defaultCommandData(): CommandNodeData {
  return { command: '' };
}

/** Build `CommandNodeData` from a partitioned wire node's variant-specific fields. */
export function commandFromDag(variantSpecific: Partial<WireDagNode>): CommandNodeData {
  return { command: variantSpecific.command ?? '' };
}

/** Serialize `CommandNodeData` to the sparse `{ command: … }` wire fragment. */
export function commandToDag(data: CommandNodeData): Partial<WireDagNode> {
  return { command: data.command };
}
