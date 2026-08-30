/**
 * Database operations for codebases
 */
import { sep as pathSep } from 'path';
import { pool, getDialect } from './connection';
import type { Codebase } from '../types';
import { createLogger, captureCodebaseRegistered } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.codebases');
  return cachedLog;
}

/**
 * Create a new codebase record in the database.
 *
 * @param data - Codebase creation properties including name, repository URL, default cwd, branch, assistant type, and project kind.
 * @returns The created Codebase record.
 * @throws Error if the INSERT query fails to return a row.
 */
export async function createCodebase(data: {
  name: string;
  repository_url?: string;
  default_cwd: string;
  default_branch?: string | null;
  ai_assistant_type?: string;
  kind?: 'repo' | 'folder';
}): Promise<Codebase> {
  const assistantType = data.ai_assistant_type ?? process.env.DEFAULT_AI_ASSISTANT ?? 'claude';
  const result = await pool.query<Codebase>(
    'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, default_branch, ai_assistant_type, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [
      data.name,
      data.repository_url ?? null,
      data.default_cwd,
      data.default_branch ?? null,
      assistantType,
      data.kind ?? 'repo',
    ]
  );
  if (!result.rows[0]) {
    throw new Error('Failed to create codebase: INSERT succeeded but no row returned');
  }
  // Anonymous count-only telemetry (activation funnel: install → registered a
  // project). Every registration surface (HTTP clone/register, /register-project
  // chat command) funnels through this INSERT — no name/path/URL is ever sent.
  captureCodebaseRegistered();
  return result.rows[0];
}

/**
 * Retrieve a codebase by its unique identifier (unscoped).
 *
 * @param id - The unique ID of the codebase.
 * @returns The matching Codebase or null if not found.
 */
export async function getCodebase(id: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>('SELECT * FROM remote_agent_codebases WHERE id = $1', [
    id,
  ]);
  return result.rows[0] || null;
}

/**
 * Retrieve a codebase by its unique identifier, scoped to an authenticated user's access grants.
 *
 * @param id - The unique ID of the codebase.
 * @param userId - Optional user ID. When provided, ensures the user has access; when omitted, delegates to unscoped lookup.
 * @returns The matching Codebase if accessible, or null if not found or unauthorized.
 */
export async function getCodebaseForUser(id: string, userId?: string): Promise<Codebase | null> {
  if (!userId) {
    return getCodebase(id);
  }
  const result = await pool.query<Codebase>(
    `SELECT c.* FROM remote_agent_codebases c
     JOIN remote_agent_user_codebase_access a ON a.codebase_id = c.id
     WHERE a.user_id = $1 AND c.id = $2
     LIMIT 1`,
    [userId, id]
  );
  return result.rows[0] || null;
}

/**
 * Update the custom workflow commands registered for a codebase.
 *
 * @param id - The unique ID of the codebase.
 * @param commands - Map of command names to command specifications.
 * @returns Promise resolving when update completes.
 */
