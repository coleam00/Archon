import lodashMergeWith from 'lodash.mergewith';

/**
 * Deep-merge a patch onto a base value with two custom rules:
 *   - Arrays are REPLACED wholesale (lodash's default per-index merge would
 *     produce nonsense for fields like allowed_tools / disallowed_tools).
 *   - `null` in the patch DELETES the corresponding key (lets the inspector
 *     clear an optional field without a separate delete action).
 *
 * Used by `builder-store.updateNodeData`. The forward-compat invariant of §6.3
 * relies on this preserving keys the patch never mentions.
 */
export function mergePatch<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const result = lodashMergeWith(
    {},
    base,
    patch,
    (_objVal: unknown, srcVal: unknown): unknown[] | undefined => {
      if (Array.isArray(srcVal)) return srcVal as unknown[];
      return undefined;
    }
  ) as T;
  const r = result as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if ((patch as Record<string, unknown>)[key] === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- patch-driven key removal is intentional (null = delete)
      delete r[key];
    }
  }
  return result;
}
