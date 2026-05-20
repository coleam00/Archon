import type { BuilderNode } from '../nodes/shared/types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure subgraph rename. For each node:
 *  - rewrite `id` if mapped
 *  - rewrite each entry of `base.depends_on` if mapped
 *  - rewrite `$<oldId>` references in `base.when` (string identifier boundary; never partial)
 *
 * Body refs in prompt/bash/script/loop.prompt/approval.message are Phase 4 work and not handled here.
 *
 * Identifier boundary: matches `$<oldId>` only when followed by a non-id character.
 * The id charset is `[A-Za-z0-9_-]` (slug). Plain `\b` is not enough because hyphens
 * are word boundaries — `\$run\b` would falsely match inside `$run-cmd`. The negative
 * lookahead `(?![A-Za-z0-9_-])` treats hyphen as part of the identifier, so prefix-of
 * collisions like (oldId='run', body='$run-cmd.output') stay untouched.
 *
 * Caller contract: `idMap` MUST NOT contain chained mappings (e.g., both `a → a-2` AND `a-2 → x`).
 * The when-string regex sweep iterates the map; chained entries can re-rewrite a freshly-introduced
 * id. Phase-3 callers pick targets via `makeUniqueId`, which produces fresh suffixes that aren't
 * themselves keys, so this is a precondition not a defect.
 */
export function renameSubgraph(
  nodes: readonly BuilderNode[],
  idMap: ReadonlyMap<string, string>
): BuilderNode[] {
  if (idMap.size === 0) return nodes.map(n => ({ ...n, base: { ...n.base } }));
  return nodes.map(n => {
    const next: BuilderNode = { ...n, base: { ...n.base } };
    const mapped = idMap.get(next.id);
    if (mapped !== undefined) next.id = mapped;
    const dep = next.base.depends_on as string[] | undefined;
    if (dep) next.base.depends_on = dep.map(d => idMap.get(d) ?? d);
    const w = next.base.when as string | undefined;
    if (typeof w === 'string') {
      let result = w;
      for (const [oldId, newId] of idMap) {
        result = result.replace(
          new RegExp(`\\$${escapeRegExp(oldId)}(?![A-Za-z0-9_-])`, 'g'),
          `$${newId}`
        );
      }
      next.base.when = result;
    }
    return next;
  });
}