export async function updateCodebaseCommands(
  id: string,
  commands: Record<string, { path: string; description: string }>
): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_codebases SET commands = $1, updated_at = ${dialect.now()} WHERE id = $2`,
    [JSON.stringify(commands), id]
  );
}

/**
 * Retrieve custom workflow commands registered for a codebase.
 *
 * @param id - The unique ID of the codebase.
 * @returns Map of command names to their specifications.
 * @throws Error if stored commands JSON is corrupted.
 */
export async function getCodebaseCommands(
  id: string
): Promise<Record<string, { path: string; description: string }>> {
  const result = await pool.query<{
    commands: Record<string, { path: string; description: string }> | string;
  }>('SELECT commands FROM remote_agent_codebases WHERE id = $1', [id]);
  const raw = result.rows[0]?.commands;
  // SQLite returns TEXT columns as strings; PostgreSQL JSONB returns objects
  let parsed: Record<string, { path: string; description: string }>;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      getLog().error({ codebaseId: id, raw, err }, 'db.codebase_commands_json_parse_failed');
      throw new Error(
        `Corrupt commands JSON for codebase ${id}: unable to parse stored data. ` +
          `Run UPDATE remote_agent_codebases SET commands = '{}' WHERE id = '${id}' to reset.`
      );
    }
  } else {
    parsed = raw ?? {};
  }
  // Spread to ensure mutable copy - Bun's SQLite driver returns frozen objects
  return { ...parsed };
}

/**
 * Register or update a single custom command for a codebase.
 *
 * @param id - The unique ID of the codebase.
 * @param name - The command name/identifier.
 * @param command - The command specification containing file path and description.
 * @returns Promise resolving when the command is registered.
 */
export async function registerCommand(
  id: string,
  name: string,
  command: { path: string; description: string }
): Promise<void> {
  const commands = await getCodebaseCommands(id);
  commands[name] = command;
  await updateCodebaseCommands(id, commands);
}

/**
 * Find a codebase by its git repository URL (unscoped).
 *
 * @param repoUrl - The git repository URL to match.
 * @returns The matching Codebase or null if not found.
 */
export async function findCodebaseByRepoUrl(repoUrl: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE repository_url = $1',
    [repoUrl]
  );
  return result.rows[0] || null;
}

/**
 * Find a codebase by its repository URL, scoped to an authenticated user.
 *
 * @param url - The repository URL.
 * @param userId - Optional user ID to constrain access.
 * @returns The matching Codebase or null.
 */
export async function findCodebaseByRepoUrlForUser(
  url: string,
  userId?: string
): Promise<Codebase | null> {
  if (!userId) {
    return findCodebaseByRepoUrl(url);
  }
  const result = await pool.query<Codebase>(
    `SELECT c.* FROM remote_agent_codebases c
     JOIN remote_agent_user_codebase_access a ON a.codebase_id = c.id
     WHERE a.user_id = $1 AND c.repository_url = $2
     ORDER BY c.created_at DESC LIMIT 1`,
    [userId, url]
  );
  return result.rows[0] || null;
}

/**
 * Find a codebase by its exact default working directory path (unscoped).
 *
 * @param defaultCwd - The exact directory path to look up.
 * @returns The matching Codebase or null if not found.
 */
export async function findCodebaseByDefaultCwd(defaultCwd: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE default_cwd = $1 ORDER BY created_at DESC LIMIT 1',
    [defaultCwd]
  );
  return result.rows[0] || null;
}

/**
 * Find a codebase by its default working directory path, scoped to an authenticated user.
 *
 * @param cwd - The working directory path.
 * @param userId - Optional user ID to constrain access.
 * @returns The matching Codebase or null.
 */
export async function findCodebaseByDefaultCwdForUser(
  cwd: string,
  userId?: string
): Promise<Codebase | null> {
  if (!userId) {
    return findCodebaseByDefaultCwd(cwd);
  }
  const result = await pool.query<Codebase>(
    `SELECT c.* FROM remote_agent_codebases c
     JOIN remote_agent_user_codebase_access a ON a.codebase_id = c.id
     WHERE a.user_id = $1 AND c.default_cwd = $2
     ORDER BY c.created_at DESC LIMIT 1`,
    [userId, cwd]
  );
  return result.rows[0] || null;
}

/**
 * Find a codebase whose `default_cwd` equals `cwdPath` or is a true ancestor
 * DIRECTORY of it (boundary-anchored on the path separator). Used for
 * subdirectory runs (worktree subdirs, or a subdirectory of a folder-project
 * root) where an exact `findCodebaseByDefaultCwd` match returns null.
 *
 * Matching is done in application code, NOT via SQL `LIKE default_cwd || '%'`,
 * which was wrong on two counts: (1) `_`/`%` in a stored path are LIKE
 * wildcards, and (2) a bare `%` suffix has no separator boundary, so a sibling
 * directory sharing a name prefix (`/x/platform` vs `/x/platform-staging`)
 * would match. Returns the most specific (longest `default_cwd`) match.
 *
 * @param cwdPath - The working directory path to resolve against codebase roots.
 * @returns The most specific matching Codebase, or null if no codebase encompasses the path.
 */
export async function findCodebaseByPathPrefix(cwdPath: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>('SELECT * FROM remote_agent_codebases');
  let best: Codebase | null = null;
  for (const row of result.rows) {
    const base = row.default_cwd;
    const isMatch = cwdPath === base || cwdPath.startsWith(base + pathSep);
    if (isMatch && (best === null || base.length > best.default_cwd.length)) {
      best = row;
    }
  }
  return best;
}

/**
 * Find a codebase by its exact registered name (unscoped).
 *
 * @param name - The codebase project name.
 * @returns The matching Codebase or null.
 */
export async function findCodebaseByName(name: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
    [name]
  );
  return result.rows[0] || null;
}

/**
 * Find a codebase by name, scoped to an authenticated user.
 *
 * @param name - The codebase project name.
 * @param userId - Optional user ID to constrain access.
 * @returns The matching Codebase or null.
 */
export async function findCodebaseByNameForUser(
  name: string,
  userId?: string
): Promise<Codebase | null> {
  if (!userId) {
    return findCodebaseByName(name);
  }
  const result = await pool.query<Codebase>(
    `SELECT c.* FROM remote_agent_codebases c
     JOIN remote_agent_user_codebase_access a ON a.codebase_id = c.id
     WHERE a.user_id = $1 AND c.name = $2
     ORDER BY c.created_at DESC LIMIT 1`,
    [userId, name]
  );
  return result.rows[0] || null;
}

/**
 * Error thrown when an UPDATE matched no codebase row (row deleted between
 * fetch and update). Lets callers distinguish "row gone" from operational
 * DB failures (connection refused, timeout, constraint violation).
 */
export class CodebaseNotFoundError extends Error {
  /**
   * @param codebaseId - The ID of the codebase that was not found.
   */
  constructor(public codebaseId: string) {
    super(`Codebase ${codebaseId} not found`);
    this.name = 'CodebaseNotFoundError';
  }
}

/**
 * Update properties of an existing codebase record.
 *
 * @param id - The unique ID of the codebase to update.
 * @param data - Partial codebase fields to update (default_cwd, repository_url, default_branch).
 * @returns Promise resolving when update is complete.
 * @throws CodebaseNotFoundError if the target codebase row does not exist.
 */
export async function updateCodebase(
  id: string,
  data: { default_cwd?: string; repository_url?: string | null; default_branch?: string | null }
): Promise<void> {
  const dialect = getDialect();
  const updates: string[] = [];
  const values: (string | null)[] = [];
  let paramIndex = 1;

  if (data.default_cwd !== undefined) {
    updates.push(`default_cwd = $${paramIndex++}`);
    values.push(data.default_cwd);
  }

  if (data.repository_url !== undefined) {
    updates.push(`repository_url = $${paramIndex++}`);
    values.push(data.repository_url);
  }

  if (data.default_branch !== undefined) {
    updates.push(`default_branch = $${paramIndex++}`);
    values.push(data.default_branch);
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = ${dialect.now()}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_codebases SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new CodebaseNotFoundError(id);
  }
}

/**
 * List all registered codebases ordered by name (unscoped/global).
 *
 * @returns Readonly array of all codebases.
 */
export async function listCodebases(): Promise<readonly Codebase[]> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases ORDER BY name ASC'
  );
  return result.rows;
}

/**
 * Delete a codebase record and unlink associated sessions and conversations.
 *
 * @param id - The unique ID of the codebase to delete.
 * @returns Promise resolving when deletion and cascades complete.
 */
export async function deleteCodebase(id: string): Promise<void> {
  getLog().debug({ codebaseId: id }, 'db.codebase_delete_cascade_started');
  // First, unlink any sessions referencing this codebase (FK has no cascade)
  await pool.query('UPDATE remote_agent_sessions SET codebase_id = NULL WHERE codebase_id = $1', [
    id,
  ]);
  // Second, unlink any conversations referencing this codebase (FK has no cascade)
  await pool.query(
    'UPDATE remote_agent_conversations SET codebase_id = NULL WHERE codebase_id = $1',
    [id]
  );
  // Then delete the codebase
  await pool.query('DELETE FROM remote_agent_codebases WHERE id = $1', [id]);
  getLog().info({ codebaseId: id }, 'db.codebase_delete_completed');
}

/**
 * List all codebases accessible to a specific user.
 *
 * @param userId - The user ID whose accessible codebases to retrieve.
 * @returns Readonly array of codebases accessible to the specified user.
 */
export async function listCodebasesForUser(userId: string): Promise<readonly Codebase[]> {
  const result = await pool.query<Codebase>(
    `SELECT c.* FROM remote_agent_codebases c
     JOIN remote_agent_user_codebase_access a ON a.codebase_id = c.id
     WHERE a.user_id = $1
     ORDER BY c.name ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Grant a user access to a specific codebase.
 *
 * @param userId - The user ID receiving access.
 * @param codebaseId - The codebase ID to grant access to.
 * @returns Promise resolving when access grant is recorded.
 */
export async function grantAccess(userId: string, codebaseId: string): Promise<void> {
  await pool.query(
    `INSERT INTO remote_agent_user_codebase_access (user_id, codebase_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, codebase_id) DO NOTHING`,
    [userId, codebaseId]
  );
  getLog().info({ userId, codebaseId }, 'db.codebase_access_granted');
}
