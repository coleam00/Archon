/** Bash variant: defaults + sparse fromDag/toDag conversion. */
import type { BashNodeData, WireDagNode } from '../types';

/** Default bash config (empty body) for a freshly-created bash node. */
export function defaultBashData(): BashNodeData {
  return { bash: '' };
}

/** Build `BashNodeData` from a partitioned wire node's variant-specific fields. */
export function bashFromDag(variantSpecific: Partial<WireDagNode>): BashNodeData {
  return {
    bash: variantSpecific.bash ?? '',
    ...(variantSpecific.timeout !== undefined ? { timeout: variantSpecific.timeout } : {}),
  };
}

/** Serialize `BashNodeData` to the sparse bash wire fragment. */
export function bashToDag(data: BashNodeData): Partial<WireDagNode> {
  return {
    bash: data.bash,
    ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
  };
}
