import type { VariantDefinition } from './shared/types';

export type VariantId = 'command' | 'prompt' | 'bash' | 'script' | 'loop' | 'approval' | 'cancel';

export const VARIANT_IDS: readonly VariantId[] = [
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
] as const;

// VariantDefinition<TData> is invariant in TData because `toDag(data: TData)` uses
// TData contravariantly. The registry is heterogeneous by design — each variant has
// its own TData type — so we widen to `any` here. The public read API `getVariant<T>`
// re-applies the precise type via assertion; runtime safety is preserved by the
// id-check loop in `buildRegistry`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- invariant generic; see comment above
export type VariantRegistry = Readonly<Record<VariantId, VariantDefinition<any>>>;

/**
 * Build a typed registry from a per-variant lookup. Throws if any variant is missing
 * or declares a mismatching id. Per-variant modules are the only registrants;
 * consumer code reads via `getVariant` (in `default-registry.ts`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- invariant generic; see VariantRegistry comment
export function buildRegistry(entries: Record<VariantId, VariantDefinition<any>>): VariantRegistry {
  for (const id of VARIANT_IDS) {
    if (!entries[id]) throw new Error(`Variant registry missing: ${id}`);
    if (entries[id].id !== id) {
      throw new Error(
        `Variant registry mismatch: entry under '${id}' declares id '${entries[id].id}'`
      );
    }
  }
  return entries;
}
