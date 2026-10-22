/** Every node `nodeId` transitively depends on through `depends_on`, among `nodes`' declarations. */
export function transitiveDepsLookup(
  nodes: readonly { id: string; depends_on?: readonly string[] }[]
): (nodeId: string) => Set<string> {
  const directDeps = new Map(nodes.map(n => [n.id, n.depends_on ?? []]));
  return (nodeId: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(directDeps.get(nodeId) ?? [])];
    while (stack.length > 0) {
      const dep = stack.pop();
      if (dep === undefined || seen.has(dep)) continue;
      seen.add(dep);
      stack.push(...(directDeps.get(dep) ?? []));
    }
    return seen;
  };
}
