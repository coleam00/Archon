/**
 * The one Archon reasoning-depth vocabulary, and the clamp every provider uses
 * to land a declared rung inside its own SDK's enum.
 *
 * Archon exposes a single `effort:` field in workflow YAML. Pi's vocabulary is the
 * full ladder; the others offer a contiguous slice — Claude has no `minimal`,
 * Codex has no `max`, Copilot has neither — so a rung the resolved provider
 * doesn't offer is clamped into range rather than dropped (weaker first; see
 * `clampEffort` for why the direction matters). That keeps
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

/**
 * Compile-time proof that a provider's rung list COVERS its SDK's vocabulary.
 *
 * `as const satisfies readonly SdkLevel[]` proves the opposite direction only —
 * that every entry is a valid level (containment). A list that omits a rung the
 * SDK supports type-checks cleanly and silently clamps that rung away, which is
 * how `max` went missing from Pi's list while Pi's SDK has supported it all
 * along. Pair every vocabulary with this:
 *
 *   export type XLevelsAreComplete = AssertNever<Exclude<SdkLevel, (typeof X)[number]>>;
 *
 * It resolves to `never` when the list is complete and fails to compile when it
 * is not. Only usable where the SDK exports its own union — a hand-mirrored type
 * would just be asserting a list against itself.
 */
export type AssertNever<T extends never> = T;

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
 * contiguous slice missing only the ladder's extremes (`max` → `xhigh` on Codex,
 * `minimal` → `low` on Claude); the difference would only appear for a
 * vocabulary with an interior gap.
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
