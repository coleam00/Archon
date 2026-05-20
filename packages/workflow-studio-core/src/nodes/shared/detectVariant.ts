import type { VariantId } from '../registry';

export type DetectResult =
  | { ok: true; variant: VariantId }
  | { ok: false; reason: 'no-variant-key' | 'multiple-variant-keys'; keysPresent?: string[] };

const VARIANT_KEYS: readonly { key: string; variant: VariantId }[] = [
  { key: 'command', variant: 'command' },
  { key: 'prompt', variant: 'prompt' },
  { key: 'bash', variant: 'bash' },
  { key: 'script', variant: 'script' },
  { key: 'loop', variant: 'loop' },
  { key: 'approval', variant: 'approval' },
  { key: 'cancel', variant: 'cancel' },
];

/** Returns true when the value behaves as "the variant key is present and has content" — matching Archon's superRefine. */
function isPresent(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (key === 'loop' || key === 'approval') return typeof value === 'object';
  // command/prompt/bash/script/cancel are string-typed; empty strings don't count.
  return typeof value === 'string' && value.trim().length > 0;
}

export function detectVariant(raw: Record<string, unknown>): DetectResult {
  const present = VARIANT_KEYS.filter(({ key }) => isPresent(key, raw[key]));
  if (present.length === 0) return { ok: false, reason: 'no-variant-key' };
  if (present.length > 1) {
    return {
      ok: false,
      reason: 'multiple-variant-keys',
      keysPresent: present.map(p => p.key),
    };
  }
  return { ok: true, variant: present[0].variant };
}
