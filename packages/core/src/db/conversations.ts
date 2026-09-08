/**
 * Database operations for conversations
 */
import { pool, getDialect } from './connection';
import { toDbTimestampParam } from './timestamps';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';
import { createLogger } from '@archon/paths';
import { loadConfig } from '../config/config-loader';

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
    'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
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
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
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
      'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
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

  // Determine assistant type from codebase if provided (overrides inherited)
  if (codebaseId) {
    const codebase = await pool.query<{ ai_assistant_type: string }>(
      'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
      [codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = codebase.rows[0].ai_assistant_type;
    }
  }

  // No parent or codebase signal: resolve the configured default assistant
  // instead of hard-defaulting to Claude (#2241). loadConfig() owns the
  // fallback chain — explicit config (repo assistant > global defaultAssistant)
  // > DEFAULT_AI_ASSISTANT env > first registered built-in provider. The
  // per-user default assistant (#1998) deliberately stays OUT of this row: the
  // orchestrator applies it per turn (userAiPrefs.defaultProvider ??
  // conversation.ai_assistant_type), sender-first (#1982), so a personal
  // preference is never baked into a shared conversation.
  if (assistantType === undefined) {
    try {
      const config = await loadConfig();
      assistantType = config.assistant;
    } catch (err) {
      // Intentional fallback: a broken config (e.g. an unregistered
      // DEFAULT_AI_ASSISTANT value makes loadConfig throw) must not block
      // conversation creation — the turn itself surfaces config errors.
      getLog().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'db.conversation_default_assistant_config_load_failed'
      );
    }
  }
  assistantType ??= 'claude';

  const created = await pool.query<Conversation>(
    'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [platformType, platformId, assistantType, finalCodebaseId, inheritedCwd, userId ?? null]
  );

  return created.rows[0];
}

