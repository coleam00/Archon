/** Bash variant: defaults + sparse fromDag/toDag conversion. */
import type { BashNodeData, WireDagNode } from '../types';
import { ifDefined } from './if-defined';

/** Default bash config (empty body) for a freshly-created bash node. */
export function defaultBashData(): BashNodeData {
  return { bash: '' };
}

/**
 * Build `BashNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `bash` mode field is absent — importers must check field
 * presence first; defaults for new nodes come from `defaultBashData()`.
 */
export function bashFromDag(variantSpecific: Partial<WireDagNode>): BashNodeData {
  if (variantSpecific.bash === undefined) {
    throw new Error(
      "bashFromDag: wire node has no 'bash' field — use defaultBashData() for new nodes"
    );
  }
  return {
    bash: variantSpecific.bash,
    ...ifDefined('timeout', variantSpecific.timeout),
  };
}

/** Serialize `BashNodeData` to the sparse bash wire fragment. */
export function bashToDag(data: BashNodeData): Partial<WireDagNode> {
  return {
    bash: data.bash,
    ...ifDefined('timeout', data.timeout),
  };
}
