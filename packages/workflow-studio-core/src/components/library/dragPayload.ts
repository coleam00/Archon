import type { VariantId } from '../../nodes/registry';

export const LIBRARY_DRAG_MIME = 'application/x-archon-studio';

export type LibraryDragPayload =
  | {
      kind: 'variant';
      variantId: VariantId;
      prefill?: Record<string, unknown>;
      /** Optional id-hint override; CommandsSection drag uses `run-<slug>` to
       *  match the click handler's id semantics (see Task 48). */
      idHintOverride?: string;
    }
  | { kind: 'snippet'; category: 'starters' | 'patterns'; name: string }
  /** User-defined snippet — YAML is embedded directly because it lives in
   *  localStorage, not in the bundled fixtures map. */
  | { kind: 'user-snippet'; name: string; yaml: string };

const VARIANT_IDS = new Set<VariantId>([
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
]);
const SNIPPET_CATEGORIES = new Set(['starters', 'patterns']);

export function encodeLibraryDrag(p: LibraryDragPayload): string {
  return JSON.stringify(p);
}

export function decodeLibraryDrag(raw: string): LibraryDragPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    o.kind === 'variant' &&
    typeof o.variantId === 'string' &&
    VARIANT_IDS.has(o.variantId as VariantId)
  ) {
    const out: LibraryDragPayload = { kind: 'variant', variantId: o.variantId as VariantId };
    if (o.prefill && typeof o.prefill === 'object') {
      out.prefill = o.prefill as Record<string, unknown>;
    }
    if (typeof o.idHintOverride === 'string') {
      out.idHintOverride = o.idHintOverride;
    }
    return out;
  }
  if (
    o.kind === 'snippet' &&
    typeof o.category === 'string' &&
    SNIPPET_CATEGORIES.has(o.category) &&
    typeof o.name === 'string'
  ) {
    return {
      kind: 'snippet',
      category: o.category as 'starters' | 'patterns',
      name: o.name,
    };
  }
  if (o.kind === 'user-snippet' && typeof o.name === 'string' && typeof o.yaml === 'string') {
    return { kind: 'user-snippet', name: o.name, yaml: o.yaml };
  }
  return null;
}
