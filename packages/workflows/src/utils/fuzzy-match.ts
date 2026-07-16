// =============================================================================
// Levenshtein distance and fuzzy matching
// =============================================================================
//
// Pure string utilities with zero package deps, so lean modules (output-ref,
// condition-evaluator) can produce did-you-mean hints without pulling in the
// heavy transitive deps of validator.ts, which is where these used to live.

/** Classic Levenshtein distance between two strings */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}

/** Find the closest matches from a list of candidates */
export function findSimilar(
  name: string,
  candidates: readonly string[],
  maxDistance?: number
): string[] {
  const threshold = maxDistance ?? Math.max(2, Math.floor(name.length * 0.3));
  const scored = candidates
    .map(c => ({ name: c, distance: levenshtein(name.toLowerCase(), c.toLowerCase()) }))
    .filter(s => s.distance <= threshold && s.distance > 0)
    .sort((a, b) => a.distance - b.distance);
  return scored.slice(0, 3).map(s => s.name);
}