export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd' | 'isolation_env_id'>> & {
    hidden?: boolean;
  }
): Promise<void> {
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
 * Conversation surfaces privacy applies to (#3135). Web and CLI are operator
 * surfaces: one human at a keyboard driving their own Archon. Slack, Discord,
 * Telegram, GitHub, GitLab, and Gitea are deliberately excluded — those
 * platforms already own their access model, and a webhook author frequently
 * does not resolve to an Archon user at all, so enforcing here would hide a
 * team's forge conversations from everyone.
 */
export const PRIVATE_PLATFORM_TYPES = ['web', 'cli'] as const;

/**
 * Whether privacy applies to a single conversation. The per-row counterpart of
 * the `platform_type NOT IN (…)` clause `listConversations` builds, so the list
 * and the by-id authorization check share one rule instead of two hand-written
 * ones that can drift.
 */
export function isPrivatePlatformType(platformType: string): boolean {
  return (PRIVATE_PLATFORM_TYPES as readonly string[]).includes(platformType);
}

/**
 * Which conversations a lookup may return. Explicit union rather than an
 * optional `userId`, because `undefined` meaning "no filter" is exactly what
 * let a failed identity resolution silently widen a narrowed request back to
 * every conversation on the install. "Everything" now has to be asked for by
 * name.
 */
export type ConversationVisibility =
  | { kind: 'all' }
  | { kind: 'ownerScoped'; userId: string; privatePlatforms: readonly string[] };

/**
 * List all conversations ordered by recent activity.
 *
 * `visibility` is required and has no default: an omitted argument would
 * reproduce the silent widening this parameter exists to remove.
 */
export async function listConversations(
  limit = 50,
  platformType: string | undefined,
  codebaseId: string | undefined,
  excludeEmpty: boolean,
  visibility: ConversationVisibility
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

  if (visibility.kind === 'ownerScoped') {
    // The caller's own operator conversations, plus everything on a platform
    // privacy does not cover. Fail-closed by construction: `user_id IS NULL`
    // never equals a resolved id, so an unattributed row matches nobody.
    // Each platform is its own placeholder — neither dialect binds arrays.
    const exempt = visibility.privatePlatforms.map(platform => {
      params.push(platform);
      return `$${String(params.length)}`;
    });
    params.push(visibility.userId);
    const userParam = `$${String(params.length)}`;
    sql +=
      exempt.length > 0
        ? ` AND (platform_type NOT IN (${exempt.join(', ')}) OR user_id = ${userParam})`
        : ` AND user_id = ${userParam}`;
  }

  sql += ' ORDER BY last_activity_at DESC NULLS LAST';
  params.push(limit);
  sql += ` LIMIT $${String(params.length)}`;

  const result = await pool.query<Conversation>(sql, params);
  return result.rows;
}

/**
 * Which rows an ownership claim may touch (#3135 Phase 7).
 *
 * Conversations and workflow runs are claimed with the same filter, so the
 * `list --unowned` preview cannot describe a different set than the UPDATE
 * writes.
 */
export interface OwnerlessClaimFilter {
  /**
   * Operator surfaces to include. The CLI defaults to PRIVATE_PLATFORM_TYPES;
   * an empty list matches nothing rather than everything.
   */
  platformTypes: readonly string[];
  /**
   * Only rows older than this instant: `created_at` for conversations,
   * `started_at` for runs. Optional (`--before`).
   */
  before?: Date;
}

/**
 * The one WHERE fragment both ownerless-conversation queries are built from, so
 * the preview and the UPDATE cannot drift apart. Appends to `params` and
 * returns the SQL.
 *
 * `user_id IS NULL` is the invariant that makes claiming safe: a row already
 * owned by a real user can never be moved to another one, so the worst outcome
 * of a mistaken claim is rows landing on the wrong user and needing to be moved
 * again by hand — never a conversation taken away from its owner.
 */
function ownerlessConversationWhere(filter: OwnerlessClaimFilter, params: unknown[]): string {
  const platforms = filter.platformTypes.map(platform => {
    params.push(platform);
    return `$${String(params.length)}`;
  });
  let sql = `user_id IS NULL AND deleted_at IS NULL AND platform_type IN (${platforms.join(', ')})`;
  if (filter.before) {
    params.push(toDbTimestampParam(filter.before));
    sql += ` AND created_at < $${String(params.length)}`;
  }
  return sql;
}

/**
 * Every conversation an ownership claim with this filter would take.
 *
 * Includes hidden worker conversations: they carry the same operator's work and
 * are exactly as unreachable as their visible parents once enforcement is on.
 */
export async function listOwnerlessConversations(
  filter: OwnerlessClaimFilter
): Promise<readonly Conversation[]> {
  // Fail closed: no platform selected means no row selected.
  if (filter.platformTypes.length === 0) return [];

  const params: unknown[] = [];
  const where = ownerlessConversationWhere(filter, params);
  const result = await pool.query<Conversation>(
    `SELECT * FROM remote_agent_conversations WHERE ${where} ORDER BY last_activity_at DESC NULLS LAST`,
    params
  );
  return result.rows;
}

/**
 * Attach every unowned conversation matching the filter to `userId`, returning
 * how many rows moved. The escape hatch for an install that turns web auth on
 * and finds its pre-enforcement history reachable by nobody.
 */
export async function claimOwnerlessConversations(
  userId: string,
  filter: OwnerlessClaimFilter
): Promise<number> {
  if (filter.platformTypes.length === 0) return 0;

  const params: unknown[] = [userId];
  const where = ownerlessConversationWhere(filter, params);
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET user_id = $1, updated_at = ${dialect.now()} WHERE ${where}`,
    params
  );
  return result.rowCount ?? 0;
}

/**
 * Update last_activity_at for staleness tracking
 */
export async function touchConversation(id: string): Promise<void> {
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
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_conversations SET deleted_at = ${dialect.now()}, updated_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new ConversationNotFoundError(id);
  }
}
