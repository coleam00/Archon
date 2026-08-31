import { z } from '@hono/zod-openapi';

/**
 * Claude Agent SDK ThinkingConfig — string shorthand or full object form.
 * Shorthand: 'adaptive' → { type: 'adaptive' }, 'enabled' → { type: 'enabled' },
 * 'disabled' → { type: 'disabled' }.
 */
export const thinkingConfigSchema = z.preprocess(
  val => {
    if (typeof val === 'string') {
      if (val === 'adaptive') return { type: 'adaptive' };
      if (val === 'enabled') return { type: 'enabled' };
      if (val === 'disabled') return { type: 'disabled' };
    }
    return val;
  },
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('adaptive') }),
    z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().positive().optional() }),
    z.object({ type: z.literal('disabled') }),
  ])
);

export type ThinkingConfig = z.infer<typeof thinkingConfigSchema>;
