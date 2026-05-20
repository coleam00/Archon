import { getVariant } from '../nodes/default-registry';
import type { LoadWorkflowInput } from '../store/builder-store';

export function toWorkflowDefinition(input: LoadWorkflowInput): Record<string, unknown> {
  const { meta, nodes } = input;

  const out: Record<string, unknown> = {
    name: meta.name,
    description: meta.description,
    ...meta.base,
    ...meta.unknown,
    nodes: nodes.map(n => {
      const variantPart = getVariant(n.variant).toDag(n.data);
      return {
        id: n.id,
        ...n.base,
        ...variantPart,
        ...n.unknown,
      };
    }),
  };
  return out;
}
