import { z } from '@hono/zod-openapi';

const SAFE_NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED_NODE_IDS = new Set(['__proto__', 'prototype', 'constructor']);

export const safeNodeIdSchema = z
  .string()
  .min(1, 'node id must not be empty')
  .max(64, 'node id must be 64 characters or fewer')
  .regex(SAFE_NODE_ID_PATTERN, 'node id must match [A-Za-z_][A-Za-z0-9_-]{0,63}')
  .refine(id => !RESERVED_NODE_IDS.has(id), 'node id must not be a reserved object key');

export type SafeNodeId = z.infer<typeof safeNodeIdSchema>;

export const routeOutcomeSchema = z.enum(['positive', 'negative', 'exhausted']);

export type RouteOutcome = z.infer<typeof routeOutcomeSchema>;

export const routeLoopRoutesSchema = z
  .object({
    positive: safeNodeIdSchema,
    negative: safeNodeIdSchema,
    exhausted: safeNodeIdSchema,
  })
  .strict();

export type RouteLoopRoutes = z.infer<typeof routeLoopRoutesSchema>;

export const routeLoopConfigSchema = z
  .object({
    from: safeNodeIdSchema,
    condition: z.string().trim().min(1, 'route_loop.condition must not be empty'),
    max_iterations: z.number().int().min(1).max(100).default(10),
    routes: routeLoopRoutesSchema,
  })
  .strict();

export type RouteLoopConfig = z.infer<typeof routeLoopConfigSchema>;
