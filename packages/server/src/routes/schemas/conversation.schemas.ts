/**
 * Zod schemas for conversation and message API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { conversationRowSchema } from '@archon/core/schemas/conversation';
import { messageRowSchema } from '@archon/core/schemas/message';

/** A conversation record (wire shape with ISO string dates). */
export const conversationSchema = conversationRowSchema
  .extend({
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    deleted_at: z.string().datetime().nullable(),
    last_activity_at: z.string().datetime().nullable(),
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

/** A single message row (wire shape). */
export const messageSchema = messageRowSchema
  .extend({
    created_at: z.string().datetime(),
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
