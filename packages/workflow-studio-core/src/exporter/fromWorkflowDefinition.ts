import { detectVariant } from '../nodes/shared/detectVariant';
import { pickBaseFields } from '../nodes/shared/pickBaseFields';
import { getVariant } from '../nodes/default-registry';
import type { BuilderNode } from '../nodes/shared/types';
import type { LoadWorkflowInput } from '../store/builder-store';
import type { DagNode } from '../schemas';

// `name` and `description` are handled separately above; this set covers the rest of workflowBaseSchema.
const WORKFLOW_BASE_KEYS = new Set([
  'provider',
  'model',
  'modelReasoningEffort',
  'webSearchMode',
  'additionalDirectories',
  'interactive',
  'effort',
  'thinking',
  'fallbackModel',
  'betas',
  'sandbox',
  'worktree',
  'mutates_checkout',
  'tags',
]);

export function fromWorkflowDefinition(raw: Record<string, unknown>): LoadWorkflowInput {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const description = typeof raw.description === 'string' ? raw.description : '';

  const base: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'nodes' || key === 'name' || key === 'description') continue;
    if (value === undefined) continue;
    if (WORKFLOW_BASE_KEYS.has(key)) base[key] = value;
    else unknown[key] = value;
  }

  const rawNodes = (raw.nodes as Record<string, unknown>[]) ?? [];
  const nodes: BuilderNode[] = rawNodes.map(rawNode => {
    const detection = detectVariant(rawNode);
    if (!detection.ok) {
      throw new Error(
        `fromWorkflowDefinition: node '${String(rawNode.id)}' — ${detection.reason}` +
          ('keysPresent' in detection && detection.keysPresent
            ? ` (${detection.keysPresent.join(', ')})`
            : '')
      );
    }
    const partitioned = pickBaseFields(rawNode, detection.variant);
    const variant = getVariant(detection.variant);
    const data = variant.fromDag({
      base: partitioned.base,
      variantSpecific: partitioned.variantSpecific,
      raw: rawNode as DagNode,
    });
    // Strip 'id' from base — it's the node envelope's identity.
    const baseSansId: Record<string, unknown> = { ...partitioned.base };
    delete baseSansId.id;
    return {
      id: String(rawNode.id),
      variant: detection.variant,
      data,
      base: baseSansId,
      unknown: partitioned.unknown,
    };
  });

  return { meta: { name, description, base, unknown }, nodes };
}
