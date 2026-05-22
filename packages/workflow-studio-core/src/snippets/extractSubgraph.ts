import type { BuilderNode } from '../nodes/shared/types';
import { serializeYaml } from '../exporter/serializeYaml';

export interface ExtractSubgraphOptions {
  /** All nodes in the current workflow. */
  nodes: BuilderNode[];
  /** Ids the user has selected. Order is preserved in the output. */
  selectedIds: string[];
  /** Name for the synthetic workflow wrapper around the subgraph. */
  workflowName?: string;
  /** Optional description for the wrapper meta. */
  description?: string;
}

export interface ExtractSubgraphResult {
  yaml: string;
  /** Ids whose `depends_on` had refs that pointed outside the selection and got dropped. */
  droppedDeps: { nodeId: string; droppedRefs: string[] }[];
}

/**
 * Serializes a subset of the current workflow as a standalone YAML snippet.
 * Dropped from each cloned node:
 *   - `depends_on` entries that point to ids NOT in the selection
 *
 * Left alone (intentionally):
 *   - `when` expressions (free-text). If they reference ids outside the
 *     selection, the inserted subgraph will surface a validation error at
 *     paste time and the user can fix it then.
 */
export function extractSubgraph({
  nodes,
  selectedIds,
  workflowName,
  description,
}: ExtractSubgraphOptions): ExtractSubgraphResult {
  const selectedSet = new Set(selectedIds);
  // Preserve selection order; deduplicate.
  const orderedIds = Array.from(new Set(selectedIds));
  const lookup = new Map(nodes.map(n => [n.id, n] as const));

  const droppedDeps: { nodeId: string; droppedRefs: string[] }[] = [];

  const cloned: BuilderNode[] = [];
  for (const id of orderedIds) {
    const src = lookup.get(id);
    if (!src) continue; // selection may include phantom ids if state is mid-update

    // Shallow clone with a filtered depends_on. We intentionally don't deep-
    // clone data/unknown — they're treated as immutable by the store, and the
    // serializer doesn't mutate.
    const rawDeps = src.base?.depends_on as string[] | undefined;
    let nextBase = src.base;
    if (Array.isArray(rawDeps)) {
      const kept = rawDeps.filter(d => selectedSet.has(d));
      const dropped = rawDeps.filter(d => !selectedSet.has(d));
      if (dropped.length > 0) droppedDeps.push({ nodeId: id, droppedRefs: dropped });
      if (kept.length !== rawDeps.length) {
        // Strip the key entirely when empty so the YAML stays clean.
        const { depends_on: removed, ...rest } = src.base;
        void removed;
        nextBase = kept.length > 0 ? { ...rest, depends_on: kept } : rest;
      }
    }

    cloned.push({ ...src, base: nextBase });
  }

  const { yaml } = serializeYaml({
    meta: {
      name: workflowName?.trim() || 'snippet',
      description: description?.trim() || '',
      base: {},
      unknown: {},
    },
    nodes: cloned,
  });

  return { yaml, droppedDeps };
}
