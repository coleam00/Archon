/**
 * Zod schemas for conversation and message API endpoints.
 */
import { z } from '@hono/zod-openapi';

/** A conversation record. */
export const conversationSchema = z
  .object({
    id: z.string(),
    platform_type: z.string(),
    platform_conversation_id: z.string(),
    codebase_id: z.string().nullable(),
    cwd: z.string().nullable(),
    isolation_env_id: z.string().nullable(),
    ai_assistant_type: z.string(),
    title: z.string().nullable(),
    hidden: z.boolean(),
    deleted_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Conversation');

/** GET /api/conversations query params. */
export const listConversationsQuerySchema = z.object({
  platform: z.string().optional(),
  codebaseId: z.string().optional(),
});

/** GET /api/conversations response. */
export const conversationListResponseSchema = z
  .array(conversationSchema)
  .openapi('ConversationListResponse');

/** Path params for routes with :id (platform conversation ID). */
export const conversationIdParamsSchema = z.object({ id: z.string() });

/** POST /api/conversations request body. Uses strict() to reject unknown fields (e.g. conversationId). */
export const createConversationBodySchema = z
  .object({
    codebaseId: z.string().optional(),
    message: z.string().optional(),
  })
  .strict()
  .openapi('CreateConversationBody');

/** POST /api/conversations response. */
export const createConversationResponseSchema = z
  .object({
    conversationId: z.string(),
    id: z.string(),
    dispatched: z.boolean().optional(),
  })
  .openapi('CreateConversationResponse');

/** PATCH /api/conversations/:id request body. */
export const updateConversationBodySchema = z
  .object({ title: z.string().min(1).optional() })
  .openapi('UpdateConversationBody');

/** Generic success response. */
export const successResponseSchema = z.object({ success: z.boolean() }).openapi('SuccessResponse');

/** A single message row. */
export const messageSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    metadata: z.string(),
    created_at: z.string(),
  })
  .openapi('Message');

/** GET /api/conversations/:id/messages query params. */
export const listMessagesQuerySchema = z.object({
  limit: z.string().optional(),
});

/** GET /api/conversations/:id/messages response. */
export const messageListResponseSchema = z.array(messageSchema).openapi('MessageListResponse');

/** POST /api/conversations/:id/message JSON request body. */
export const sendMessageBodySchema = z
  .object({ message: z.string().min(1) })
  .openapi('SendMessageBody');

/** POST /api/conversations/:id/message multipart request body (file uploads). */
export const sendMessageMultipartSchema = z
  .object({
    message: z.string().min(1),
    files: z
      .array(z.string().openapi({ format: 'binary' }))
      .max(5)
      .optional()
      .openapi({ description: 'Maximum 5 files; each file must be ≤ 10 MB' }),
  })
  .openapi('SendMessageMultipartBody');

/** Response for dispatch endpoints (send message, run workflow). */
export const dispatchResponseSchema = z
  .object({
    accepted: z.boolean(),
    status: z.string(),
  })
  .openapi('DispatchResponse');
