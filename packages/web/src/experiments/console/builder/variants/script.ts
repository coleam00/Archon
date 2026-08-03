/** Script variant: defaults + sparse fromDag/toDag conversion. */
import type { ScriptNodeData, WireDagNode } from '../types';
import { ifDefined } from './if-defined';

/** Default script config (empty body, bun runtime) for a freshly-created script node. */
export function defaultScriptData(): ScriptNodeData {
  return { script: '', runtime: 'bun' };
}

/**
 * Build `ScriptNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `script` mode field is absent — importers must check field
 * presence first; defaults for new nodes come from `defaultScriptData()`.
 *
 * A missing `runtime` still defaults to `'bun'` so the node stays editable, but
 * the importer flags it (the engine requires `runtime` on script nodes) — see
 * `fromWorkflowDefinition`.
 */
export function scriptFromDag(variantSpecific: Partial<WireDagNode>): ScriptNodeData {
  if (variantSpecific.script === undefined) {
    throw new Error(
      "scriptFromDag: wire node has no 'script' field — use defaultScriptData() for new nodes"
    );
  }
  return {
    script: variantSpecific.script,
    runtime: variantSpecific.runtime ?? 'bun',
    ...ifDefined('deps', variantSpecific.deps),
    ...ifDefined('timeout', variantSpecific.timeout),
  };
}

/** Serialize `ScriptNodeData` to the sparse script wire fragment. */
export function scriptToDag(data: ScriptNodeData): Partial<WireDagNode> {
  return {
    script: data.script,
    runtime: data.runtime,
    ...ifDefined('deps', data.deps),
    ...ifDefined('timeout', data.timeout),
  };
}
