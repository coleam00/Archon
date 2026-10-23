import { unlink } from 'fs/promises';
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AttachedFile, Conversation, HandleMessageContext } from '@archon/core';
import * as messageDb from '@archon/core/db/messages';
import type { WebAdapter } from '../adapters/web';
import { DASHBOARD_STREAM } from '../adapters/web/transport';
import { isConversationOwnershipEnforced } from '../auth';
import { type OrchestratorDispatch, persistUploadedFiles } from './api-message-dispatch';
import { authorizeConversation, authorizeDispatchConversation } from './api-request-auth';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import { toApiMessage } from './api-serializers';
import {
  conversationIdParamsSchema,
  dispatchResponseSchema,
  listMessagesQuerySchema,
  messageListResponseSchema,
} from './schemas/conversation.schemas';

const listMessagesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/messages',
  tags: ['Conversations'],
  summary: 'List message history for a conversation',
  request: {
    params: conversationIdParamsSchema,
    query: listMessagesQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: messageListResponseSchema } },
      description: 'Message list',
    },
    404: jsonError('Not found'),
    401: jsonError('Authentication required'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

// Body validation is handled manually in the handler (multipart vs JSON branching).
// Declaring both content types in the OpenAPI route causes @hono/zod-openapi to
// validate JSON bodies against the multipart schema. We keep `request.body` empty
// and document the schemas via the OpenAPI spec comments instead.
const sendMessageRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/message',
  tags: ['Conversations'],
  summary: 'Send a message (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ message: string }` or `multipart/form-data` ' +
    'with a `message` field and optional file attachments (max 5 files, 10 MB each).',
  request: {
    params: conversationIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    401: jsonError('Authentication required'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

export function registerMessageRoutes(
  app: OpenAPIHono,
  {
    webAdapter,
    dispatchToOrchestrator,
  }: { webAdapter: WebAdapter; dispatchToOrchestrator: OrchestratorDispatch }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/conversations/:id/messages - Message history
  registerOpenApiRoute(listMessagesRoute, async c => {
    const platformConversationId = c.req.param('id') ?? '';
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
    try {
      const access = await authorizeConversation(c, { platformId: platformConversationId }, 'read');
      if ('error' in access) return access.error;
      const messages = await messageDb.listMessages(access.conversation.id, limit);
      return c.json(messages.map(toApiMessage));
    } catch (error) {
      getLog().error({ err: error }, 'list_messages_failed');
      return apiError(c, 500, 'Failed to list messages');
    }
  });

  // POST /api/conversations/:id/message - Send message
  // Manual body parsing: multipart uses parseBody(), JSON uses req.json().
  registerOpenApiRoute(sendMessageRoute, async c => {
    const conversationId = c.req.param('id') ?? '';

    // Reject conversation IDs that could be used for path traversal when building
    // the upload directory. Web conversation IDs are alphanumeric with hyphens only.
    if (!/^[\w-]+$/.test(conversationId)) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    // Before the body is read, so a refused caller writes no attachment into the
    // conversation's upload directory.
    const access = await authorizeDispatchConversation(c, conversationId);
    if ('error' in access) return access.error;
    const { conversation: conv, actor } = access;

    const body = await readMessageBody(c, conversationId);
    if (body instanceof Response) return body;
    const { message, savedFiles } = body;

    // Persist user message and pass DB ID to adapter for assistant message persistence
    if (conv) {
      const userId = actor.kind === 'user' ? actor.userId : undefined;
      const refused = await persistUserMessage(c, conv, conversationId, body, userId);
      if (refused) return refused;
      webAdapter.setConversationDbId(conversationId, conv.id);
    }

    // Pass savedFiles to dispatchToOrchestrator so cleanup happens inside the lock handler,
    // AFTER handleMessage completes — not in the HTTP handler's finally block where the
    // fire-and-forget lock callback may still be running and the AI has not yet read the files.
    const extraContext: Omit<HandleMessageContext, 'isolationHints'> = {
      actor,
      ...(savedFiles.length > 0 ? { attachedFiles: savedFiles } : {}),
    };
    const filesToCleanup = savedFiles.length > 0 ? savedFiles : undefined;
    const result = await dispatchToOrchestrator(
      conversationId,
      message,
      extraContext,
      filesToCleanup
    );
    return c.json(result);
  });

  // GET /api/stream/__dashboard__ — dashboard SSE (workflow lifecycle events)
  // IMPORTANT: Must be registered before /api/stream/:conversationId to avoid param capture.
  app.get(`/api/stream/${DASHBOARD_STREAM}`, async c => {
    return streamSSE(c, async stream => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(DASHBOARD_STREAM, stream);
      getLog().debug({ streamId: DASHBOARD_STREAM }, 'dashboard_sse_opened');

      stream.onAbort(() => {
        getLog().debug({ streamId: DASHBOARD_STREAM }, 'dashboard_sse_disconnected');
        webAdapter.removeStream(DASHBOARD_STREAM, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error }, 'dashboard_sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(DASHBOARD_STREAM, stream);
        getLog().debug({ streamId: DASHBOARD_STREAM }, 'dashboard_sse_closed');
      }
    });
  });

  // GET /api/stream/:conversationId - SSE streaming
  app.get('/api/stream/:conversationId', async c => {
    const conversationId = c.req.param('conversationId');

    // Decided before streamSSE owns the response, so a refused caller gets a JSON
    // error rather than an open stream. A solo install skips the lookup and keeps
    // streaming ids whose row has not been written yet.
    if (isConversationOwnershipEnforced()) {
      try {
        const access = await authorizeConversation(
          c,
          { webFirstPlatformId: conversationId },
          'read'
        );
        if ('error' in access) return access.error;
      } catch (err: unknown) {
        getLog().error({ err, conversationId }, 'sse_stream_authorize_failed');
        return apiError(c, 500, 'Failed to load conversation');
      }
    }

    return streamSSE(c, async stream => {
      // Send initial heartbeat immediately to flush HTTP headers.
      // Without this, EventSource stays in CONNECTING state until the first write.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(conversationId, stream);
      getLog().debug({ conversationId }, 'sse_stream_opened');

      stream.onAbort(() => {
        getLog().debug({ conversationId }, 'sse_client_disconnected');
        webAdapter.removeStream(conversationId, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        // stream.sleep() throws when client disconnects — expected behavior.
        // Log unexpected errors for debugging.
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error, conversationId }, 'sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(conversationId, stream);
        getLog().debug({ conversationId }, 'sse_stream_closed');
      }
    });
  });
}

interface MessageBody {
  message: string;
  savedFiles: AttachedFile[];
}

/** The message and its saved attachments, or the response that refuses the body. */
function readMessageBody(c: Context, conversationId: string): Promise<MessageBody | Response> {
  const contentType = c.req.header('content-type') ?? '';
  return contentType.includes('multipart/form-data')
    ? readMultipartMessage(c, conversationId)
    : readJsonMessage(c, conversationId);
}

async function readMultipartMessage(
  c: Context,
  conversationId: string
): Promise<MessageBody | Response> {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (parseErr: unknown) {
    getLog().warn({ err: parseErr, conversationId }, 'upload.parse_failed');
    return c.json({ error: 'Invalid multipart form data' }, 400);
  }

  const message = body.message;
  if (typeof message !== 'string' || !message) {
    return c.json({ error: 'message must be a non-empty string' }, 400);
  }

  const fileEntries: File[] = [];
  for (const entry of formEntries(body.files)) {
    if (!(entry instanceof File)) {
      return c.json({ error: 'files must contain only file parts' }, 400);
    }
    fileEntries.push(entry);
  }
  if (fileEntries.length === 0) return { message, savedFiles: [] };
  const result = await persistUploadedFiles(conversationId, fileEntries);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  getLog().info({ conversationId, fileCount: result.savedFiles.length }, 'message.files_uploaded');
  return { message, savedFiles: result.savedFiles };
}

/** A multipart field parsed with `all: true` is absent, one entry, or a list of them. */
function formEntries(raw: string | File | (string | File)[] | undefined): (string | File)[] {
  if (Array.isArray(raw)) return raw;
  return raw === undefined ? [] : [raw];
}

async function readJsonMessage(
  c: Context,
  conversationId: string
): Promise<MessageBody | Response> {
  let body: { message?: unknown };
  try {
    body = await c.req.json();
  } catch (parseErr: unknown) {
    getLog().warn({ err: parseErr, conversationId }, 'message.json_parse_failed');
    return c.json({ error: 'Invalid JSON in request body' }, 400);
  }

  if (typeof body.message !== 'string' || !body.message) {
    return c.json({ error: 'message must be a non-empty string' }, 400);
  }
  return { message: body.message, savedFiles: [] };
}

/** Saves the user message to history; on failure removes its uploads and returns the 500. */
async function persistUserMessage(
  c: Context,
  conv: Conversation,
  conversationId: string,
  { message, savedFiles }: MessageBody,
  userId: string | undefined
): Promise<Response | undefined> {
  // Omit path from persisted metadata — the on-disk file is ephemeral and will be
  // deleted after the AI processes it; storing stale paths would confuse future readers.
  const meta =
    savedFiles.length > 0
      ? { files: savedFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size })) }
      : undefined;
  try {
    await messageDb.addMessage(conv.id, 'user', message, meta, userId);
    return undefined;
  } catch (e: unknown) {
    getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
    for (const file of savedFiles) {
      await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, filePath: file.path, conversationId }, 'upload.rollback_failed');
        }
      });
    }
    return apiError(c, 500, 'Failed to save message to history');
  }
}
