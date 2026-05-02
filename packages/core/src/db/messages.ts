/**
 * Database operations for conversation messages (Web UI history and orchestrator prompt enrichment)
 */
import { pool, getDialect, getDatabaseType } from './connection';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.messages');
  return cachedLog;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: string; // JSON string - parsed by frontend and server-side (orchestrator prompt enrichment)
  created_at: string;
}

/**
 * Add a message to conversation history.
 * metadata should contain toolCalls array and/or error object if applicable.
 */
export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: Record<string, unknown>
): Promise<MessageRow> {
  const dialect = getDialect();
  const result = await pool.query<MessageRow>(
    `INSERT INTO remote_agent_messages (conversation_id, role, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, ${dialect.now()})
     RETURNING *`,
    [conversationId, role, content, JSON.stringify(metadata ?? {})]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to persist message: INSERT returned no rows (conversation: ${conversationId})`
    );
  }
  getLog().debug({ conversationId, role, messageId: row.id }, 'db.message_persist_completed');
  return row;
}

/**
 * List the most recent messages for a conversation, returned oldest-first.
 *
 * The DB query orders DESC and takes the top `limit` (i.e. the newest N), then
 * reverses to oldest-first for the chronological-display contract callers
 * expect. This matters for conversations with more than `limit` messages: the
 * previous "ORDER BY created_at ASC" returned the *oldest* N, which made the
 * latest messages invisible in the Web UI for any conversation past the cap.
 *
 * conversationId is the database UUID (not platform_conversation_id).
 */
export async function listMessages(
  conversationId: string,
  limit = 200
): Promise<readonly MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  // Reverse to oldest-first so callers don't have to. (DB-side reverse via
  // a subquery is also possible but adds a layer of indirection for no gain.)
  return [...result.rows].reverse();
}

/**
 * Get recent messages with workflowResult metadata for a conversation.
 * Used to inject workflow context into the orchestrator prompt.
 * Non-throwing — returns empty array on error.
 */
export async function getRecentWorkflowResultMessages(
  conversationId: string,
  limit = 3
): Promise<readonly MessageRow[]> {
  const dbType = getDatabaseType();
  const metadataFilter =
    dbType === 'postgresql'
      ? "(metadata->>'workflowResult') IS NOT NULL"
      : "json_extract(metadata, '$.workflowResult') IS NOT NULL";
  try {
    const result = await pool.query<Pick<MessageRow, 'id' | 'content' | 'metadata'>>(
      `SELECT id, content, metadata FROM remote_agent_messages
       WHERE conversation_id = $1
       AND ${metadataFilter}
       ORDER BY created_at DESC
       LIMIT $2`,
      [conversationId, limit]
    );
    return result.rows as MessageRow[];
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, conversationId }, 'db.workflow_result_messages_query_failed');
    return [];
  }
}
