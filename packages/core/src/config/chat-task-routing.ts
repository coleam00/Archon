import { z } from 'zod';
import { ORCHESTRATOR_TASK_TYPES } from '../orchestrator/task-types';

const routeReferenceSchema = z.string().trim().min(1).max(160);
export const chatTaskRouteSchema = z
  .object({
    /** Existing tier, @alias, or provider-local literal model reference. */
    primary: routeReferenceSchema,
    /** Ordered model references considered only after an explicit native signal. */
    fallbacks: z.array(routeReferenceSchema).max(4).optional(),
    /** Use a later Claude subscription warning to select a fallback for this task. */
    fallbackOnClaudeUsageWarning: z.boolean().optional(),
    /** Check this account quota meter for every Copilot model in the route. */
    copilotQuotaMeter: z.enum(['premium_interactions', 'chat', 'completions']).optional(),
    /** Read this Codex App Server rate-limit bucket for direct-chat OAuth routes. */
    codexRateLimitId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((route, context) => {
    const seen = new Set([route.primary]);
    for (const [index, fallback] of (route.fallbacks ?? []).entries()) {
      if (seen.has(fallback)) {
        context.addIssue({
          code: 'custom',
          path: ['fallbacks', index],
          message: 'fallback model references must be unique and differ from primary',
        });
      }
      seen.add(fallback);
    }
    if (route.fallbackOnClaudeUsageWarning === true && (route.fallbacks ?? []).length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['fallbackOnClaudeUsageWarning'],
        message: 'a Claude usage warning fallback requires at least one configured fallback model',
      });
    }
  });

export const chatTaskRoutingConfigSchema = z
  .object({
    /** Must be explicitly enabled; omitted means disabled. */
    enabled: z.boolean().optional(),
    routes: z.partialRecord(z.enum(ORCHESTRATOR_TASK_TYPES), chatTaskRouteSchema).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.enabled && Object.keys(config.routes ?? {}).length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['routes'],
        message: 'at least one task route is required when chat task routing is enabled',
      });
    }
  });

export type ChatTaskRoute = z.infer<typeof chatTaskRouteSchema>;
export type ChatTaskRoutingConfig = z.infer<typeof chatTaskRoutingConfigSchema>;

export const DEFAULT_CHAT_TASK_ROUTING: ChatTaskRoutingConfig = {
  enabled: false,
  routes: {},
};
