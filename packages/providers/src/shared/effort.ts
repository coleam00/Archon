/**
 * The one Archon reasoning-depth vocabulary, and the clamp every provider uses
 * to land a declared rung inside its own SDK's enum.
 *
 * Archon exposes a single `effort:` field in workflow YAML. Each SDK offers a
 * contiguous slice of the same ladder — Claude has no `minimal`, Codex and Pi
 * have no `max`, Copilot has neither — so a rung the resolved provider doesn't
 * offer is clamped to the nearest one it does, rather than dropped. That keeps
 * `effort: max` meaning "as deep as this model goes" everywhere, which is the
 * point of having one spelling (#2556). The precedent is `parseCopilotConfig`,
 * which has mapped `max` → `xhigh` at the provider boundary since Copilot
 * landed.
 *
 * Zero SDK deps by design — `@archon/workflows` derives its `effortLevelSchema`
 * from `EFFORT_LADDER`, so the YAML enum and the clamp can never disagree.
 */

/** Reasoning-depth rungs, weakest → strongest. Order is load-bearing: `clampEffort` walks it. */
export const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortRung = (typeof EFFORT_LADDER)[number];

/** True when `value` is a rung on the shared ladder. */
export function isEffortRung(value: unknown): value is EffortRung {
  return typeof value === 'string' && (EFFORT_LADDER as readonly string[]).includes(value);
}

/**
 * Clamp a declared rung into a provider's supported vocabulary.
 *
 * Returns the value unchanged when the provider supports it, otherwise the
 * closest WEAKER rung it supports, and only if none exists, the closest stronger
 * one. Down-first is the invariant, not distance: a clamp must never silently
 * buy more reasoning than the author asked for. So `clampEffort('high', ['low',
 * 'xhigh'])` is `'low'` — two rungs down — rather than `'xhigh'`, one rung up.
 * On every real provider vocabulary the two rules coincide, because each is a
 * contiguous slice missing only the ladder's extremes (`max` → `xhigh`,
 * `minimal` → `low`); the difference would only appear for a vocabulary with an
 * interior gap.
 *
 * Returns `undefined` for anything that is not on the ladder at all; callers own
 * the warning, since each provider surfaces it through its own channel.
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
