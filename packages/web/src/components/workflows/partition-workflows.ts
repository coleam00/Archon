/**
 * Partition a filtered workflow list into a recommended pin-list (declared
 * order) and the rest (input order preserved).
 *
 * `recommendedNames` is the repo-owner-curated declared order from
 * `.archon/config.yaml`. Names not present in `filtered` are silently dropped.
 * Duplicate names are collapsed to their first occurrence so a repeated entry
 * never renders the same workflow twice (React key collision). When the input
 * names list is empty, recommended is `[]` and rest === filtered.
 */
export function partitionWorkflows<T extends { name: string }>(
  filtered: T[],
  recommendedNames: readonly string[]
): { recommended: T[]; rest: T[] } {
  if (recommendedNames.length === 0) {
    return { recommended: [], rest: filtered };
  }
  const byName = new Map(filtered.map(wf => [wf.name, wf]));
  const uniqueRecommendedNames = [...new Set(recommendedNames)];
  const recommendedSet = new Set(uniqueRecommendedNames);
  const recommended = uniqueRecommendedNames
    .map(name => byName.get(name))
    .filter((wf): wf is T => wf !== undefined);
  const rest = filtered.filter(wf => !recommendedSet.has(wf.name));
  return { recommended, rest };
}
