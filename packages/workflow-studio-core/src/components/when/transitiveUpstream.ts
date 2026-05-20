interface NodeLike {
  id: string;
  base?: { depends_on?: string[] };
}

/**
 * Returns the transitive set of ancestors reachable through `depends_on`,
 * excluding the node itself. Defensive against cycles (the importer/validator
 * rejects cycles, but we don't want a runtime crash if invariants slip).
 */
export function transitiveUpstream(id: string, nodes: readonly NodeLike[]): string[] {
  const byId = new Map<string, NodeLike>(nodes.map(n => [n.id, n]));
  const seen = new Set<string>();
  const stack: string[] = [];
  const start = byId.get(id);
  if (!start) return [];
  for (const dep of start.base?.depends_on ?? []) stack.push(dep);
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if (seen.has(next) || next === id) continue;
    seen.add(next);
    const upstream = byId.get(next);
    for (const dep of upstream?.base?.depends_on ?? []) stack.push(dep);
  }
  return [...seen];
}
