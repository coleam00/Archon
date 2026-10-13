/** Reasoning-depth rungs, weakest to strongest. Order is load-bearing for clamping. */
export const EFFORT_LADDER = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
] as const;

export type EffortRung = (typeof EFFORT_LADDER)[number];

/** Compile-time proof that a provider list covers every value in its SDK union. */
export type AssertNever<T extends never> = T;

export function isEffortRung(value: unknown): value is EffortRung {
  return typeof value === 'string' && (EFFORT_LADDER as readonly string[]).includes(value);
}

/**
 * Resolves an Archon rung into a provider vocabulary. Unsupported values clamp
 * to a weaker rung first so a mapping never silently buys more reasoning.
 */
export function clampEffort<T extends EffortRung>(
  value: unknown,
  supported: readonly T[]
): T | undefined {
  if (!isEffortRung(value)) return undefined;

  const index = EFFORT_LADDER.indexOf(value);
  const isSupported = (rung: EffortRung): rung is T =>
    (supported as readonly EffortRung[]).includes(rung);

  if (isSupported(value)) return value;

  for (let i = index - 1; i >= 0; i--) {
    const candidate = EFFORT_LADDER[i];
    if (candidate !== undefined && isSupported(candidate)) return candidate;
  }
  for (let i = index + 1; i < EFFORT_LADDER.length; i++) {
    const candidate = EFFORT_LADDER[i];
    if (candidate !== undefined && isSupported(candidate)) return candidate;
  }
  return undefined;
}
