import { z } from '@hono/zod-openapi';

export const regimeSchema = z.enum(['trending', 'ranging', 'volatile', 'calm']);

export const tradeRecordSchema = z.object({
  strategy: z.string().min(1),
  regime: regimeSchema,
  volatility: z.number().min(0),
  pnl: z.number(),
  success: z.boolean(),
});

export const marketStateSchema = z.object({
  regime: regimeSchema,
  volatility: z.number().min(0),
});

export const performanceMetricsSchema = z.object({
  avg_return: z.number(),
  winrate: z.number(),
  sharpe: z.number(),
  trades_count: z.number().int().min(0),
});

export const alternativeSchema = z.object({
  strategy: z.string(),
  score: z.number(),
  metrics: performanceMetricsSchema,
});

export const recommendationSchema = z.object({
  selected_strategy: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(alternativeSchema),
});
