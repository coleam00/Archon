/**
 * Database operations for sessions
 */
import { pool, getDialect, getDatabase } from './connection';
import type { Session, SessionMetadata } from '../types';
import { sessionMetadataSchema } from '../types';
import type { TransitionTrigger } from '../state/session-transitions';
import { createLogger } from '@harneeslab/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.sessions');
  return cachedLog;
}

/**
 * Error thrown when a session is not found during update operations
 */
export class SessionNotFoundError extends Error {
  constructor(public sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export async function getActiveSession(conversationId: string): Promise<Session | null> {
  const result = await pool.query<Session>(
    'SELECT * FROM remote_agent_sessions WHERE conversation_id = $1 AND active = true LIMIT 1',
    [conversationId]
  );
  return result.rows[0] || null;
}

export async function createSession(data: {
  conversation_id: string;
  codebase_id?: string;
  assistant_session_id?: string;
  ai_assistant_type: string;
  // Audit trail fields
  parent_session_id?: string;
  transition_reason?: TransitionTrigger; // Type-safe: only valid triggers allowed
}): Promise<Session> {
  const result = await pool.query<Session>(
    `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.conversation_id,
      data.codebase_id ?? null,
      data.ai_assistant_type,
      data.assistant_session_id ?? null,
      data.parent_session_id ?? null,
      data.transition_reason ?? null,
    ]
  );
  return result.rows[0];
}

export async function updateSession(id: string, sessionId: string): Promise<void> {
  const result = await pool.query(
    'UPDATE remote_agent_sessions SET assistant_session_id = $1 WHERE id = $2',
    [sessionId, id]
  );
  if (result.rowCount === 0) {
    throw new SessionNotFoundError(id);
  }
}

export async function deactivateSession(id: string, reason: TransitionTrigger): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_sessions SET active = false, ended_at = ${dialect.now()}, ended_reason = $2 WHERE id = $1`,
    [id, reason]
  );
  if (result.rowCount === 0) {
    throw new SessionNotFoundError(id);
  }
}

export async function updateSessionMetadata(id: string, metadata: SessionMetadata): Promise<void> {
  sessionMetadataSchema.parse(metadata); // throws ZodError if invalid
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_sessions SET metadata = ${dialect.jsonMerge('metadata', 1)} WHERE id = $2`,
    [JSON.stringify(metadata), id]
  );
  if (result.rowCount === 0) {
    throw new SessionNotFoundError(id);
  }
}

/**
 * Transition to a new session, linking to the previous one.
 * This creates audit trail by linking sessions via parent_session_id.
 *
 * @param conversationId - The conversation to transition
 * @param reason - Why we're transitioning (for audit trail)
 * @param data - Session data including codebase_id and ai_assistant_type
 * @returns The newly created session
 */
export async function transitionSession(
  conversationId: string,
  reason: TransitionTrigger,
  data: {
    codebase_id?: string;
    ai_assistant_type: string;
  }
): Promise<Session> {
  const db = getDatabase();
  const dialect = getDialect();

  return db.withTransaction(async query => {
    // 1. Read current active session
    const currentResult = await query<Session>(
      'SELECT * FROM remote_agent_sessions WHERE conversation_id = $1 AND active = true LIMIT 1',
      [conversationId]
    );
    const current = currentResult.rows[0] || null;

    // 2. Deactivate current session if exists
    if (current) {
      const deactivateResult = await query(
        `UPDATE remote_agent_sessions SET active = false, ended_at = ${dialect.now()}, ended_reason = $2 WHERE id = $1`,
        [current.id, reason]
      );
      if (deactivateResult.rowCount === 0) {
        throw new SessionNotFoundError(current.id);
      }
    }

    // 3. Create new session linked to previous
    const newResult = await query<Session>(
      `INSERT INTO remote_agent_sessions
     (conversation_id, codebase_id, ai_assistant_type, assistant_session_id, parent_session_id, transition_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
      [
        conversationId,
        data.codebase_id ?? null,
        data.ai_assistant_type,
        null,
        current?.id ?? null,
        reason,
      ]
    );

    const newSession = newResult.rows[0];
    getLog().debug(
      { conversationId, reason, parentSessionId: current?.id, newSessionId: newSession.id },
      'db.session_transition_completed'
    );
    return newSession;
  });
}

/**
 * Get session history for a conversation (most recent first).
 * Useful for debugging agent decision history.
 */
export async function getSessionHistory(conversationId: string): Promise<readonly Session[]> {
  const result = await pool.query<Session>(
    `SELECT * FROM remote_agent_sessions
     WHERE conversation_id = $1
     ORDER BY started_at DESC`,
    [conversationId]
  );
  return result.rows;
}

/**
 * Walk the session chain from a given session back to the root.
 * Returns sessions in chronological order (oldest first).
 */
export async function getSessionChain(sessionId: string): Promise<readonly Session[]> {
  const result = await pool.query<Session>(
    `WITH RECURSIVE chain AS (
       SELECT * FROM remote_agent_sessions WHERE id = $1
       UNION ALL
       SELECT s.* FROM remote_agent_sessions s
       JOIN chain c ON s.id = c.parent_session_id
     )
     SELECT * FROM chain ORDER BY started_at ASC`,
    [sessionId]
  );
  return result.rows;
}

/**
 * Delete inactive sessions older than the specified number of days.
 * Only deletes sessions where active = false (never touches active sessions).
 *
 * @param retentionDays - Delete sessions ended more than this many days ago
 * @returns Number of deleted sessions
 */
export async function deleteOldSessions(retentionDays: number): Promise<number> {
  const dialect = getDialect();
  const result = await pool.query(
    `DELETE FROM remote_agent_sessions
     WHERE active = false
       AND ended_at IS NOT NULL
       AND ended_at < ${dialect.nowMinusDays(1)}`,
    [retentionDays]
  );
  const count = result.rowCount;
  if (count > 0) {
    getLog().info({ deletedCount: count, retentionDays }, 'sessions.cleanup_completed');
  }
  return count;
}
