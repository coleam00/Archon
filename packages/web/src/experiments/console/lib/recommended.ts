import type { Workflow } from '../primitives/workflow';

/** Source rank for the "other" group: project first, then global, then bundled. */
function bySourceThenName(a: Workflow, b: Workflow): number {
  const rank = { project: 0, global: 1, bundled: 2 } as const;
  return rank[a.source] - rank[b.source] || a.name.localeCompare(b.name);
}

/**
 * Order workflows for the run picker (PR #1929).
 *
 * Repo-curated recommended names lead, in their declared (config) order and
 * filtered to names that actually resolved to a workflow. Duplicate names are
 * collapsed to their first occurrence so a repeated entry never pins the same
 * workflow twice (duplicate picker rows / React key collision). The rest
 * follow, sorted project → global → bundled then alphabetically. The returned
 * `recommended` list lets the picker draw the group divider.
 */
export function orderWithRecommended(
  workflows: Workflow[],
  recommendedNames: string[]
): { ordered: Workflow[]; recommended: Workflow[] } {
  const uniqueRecommendedNames = [...new Set(recommendedNames)];
  const recommendedSet = new Set(uniqueRecommendedNames);
  const recommended = uniqueRecommendedNames
    .map(name => workflows.find(w => w.name === name))
    .filter((w): w is Workflow => w !== undefined);
  const rest = workflows.filter(w => !recommendedSet.has(w.name)).sort(bySourceThenName);
  return { ordered: [...recommended, ...rest], recommended };
}
