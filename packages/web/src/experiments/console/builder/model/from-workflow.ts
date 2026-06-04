/**
 * Importer: wire `WorkflowDefinition` → `BuilderWorkflow`.
 *
 * Each node is partitioned into `{ id, base, variantSpecific }`, its variant is
 * detected, and its variant data is built via the registry.
 */
import type { BuilderNode, BuilderWorkflow, WireWorkflowDefinition } from '../types';
import { detectVariant, partitionNode, variantDataFromDag } from '../variants';

/** Convert a single wire node into a `BuilderNode`. */
function nodeFromDag(node: WireWorkflowDefinition['nodes'][number]): BuilderNode {
  const variant = detectVariant(node);
  const { id, base, variantSpecific } = partitionNode(node);
  const data = variantDataFromDag(variant, variantSpecific);
  // The (variant, data) pair is consistent by construction — detectVariant and
  // variantDataFromDag read the same fields — so this assembles a valid member
  // of the BuilderNode discriminated union.
  return { id, variant, base, data } as BuilderNode;
}

/** Convert a wire workflow definition into a `BuilderWorkflow`. */
export function fromWorkflowDefinition(def: WireWorkflowDefinition): BuilderWorkflow {
  const { name, description, nodes, ...meta } = def;
  return {
    name,
    description,
    meta,
    nodes: nodes.map(nodeFromDag),
  };
}
