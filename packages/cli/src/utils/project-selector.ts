/**
 * The registered project a `--project` or `project config` selector names: by id,
 * then by exact name. Undefined when nothing matches; throws when a name is shared,
 * listing the ids so the caller can name one.
 */
export function matchProjectClaim<T extends { id: string; name: string }>(
  claims: readonly T[],
  selector: string
): T | undefined {
  const byId = claims.find(row => row.id === selector);
  if (byId) return byId;
  const matches = claims.filter(row => row.name === selector);
  if (matches.length > 1) {
    throw new Error(
      `Project name '${selector}' matches ${matches.length} codebases (${matches.map(row => row.id).join(', ')}). Name one by id.`
    );
  }
  return matches[0];
}
