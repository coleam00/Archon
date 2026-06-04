/** Cancel variant: defaults + sparse fromDag/toDag conversion. */
import type { CancelNodeData, WireDagNode } from '../types';

/** Default cancel config (empty reason) for a freshly-created cancel node. */
export function defaultCancelData(): CancelNodeData {
  return { reason: '' };
}

/** Build `CancelNodeData` from a partitioned wire node's variant-specific fields. */
export function cancelFromDag(variantSpecific: Partial<WireDagNode>): CancelNodeData {
  return { reason: variantSpecific.cancel ?? '' };
}

/** Serialize `CancelNodeData` to the sparse `{ cancel: … }` wire fragment. */
export function cancelToDag(data: CancelNodeData): Partial<WireDagNode> {
  return { cancel: data.reason };
}
