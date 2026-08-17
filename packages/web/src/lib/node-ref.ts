/**
 * The one shape of a workflow node id — and of the `$<nodeId>.output` reference
 * built from it — for the whole web package.
 *
 * The engine is the authority: `OUTPUT_REF_SOURCE` in
 * `packages/workflows/src/loader.ts`, whose own docblock warns that a second
 * hand-written copy is exactly the drift it is trying to prevent. The web app
 * cannot import it — `@archon/web` must never depend on `@archon/workflows`
 * (a server package), and `api.generated.d.ts` is type-only so it cannot carry
 * a runtime value. AGENTS.md records the same exception for `TRIGGER_RULES`.
 *
 * So this is a deliberate copy, kept honest two ways: it is the ONLY copy in
 * `packages/web` (both builders and the id-rename check import it), and
 * `scripts/node-ref-parity.test.ts` compares it against the engine's literal so
 * a divergence fails the repository's test run rather than shipping.
 */

/**
 * A node id: letters, digits, underscore and hyphen, no leading digit.
 *
 * The hyphen is the part that matters — the bundled workflows use hyphenated
 * ids (`check-reproduction`, `classify-testability`), and a `\w`-based copy of
 * this grammar silently matches none of them.
 */
export const NODE_ID_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_-]*`;

/**
 * A `$<nodeId>.output` reference, capturing the id in group 1. Named after the
 * engine constant it mirrors, so the parity check reads as the equality it is.
 */
export const OUTPUT_REF_SOURCE = String.raw`\$(${NODE_ID_SOURCE})\.output`;

/** Anchored form, for validating a single id (e.g. on rename). */
export const NODE_ID_PATTERN = new RegExp(`^${NODE_ID_SOURCE}$`);

/**
 * Every distinct node id referenced as `$<id>.output` in `text`.
 *
 * Builds its own `g`-flagged RegExp per call rather than reusing a module-level
 * one: a `g` regex carries mutable `lastIndex`, and sharing a single instance
 * across call sites is how a scan starts skipping matches. The engine builds a
 * fresh `RegExp` per use for the same reason.
 */
export function findOutputRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const match of text.matchAll(new RegExp(OUTPUT_REF_SOURCE, 'g'))) {
    const id = match[1];
    if (id !== undefined) refs.add(id);
  }
  return refs;
}
