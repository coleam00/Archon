/**
 * Exporter: `BuilderWorkflow` → validation-ready workflow draft.
 *
 * Reassembles each node as `{ ...base, ...variantData, id }` and sparsifies the
 * result (omit `undefined` optionals, drop empty `depends_on`) so the output
 * matches the engine's Zod transform byte-for-byte at the object level — the
 * round-trip `toWorkflowDefinition(fromWorkflowDefinition(x))` equals `x`.
 */
import type {
  BuilderDagNode,
  BuilderNode,
  BuilderWorkflow,
  BuilderWorkflowDefinition,
} from '../types';
import { nodeDataToDag } from '../variants';

/** Drop `undefined` values and empty `depends_on`, matching the engine transform. */
function sparsifyNode(merged: Record<string, unknown>): BuilderDagNode {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (key === 'depends_on' && Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as BuilderDagNode;
}

/** Reassemble a single builder node into a sparse wire node. */
function nodeToDag(node: BuilderNode): BuilderDagNode {
  return sparsifyNode({ ...node.base, ...nodeDataToDag(node), id: node.id });
}

/** Convert a `BuilderWorkflow` into a preview/validation draft. */
export function toWorkflowDefinition(bw: BuilderWorkflow): BuilderWorkflowDefinition {
  return {
    name: bw.name,
    description: bw.description,
    ...bw.meta,
    nodes: bw.nodes.map(nodeToDag),
  };
}
