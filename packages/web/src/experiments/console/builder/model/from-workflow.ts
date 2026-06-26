/**
 * Importer: wire `WorkflowDefinition` → `BuilderWorkflow` + import issues.
 *
 * Each node is partitioned into `{ id, base, variantSpecific }`, its variant is
 * detected, and its variant data is built via the registry. Anything the
 * round-trip cannot represent faithfully — a node with no mode field, a script
 * node missing `runtime`, a wire key the variant's converters do not carry —
 * surfaces as an `Issue` instead of being silently defaulted or dropped.
 */
import type { BuilderNode, BuilderWorkflow, Issue, WireWorkflowDefinition } from '../types';
import {
  detectVariantOrNull,
  defaultPromptData,
  partitionNode,
  VARIANT_REGISTRY,
  variantDataFromDag,
} from '../variants';
import { makeIssue } from '../validation/make-issue';

/** A converted workflow plus everything the importer had to flag along the way. */
export interface ImportResult {
  workflow: BuilderWorkflow;
  issues: Issue[];
}

/** Convert a single wire node into a `BuilderNode`, collecting import issues. */
function nodeFromDag(node: WireWorkflowDefinition['nodes'][number], issues: Issue[]): BuilderNode {
  const { id, base, variantSpecific } = partitionNode(node);

  const variant = detectVariantOrNull(node);
  if (variant === null) {
    // No mode field at all (malformed or future-schema input). Surface the
    // problem and fall back to an empty prompt node so the workflow stays
    // editable rather than failing the whole import.
    issues.push(
      makeIssue({
        rule: 'structural.variant.unknown',
        severity: 'error',
        source: 'client-instant',
        message:
          'cannot determine the node variant (no mode field present); editing as an empty prompt node',
        path: { nodeId: id },
      })
    );
    return { id, variant: 'prompt', base, data: defaultPromptData() };
  }

  if (variant === 'script' && variantSpecific.runtime === undefined) {
    // The engine requires `runtime` on script nodes. scriptFromDag defaults to
    // 'bun' so the node stays editable, but the gap must not be silent.
    issues.push(
      makeIssue({
        rule: 'structural.field.missing',
        severity: 'error',
        source: 'client-instant',
        message: "script node is missing required 'runtime' ('bun' or 'uv'); editing as 'bun'",
        path: { nodeId: id, field: 'runtime' },
      })
    );
  }

  // Warn about wire keys the variant's converters do not carry — the engine
  // emits some fields only on specific variants (e.g. `timeout` on bash/script),
  // so anything else here cannot survive the round-trip.
  const wireKeys = VARIANT_REGISTRY[variant].wireKeys;
  for (const key of Object.keys(variantSpecific)) {
    if (!wireKeys.includes(key)) {
      issues.push(
        makeIssue({
          rule: 'structural.field.unsupported',
          severity: 'warning',
          source: 'client-instant',
          message: `field '${key}' is not supported on ${variant} nodes and was dropped`,
          path: { nodeId: id, field: key },
        })
      );
    }
  }

  const data = variantDataFromDag(variant, variantSpecific);
  // The (variant, data) pair is consistent by construction — detectVariantOrNull
  // and variantDataFromDag read the same fields — so this assembles a valid
  // member of the BuilderNode discriminated union.
  return { id, variant, base, data } as BuilderNode;
}

/** Convert a wire workflow definition into a `BuilderWorkflow` plus import issues. */
export function fromWorkflowDefinition(def: WireWorkflowDefinition): ImportResult {
  const { name, description, nodes, ...meta } = def;
  const issues: Issue[] = [];
  return {
    workflow: {
      name,
      description,
      meta,
      nodes: nodes.map(node => nodeFromDag(node, issues)),
    },
    issues,
  };
}
