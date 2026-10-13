import { noDefaultProviderMessage } from '@archon/provider-contract';
import { providerRegistry } from '@archon/providers';
import type { UpdateConversationInput } from '../schemas/conversation';
/**
 * Database operations for conversations
 */
import { lockConversationOwnership } from './conversation-ownership';
import { listConversationDetachBlockers } from './workflows';
import { pool, getDialect, getDatabase, getDatabaseType } from './connection';
import type { Codebase, Conversation } from '../types';
import { ConversationNotFoundError } from '../types';
import { createLogger } from '@archon/paths';
import {
  assertPublicConversation,
  assertPublicConversationIdentity,
  notOriginAnchor,
} from './workflow-origin-anchor';
import { loadConfig } from '../config/config-loader';
import { resolveProjectAssistant } from '../config/project-assistant';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.conversations');
  return cachedLog;
}

/**
 * Get a conversation by its database ID
 */
export async function getConversationById(id: string): Promise<Conversation | null> {
  assertPublicConversation(id);
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find a conversation by platform_conversation_id only (no platform_type filter).
 * Safe because all platform IDs are globally unique (they include platform prefix + timestamp + random).
 * Used by the Web UI API to load conversations from any platform.
 */
export async function findConversationByPlatformId(
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    `SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1 AND ${notOriginAnchor('id')}`,
    [platformId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get a conversation by platform type and platform ID
 * Returns null if not found (unlike getOrCreate which creates)
 */
export async function getConversationByPlatformId(
  platformType: string,
  platformId: string
): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    `SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2 AND ${notOriginAnchor('id')}`,
    [platformType, platformId]
  );
  return result.rows[0] ?? null;
}

export async function getOrCreateConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string,
  parentConversationId?: string,
  userId?: string
): Promise<Conversation> {
  assertPublicConversationIdentity(platformType, platformId);
  const existing = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [platformType, platformId]
  );

  if (existing.rows[0]) {
    // First-user-wins: do not overwrite user_id on subsequent messages in the
    // same thread from a different user. Per-message attribution lives on
    // workflow_runs/messages instead.
    return existing.rows[0];
  }

  // Check if we should inherit from a parent conversation (e.g., Discord thread inheriting from parent channel)
  let inheritedCodebaseId: string | null = null;
  let inheritedCwd: string | null = null;
  let assistantType: string | undefined;

  if (parentConversationId) {
    const parent = await pool.query<Conversation>(
      `SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2 AND ${notOriginAnchor('id')}`,
      [platformType, parentConversationId]
    );
    if (parent.rows[0]) {
      inheritedCodebaseId = parent.rows[0].codebase_id;
      inheritedCwd = parent.rows[0].cwd;
      assistantType = parent.rows[0].ai_assistant_type;
      getLog().debug(
        { inheritedCodebaseId, inheritedCwd },
        'db.conversation_parent_context_inherited'
      );
    }
  }

  // Use provided codebase or inherited codebase
  const finalCodebaseId = codebaseId ?? inheritedCodebaseId;

  // An explicitly scoped project overrides the parent conversation provider.
  if (codebaseId) {
    const codebase = await pool.query<Pick<Codebase, 'ai_assistant_type' | 'default_cwd'>>(
      'SELECT ai_assistant_type, default_cwd FROM remote_agent_codebases WHERE id = $1',
      [codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = await resolveProjectAssistant(codebase.rows[0]);
    }
  }

  // Personal defaults are applied per turn, so shared conversations store only
  // the project choice or configured default. Configuration errors must surface
  // rather than recording a different provider that could spend on later turns.
  if (assistantType === undefined) {
    assistantType = (await loadConfig()).assistant;
  }

  if (assistantType === undefined) throw new Error(noDefaultProviderMessage(providerRegistry));

  const created = await pool.query<Conversation>(
    'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [platformType, platformId, assistantType, finalCodebaseId, inheritedCwd, userId ?? null]
  );

  return created.rows[0];
}

