import type { components } from '@/lib/api.generated';

/**
 * Model tier names. They come from the generated `TiersConfig`, which the server
 * builds from the engine's `TIER_NAMES`.
 */
export type TierName = keyof components['schemas']['TiersConfig'];

// A record over every `TierName`: a tier the server adds or removes fails this
// file's type-check until it is listed here. Key order is the display order.
const TIERS: Record<TierName, true> = { small: true, medium: true, large: true };
export const TIER_ORDER = Object.keys(TIERS) as readonly TierName[];
