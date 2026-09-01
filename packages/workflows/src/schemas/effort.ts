import { EFFORT_LADDER } from '@archon/paths/effort';
import { z } from '@hono/zod-openapi';

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
