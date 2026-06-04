/** Script variant: defaults + sparse fromDag/toDag conversion. */
import type { ScriptNodeData, WireDagNode } from '../types';

/** Default script config (empty body, bun runtime) for a freshly-created script node. */
export function defaultScriptData(): ScriptNodeData {
  return { script: '', runtime: 'bun' };
}

/** Build `ScriptNodeData` from a partitioned wire node's variant-specific fields. */
export function scriptFromDag(variantSpecific: Partial<WireDagNode>): ScriptNodeData {
  return {
    script: variantSpecific.script ?? '',
    runtime: variantSpecific.runtime ?? 'bun',
    ...(variantSpecific.deps !== undefined ? { deps: variantSpecific.deps } : {}),
    ...(variantSpecific.timeout !== undefined ? { timeout: variantSpecific.timeout } : {}),
  };
}

/** Serialize `ScriptNodeData` to the sparse script wire fragment. */
export function scriptToDag(data: ScriptNodeData): Partial<WireDagNode> {
  return {
    script: data.script,
    runtime: data.runtime,
    ...(data.deps !== undefined ? { deps: data.deps } : {}),
    ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
  };
}
