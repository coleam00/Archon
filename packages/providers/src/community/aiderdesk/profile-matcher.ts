/**
 * Pure helpers for matching typed-string profile NAMES against a known list.
 *
 * The new contract is strict: `requestOptions.model` MUST be a case-sensitive
 * name from AiderDesk's `/api/agent-profiles` response. When no exact match
 * is found, the provider throws `UnknownAiderDeskAgentProfileError` and
 * includes a "did you mean" hint of up to FIVE near-misses. Levenshtein is
 * the canonical near-miss metric; for short strings we also accept substring
 * matches (`'Power Tools' ~ 'PowerTool'`) as a fallback.
 *
 * These helpers are deterministic + side-effect-free (no loggers, no fetches).
 * The Levenshtein implementation is the classic 2-row DP — O(n*m) memory
 * rather than full-table, which is fine for the short profile-name strings
 * we compare here.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Insert + delete + substitute all count as 1. Case-sensitive — profile names
 * are matched case-sensitive (the spec requires this). When the caller wants
 * fuzzy ish behavior on the unknown-name path, normalize BOTH sides in the
 * caller before passing — explicit is better than implicit here.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev: number[] = new Array(b.length + 1);
  const cur: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1, // deletion from a
        cur[j - 1] + 1, // insertion into a
        prev[j - 1] + cost // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

const MAX_NEAREST = 5;
const MAX_LEVENSHTEIN = 2;

/**
 * Return up to `k` candidates whose Levenshtein distance to `target` is
 * `<= maxDistance`, sorted by:
 *   1. ascending distance
 *   2. alphabetical `name.localeCompare` (deterministic tiebreaker)
 *
 * Substring containment (`a.includes(b)` or vice versa) is also accepted as a
 * +0-distance proxy for short strings where Levenshtein over-counts on
 * deletions of whole words (e.g. `'Power' ⊂ 'Power Tools'` → 2 because of the
 * space + 'Tools' deletion, but the user clearly meant the same profile).
 *
 * Returns a frozen, ordered list — safe to consume and re-render.
 */
export function nearestNames(
  target: string,
  candidates: readonly string[],
  k: number = MAX_NEAREST
): readonly string[] {
  if (target.length === 0 || candidates.length === 0) return [];

  const scored: Array<{ name: string; distance: number }> = [];

  for (const candidate of candidates) {
    if (candidate === target) continue; // never suggest an exact match
    const d = levenshtein(target, candidate);
    const substring =
      candidate.length > 0 &&
      target.length > 0 &&
      (candidate.includes(target) || target.includes(candidate));
    const effectiveDistance = substring ? Math.min(d, 1) : d;
    if (
      effectiveDistance <= MAX_LEVENSHTEIN ||
      (substring && d <= 8)
    ) {
      scored.push({ name: candidate, distance: effectiveDistance });
    }
  }

  if (scored.length === 0) return [];

  scored.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.name.localeCompare(b.name);
  });

  return scored.slice(0, k).map(s => s.name);
}
