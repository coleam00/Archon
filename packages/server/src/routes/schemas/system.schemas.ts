import { z } from '@hono/zod-openapi';

const concurrencySchema = z.object({
  active: z.number(),
  queuedTotal: z.number(),
  queuedByConversation: z.array(
    z.object({ conversationId: z.string(), queuedMessages: z.number() })
  ),
  maxConcurrent: z.number(),
  activeConversationIds: z.array(z.string()),
});

export const healthResponseSchema = z
  .object({
    status: z.string(),
    adapter: z.string(),
    concurrency: concurrencySchema,
    runningWorkflows: z.number(),
    version: z.string().optional(),
    is_docker: z.boolean(),
    activePlatforms: z.array(z.string()).optional(),
  })
  .openapi('HealthResponse');

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const updateCheckResponseSchema = z
  .object({
    updateAvailable: z.boolean(),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  })
  .openapi('UpdateCheckResponse');
