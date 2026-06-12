/**
 * `{ [key]: value }` when `value` is defined, `{}` otherwise — for building
 * sparse object literals via spread without repeating the
 * `...(x !== undefined ? { key: x } : {})` ternary at every call site.
 */
export function ifDefined<K extends string, V>(
  key: K,
  value: V | undefined
): Partial<Record<K, V>> {
  return value !== undefined ? ({ [key]: value } as Record<K, V>) : {};
}