export async function updateConversation(
  id: string,
  updates: UpdateConversationInput
): Promise<void> {
  assertPublicConversation(id);
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${String(i++)}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${String(i++)}`);
    values.push(updates.cwd);
  }
  if (updates.isolation_env_id !== undefined) {
    fields.push(`isolation_env_id = $${String(i++)}`);
    values.push(updates.isolation_env_id);
  }
  if (updates.hidden !== undefined) {
    fields.push(`hidden = $${String(i++)}`);
    values.push(updates.hidden ? 1 : 0);
  }

  if (fields.length === 0) {
    return; // No updates
  }

  const dialect = getDialect();
  fields.push(`updated_at = ${dialect.now()}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${String(i)}`,
    values
  );

  if (result.rowCount === 0) {
    getLog().error({ conversationId: id, fields, updates }, 'db.conversation_update_not_found');
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Find a conversation by isolation environment ID (legacy - single result)
 * Used for provider-based lookup and shared environment detection
 */
export async function getConversationByIsolationEnvId(envId: string): Promise<Conversation | null> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1 LIMIT 1',
    [envId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all conversations using a specific isolation environment (new UUID model)
 */
export async function getConversationsByIsolationEnvId(
  envId: string
): Promise<readonly Conversation[]> {
  const result = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows;
}

/**
 * List all conversations ordered by recent activity
 */
export async function listConversations(
  limit = 50,
  platformType?: string,
  codebaseId?: string,
  excludeEmpty = false,
  /**
   * Non-enforcing "mine" filter: when set, restrict to conversations attributed
   * to this user (`user_id = $N`). Absent → all (default visibility stays open).
   */
  userId?: string
): Promise<readonly Conversation[]> {
  const params: unknown[] = [];
  let sql =
    'SELECT * FROM remote_agent_conversations WHERE deleted_at IS NULL AND (hidden IS NULL OR hidden = false)';

  if (excludeEmpty) {
    sql +=
      ' AND (title IS NOT NULL OR EXISTS (SELECT 1 FROM remote_agent_messages WHERE conversation_id = remote_agent_conversations.id LIMIT 1))';
  }

  if (platformType) {
    params.push(platformType);
    sql += ` AND platform_type = $${String(params.length)}`;
  }

  if (codebaseId) {
    params.push(codebaseId);
    sql += ` AND codebase_id = $${String(params.length)}`;
  }

  if (userId) {
    params.push(userId);
    sql += ` AND user_id = $${String(params.length)}`;
  }

  sql += ' ORDER BY last_activity_at DESC NULLS LAST';
  params.push(limit);
  sql += ` LIMIT $${String(params.length)}`;

  const result = await pool.query<Conversation>(sql, params);
  return result.rows;
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
  assertPublicConversation(id);
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_conversations SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/**
 * Update conversation title
 */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  assertPublicConversation(id);
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET title = $1, updated_at = ${dialect.now()} WHERE id = $2`,
    [title, id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

/**
 * Soft delete a conversation (sets deleted_at timestamp)
 */
export async function softDeleteConversation(id: string): Promise<void> {
  assertPublicConversation(id);
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET deleted_at = ${dialect.now()}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}

export type ConversationDetachResult =
  | { status: 'detached'; projectName: string }
  | {
      status: 'refused';
      reason: 'parent-bound' | 'parent-changed' | 'neutral' | 'name';
    }
  | {
      status: 'blocked';
      runs: Awaited<ReturnType<typeof listConversationDetachBlockers>>;
      environmentId: string | null;
    };

export async function detachConversationProject(input: {
  conversationId: string;
  projectName: string;
  platformType: string;
  parentPlatformId?: string;
}): Promise<ConversationDetachResult> {
  return getDatabase().withTransaction(async query => {
    // SQLite must acquire its writer lock before the parent lookup creates a read snapshot.
    if (getDatabaseType() === 'sqlite') {
      await lockConversationOwnership(query, [input.conversationId]);
    }
    const findParent = async (): Promise<Conversation | undefined> => {
      if (!input.parentPlatformId) return undefined;
      const result = await query<Conversation>(
        `SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2 AND ${notOriginAnchor('id')}`,
        [input.platformType, input.parentPlatformId]
      );
      return result.rows[0];
    };
    const parent = await findParent();
    await lockConversationOwnership(query, [input.conversationId, ...(parent ? [parent.id] : [])]);
    const currentParent = await findParent();
    if (currentParent?.id !== parent?.id) return { status: 'refused', reason: 'parent-changed' };
    if (currentParent?.codebase_id) return { status: 'refused', reason: 'parent-bound' };
    const result = await query<Conversation>(
      'SELECT * FROM remote_agent_conversations WHERE id = $1',
      [input.conversationId]
    );
    const conversation = result.rows[0];
    if (!conversation) throw new ConversationNotFoundError(input.conversationId);
    if (!conversation.codebase_id) return { status: 'refused', reason: 'neutral' };
    if (!input.projectName.trim()) return { status: 'refused', reason: 'name' };
    const projects = await query<{ id: string; name: string }>(
      'SELECT id, name FROM remote_agent_codebases WHERE name = $1',
      [input.projectName]
    );
    // Both dialects compare names byte-for-byte, so case-only mismatches already miss here.
    if (projects.rows.length !== 1 || projects.rows[0].id !== conversation.codebase_id) {
      return { status: 'refused', reason: 'name' };
    }
    const runs = await listConversationDetachBlockers(query, conversation.id);
    if (runs.length || conversation.isolation_env_id !== null) {
      return { status: 'blocked', runs, environmentId: conversation.isolation_env_id };
    }
    await query(
      `UPDATE remote_agent_sessions
       SET active = false, ended_at = ${getDialect().now()}, ended_reason = 'project-changed'
       WHERE conversation_id = $1 AND active = true`,
      [conversation.id]
    );
    const cleared = await query(
      `UPDATE remote_agent_conversations
       SET codebase_id = NULL, cwd = NULL, isolation_env_id = NULL, updated_at = ${getDialect().now()}
       WHERE id = $1`,
      [conversation.id]
    );
    if (cleared.rowCount !== 1) throw new ConversationNotFoundError(conversation.id);
    return { status: 'detached', projectName: projects.rows[0].name };
  });
}
