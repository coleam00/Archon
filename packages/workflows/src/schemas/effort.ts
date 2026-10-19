import { EFFORT_LADDER } from '@archon/provider-contract/effort';
import { z } from 'zod';

/**
 * Reasoning depth — the one spelling, on every provider that has the control
 * (#2556). The vocabulary is the union of the effort-capable SDKs' enums, and
 * a provider clamps a rung it doesn't offer to the nearest one it does
 * (`clampEffort` in @archon/core/effort): Codex takes every rung, while `ultra`
 * clamps to `max` on Claude/Pi and `xhigh` on Copilot, and `minimal` clamps to
 * `low` on Claude/Copilot. Derived from `EFFORT_LADDER` rather than restated, so
 * the YAML enum and the clamp cannot disagree.
 */
export const effortLevelSchema = z.enum(EFFORT_LADDER);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

export const EFFORT_LEVELS: readonly EffortLevel[] = effortLevelSchema.options;

export function rejectRetiredThinking(value: unknown, ctx: z.RefinementCtx): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'thinking')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['thinking'],
      message: "'thinking:' has been removed; use 'effort:' instead",
    });
  }
  return value;
}
