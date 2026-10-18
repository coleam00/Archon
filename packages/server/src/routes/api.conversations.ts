import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { RunActor } from '@archon/core';
import { ConversationNotFoundError, generateTitleForUser, resolveTitleRequest } from '@archon/core';
import * as codebaseDb from '@archon/core/db/codebases';
import * as conversationDb from '@archon/core/db/conversations';
import * as messageDb from '@archon/core/db/messages';
import { getArchonWorkspacesPath } from '@archon/paths';
import type { WebAdapter } from '../adapters/web';
import type { OrchestratorDispatch } from './api-message-dispatch';
import {
  authorizeConversation,
  requireConversationVisibility,
  resolveRunActor,
  resolveWebUserId,
} from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { toApiConversation } from './api-serializers';
import {
  conversationIdParamsSchema,
  conversationListResponseSchema,
  conversationSchema,
  createConversationBodySchema,
  createConversationResponseSchema,
  listConversationsQuerySchema,
  successResponseSchema,
  updateConversationBodySchema,
} from './schemas/conversation.schemas';

const getConversationsRoute = createRoute({
  method: 'get',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'List conversations',
  request: { query: listConversationsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationListResponseSchema } },
      description: 'OK',
    },
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Get a conversation by platform conversation ID',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationSchema } },
      description: 'Conversation',
    },
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'Create a new conversation',
  request: {
    body: {
      content: { 'application/json': { schema: createConversationBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Created conversation',
    },
    400: jsonError('Bad request'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Update a conversation (title)',
  request: {
    params: conversationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: updateConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Updated',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Soft-delete a conversation',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

export function registerConversationRoutes(
  app: OpenAPIHono,
  {
    webAdapter,
    dispatchToOrchestrator,
  }: { webAdapter: WebAdapter; dispatchToOrchestrator: OrchestratorDispatch }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/conversations - List conversations
  registerOpenApiRoute(getConversationsRoute, async c => {
    try {
      const platformType = c.req.query('platform') ?? undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const visibility = await requireConversationVisibility(c);
      if ('error' in visibility) return visibility.error;
      // `mine=true` narrows every platform to the caller. Off enforcement it is
      // best-effort: it applies only when an identity happens to resolve.
      let userId: string | undefined;
      if (c.req.query('mine') === 'true') {
        userId = visibility.kind === 'owner' ? visibility.userId : await resolveWebUserId(c);
      }
      const conversations = await conversationDb.listConversations(visibility, {
        platformType,
        codebaseId,
        excludeEmpty: true,
        userId,
      });
      return c.json(conversations.map(toApiConversation));
    } catch (error) {
      getLog().error({ err: error }, 'list_conversations_failed');
      return apiError(c, 500, 'Failed to list conversations');
    }
  });

  // GET /api/conversations/:id - Get single conversation by platform conversation ID
  registerOpenApiRoute(getConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const access = await authorizeConversation(c, { platformId }, 'read');
      if ('error' in access) return access.error;
      return c.json(toApiConversation(access.conversation));
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_failed');
      return apiError(c, 500, 'Failed to get conversation');
    }
  });

  // POST /api/conversations - Create new conversation
  // Accepts optional `message` field for atomic create+send (avoids ghost "Untitled" entries)
  registerOpenApiRoute(createConversationRoute, async c => {
    try {
      const { codebaseId, message } = getValidatedBody(c, createConversationBodySchema);
      const visibility = await requireConversationVisibility(c);
      if ('error' in visibility) return visibility.error;
      // Under enforcement the strictly resolved caller owns the row; a second,
      // soft resolution could fail and leave it ownerless.
      const actor: RunActor =
        visibility.kind === 'owner'
          ? { kind: 'user', userId: visibility.userId }
          : await resolveRunActor(c);
      const userId = actor.kind === 'user' ? actor.userId : undefined;

      // Validate codebase exists if provided
      if (codebaseId) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (!codebase) {
          return apiError(c, 400, 'Codebase not found', `No codebase with id "${codebaseId}"`);
        }
      }

      const conversationId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const conversation = await conversationDb.getOrCreateConversation(
        'web',
        conversationId,
        codebaseId,
        undefined,
        userId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);

      // If message provided, dispatch it atomically (avoids ghost "Untitled" conversations)
      if (message) {
        try {
          await messageDb.addMessage(conversation.id, 'user', message, undefined, userId);
        } catch (e: unknown) {
          // Log only (no SSE warning) — the SSE stream isn't connected yet for new conversations.
          // The existing /message endpoint emits a warning because the stream is guaranteed to be active.
          getLog().error({ err: e, conversationId: conversation.id }, 'message_persistence_failed');
        }

        // Set placeholder title immediately so the sidebar never shows "Untitled conversation"
        const placeholderTitle = message.length > 60 ? message.slice(0, 60) + '...' : message;
        await conversationDb.updateConversationTitle(conversation.id, placeholderTitle);

        // Generate proper AI title for non-command messages (fire-and-forget, overwrites placeholder).
        // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
        // assistant default — the config-default Codex model may not be usable on the
        // active account (e.g. ChatGPT-plan accounts, #1855). Both calls never throw.
        if (!message.startsWith('/')) {
          void resolveTitleRequest(conversation.ai_assistant_type, userId).then(titleRequest =>
            generateTitleForUser(
              conversation.id,
              message,
              titleRequest,
              getArchonWorkspacesPath(),
              userId
            )
          );
        }

        const result = await dispatchToOrchestrator(
          conversation.platform_conversation_id,
          message,
          { actor }
        );

        return c.json({
          conversationId: conversation.platform_conversation_id,
          id: conversation.id,
          dispatched: true,
          ...result,
        });
      }

      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      getLog().error({ err: error }, 'create_conversation_failed');
      return apiError(c, 500, 'Failed to create conversation');
    }
  });

  // PATCH /api/conversations/:id - Update conversation (title)
  registerOpenApiRoute(updateConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const { title } = getValidatedBody(c, updateConversationBodySchema);
    try {
      const access = await authorizeConversation(c, { platformId }, 'write');
      if ('error' in access) return access.error;
      if (title !== undefined) {
        await conversationDb.updateConversationTitle(access.conversation.id, title.slice(0, 255));
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'update_conversation_failed');
      return apiError(c, 500, 'Failed to update conversation');
    }
  });

  // DELETE /api/conversations/:id - Soft delete
  registerOpenApiRoute(deleteConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const access = await authorizeConversation(c, { platformId }, 'write');
      if ('error' in access) return access.error;
      await conversationDb.softDeleteConversation(access.conversation.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'delete_conversation_failed');
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });
}
