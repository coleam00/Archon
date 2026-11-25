/**
 * Merges a store patch into run metadata as the SQL stores' `jsonMerge` does: top-level
 * only, and a top-level null removes its key. Nulls nested inside a value are kept.
 */
export function mergeRunMetadata(
  metadata: Record<string, unknown>,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> {
  const merged = { ...metadata };
  for (const [key, value] of Object.entries(structuredClone(patch ?? {}))) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
