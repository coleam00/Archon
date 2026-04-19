/**
 * Database operations for codebases
 */
import { pool, getDialect } from './connection';
import type { Codebase } from '../types';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.codebases');
  return cachedLog;
}

export async function createCodebase(data: {
  name: string;
  repository_url?: string;
  default_cwd: string;
  ai_assistant_type?: string;
}): Promise<Codebase> {
  const assistantType = data.ai_assistant_type ?? 'claude';
  const result = await pool.query<Codebase>(
    'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, ai_assistant_type) VALUES ($1, $2, $3, $4) RETURNING *',
    [data.name, data.repository_url ?? null, data.default_cwd, assistantType]
  );
  if (!result.rows[0]) {
    throw new Error('Failed to create codebase: INSERT succeeded but no row returned');
  }
  return result.rows[0];
}

export async function getCodebase(id: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>('SELECT * FROM remote_agent_codebases WHERE id = $1', [
    id,
  ]);
  return result.rows[0] || null;
}

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
    } catch {
      getLog().error({ codebaseId: id, raw }, 'db.codebase_commands_json_parse_failed');
      return {};
    }
  } else {
    parsed = raw ?? {};
  }
  // Spread to ensure mutable copy - Bun's SQLite driver returns frozen objects
  return { ...parsed };
}

export async function registerCommand(
  id: string,
  name: string,
  command: { path: string; description: string }
): Promise<void> {
  const commands = await getCodebaseCommands(id);
  commands[name] = command;
  await updateCodebaseCommands(id, commands);
}

export async function findCodebaseByRepoUrl(repoUrl: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE repository_url = $1',
    [repoUrl]
  );
  return result.rows[0] || null;
}

export async function findCodebaseByDefaultCwd(defaultCwd: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE default_cwd = $1 ORDER BY created_at DESC LIMIT 1',
    [defaultCwd]
  );
  return result.rows[0] || null;
}

/**
 * Find a codebase whose `default_cwd` is an ancestor of the given path.
 * Used for worktree-based runs where the actual `cwd` is a worktree subdirectory
 * of the registered source path — an exact match via `findCodebaseByDefaultCwd`
 * would always return null in that case.
 *
 * Returns the codebase with the longest matching prefix (most specific match).
 */
export async function findCodebaseByPathPrefix(cwdPath: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    `SELECT * FROM remote_agent_codebases
     WHERE $1 LIKE default_cwd || '%'
     ORDER BY length(default_cwd) DESC
     LIMIT 1`,
    [cwdPath]
  );
  return result.rows[0] || null;
}

export async function findCodebaseByName(name: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
    [name]
  );
  return result.rows[0] || null;
}

export async function updateCodebase(
  id: string,
  data: { default_cwd?: string; repository_url?: string | null }
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

  if (updates.length === 0) return;

  updates.push(`updated_at = ${dialect.now()}`);
  values.push(id);

  const result = await pool.query(
    `UPDATE remote_agent_codebases SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Codebase ${id} not found`);
  }
}

export async function listCodebases(): Promise<readonly Codebase[]> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases ORDER BY name ASC'
  );
  return result.rows;
}

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
