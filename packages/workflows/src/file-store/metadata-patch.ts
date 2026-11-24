/**
 * Merges a metadata patch into a run's metadata the way the SQL stores' `jsonMerge` does:
 * a top-level null removes the key; any other value replaces it whole, so nulls inside a
 * value are kept. The value is cloned so the run never shares a reference with the caller.
 */
export function applyMetadataPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) Reflect.deleteProperty(target, key);
    else target[key] = structuredClone(value);
  }
}
