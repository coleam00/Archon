import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { ConversationLockManager, ConversationLockSnapshot } from '@archon/core';
import { openApiRouteRegistrar } from './api-route-kit';

/**
 * The lock manager's snapshot verbatim. It names conversations, so it lives
 * under the auth gate; public `GET /api/health` reports only counts and ages.
 */
const conversationProcessingSchema = z
  .object({
    active: z.number(),
    maxConcurrent: z.number(),
    queuedTotal: z.number(),
    activeConversations: z.array(
      z.object({ conversationId: z.string(), acquiredAt: z.string(), ageMs: z.number() })
    ),
    queuedConversations: z.array(
      z.object({
        conversationId: z.string(),
        queuedMessages: z.number(),
        oldestEnqueuedAt: z.string(),
        oldestAgeMs: z.number(),
      })
    ),
  })
  .openapi('ConversationProcessingResponse') satisfies z.ZodType<ConversationLockSnapshot>;

const getConversationProcessingRoute = createRoute({
  method: 'get',
  path: '/api/dashboard/conversations',
  tags: ['System'],
  summary: 'Active and queued conversation processing in this server process',
  description:
    'Background workflow runs bypass the conversation lock and are listed by /api/dashboard/runs.',
  responses: {
    200: {
      content: { 'application/json': { schema: conversationProcessingSchema } },
      description: 'Conversations holding a processing slot or waiting for one',
    },
  },
});

export function registerConversationProcessingRoute(
  app: OpenAPIHono,
  { lockManager }: { lockManager: Pick<ConversationLockManager, 'getStats'> }
): void {
  openApiRouteRegistrar(app)(getConversationProcessingRoute, c => c.json(lockManager.getStats()));
}
