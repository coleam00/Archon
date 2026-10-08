/**
 * Database operations for codebases
 */
import { resolve } from 'node:path';
import { assertAbsoluteDefaultCwd } from './codebase-path';
export { InvalidCodebaseDefaultCwdError } from './codebase-path';
import { pool, getDialect } from './connection';
import type { Codebase, CreateCodebaseInput, UpdateCodebaseInput } from '../schemas/codebase';
import {
  createLogger,
  captureCodebaseRegistered,
  getProjectStoragePaths,
  isPathInside,
  resolveProjectStorageKey,
} from '@archon/paths';
import { getWorktreeBase, toRepoPath } from '@archon/git';

function validateCodebase<T extends Pick<Codebase, 'name' | 'default_cwd'>>(row: T): T {
  assertAbsoluteDefaultCwd(row.default_cwd, row.name);
  return row;
}

export type CodebaseRegistration = Pick<Codebase, 'id' | 'name'> & {
  stored_default_cwd: Codebase['default_cwd'];
};

/** Administrative metadata stays readable so invalid registrations can be repaired or removed. */
export async function listCodebaseRegistrations(): Promise<readonly CodebaseRegistration[]> {
  const result = await pool.query<CodebaseRegistration>(
    'SELECT id, name, default_cwd AS stored_default_cwd FROM remote_agent_codebases ORDER BY name ASC'
  );
  return result.rows;
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.codebases');
  return cachedLog;
}

export async function createCodebase(data: CreateCodebaseInput): Promise<Codebase> {
  assertAbsoluteDefaultCwd(data.default_cwd, data.name);
  const result = await pool.query<Codebase>(
    'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, default_branch, ai_assistant_type, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [
      data.name,
      data.repository_url ?? null,
      data.default_cwd,
      data.default_branch ?? null,
      data.ai_assistant_type ?? null,
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
  return validateCodebase(result.rows[0]);
}

export async function getCodebase(id: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>('SELECT * FROM remote_agent_codebases WHERE id = $1', [
    id,
  ]);
  const row = result.rows[0];
  return row ? validateCodebase(row) : null;
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
  const row = result.rows[0];
  return row ? validateCodebase(row) : null;
}

export async function findCodebaseByDefaultCwd(defaultCwd: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE default_cwd = $1 ORDER BY created_at DESC LIMIT 1',
    [defaultCwd]
  );
  const row = result.rows[0];
  return row ? validateCodebase(row) : null;
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
 */
export async function findCodebaseByPathPrefix(cwdPath: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>('SELECT * FROM remote_agent_codebases');
  let best: { row: Codebase; rootLength: number } | null = null;
  for (const row of result.rows.map(validateCodebase)) {
    if (!isPathInside(row.default_cwd, cwdPath, { includeRoot: true, lexical: true })) continue;
    // Rank on the normalized root: isPathInside matched it, and a stored spelling
    // with trailing separators would otherwise outrank a nested codebase.
    const rootLength = resolve(row.default_cwd).length;
    if (best === null || rootLength > best.rootLength) best = { row, rootLength };
  }
  return best?.row ?? null;
}

export async function findCodebaseByName(name: string): Promise<Codebase | null> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
    [name]
  );
  const row = result.rows[0];
  return row ? validateCodebase(row) : null;
}

/**
 * Error thrown when an UPDATE matched no codebase row (row deleted between
 * fetch and update). Lets callers distinguish "row gone" from operational
 * DB failures (connection refused, timeout, constraint violation).
 */
export class CodebaseNotFoundError extends Error {
  constructor(public codebaseId: string) {
    super(`Codebase ${codebaseId} not found`);
    this.name = 'CodebaseNotFoundError';
  }
}

export async function updateCodebase(
  target: Pick<Codebase, 'id' | 'name'>,
  data: UpdateCodebaseInput
): Promise<void> {
  if (data.default_cwd !== undefined) assertAbsoluteDefaultCwd(data.default_cwd, target.name);
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
  values.push(target.id);

  const result = await pool.query(
    `UPDATE remote_agent_codebases SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new CodebaseNotFoundError(target.id);
  }
}

export class CodebaseNameTakenError extends Error {
  constructor(public codebaseName: string) {
    super(`A project named "${codebaseName}" is already registered`);
    this.name = 'CodebaseNameTakenError';
  }
}

export class CodebaseStorageIdentityChangeError extends Error {
  constructor(
    public codebaseName: string,
    public requestedName: string,
    public currentPath: string,
    public requestedPath: string
  ) {
    super(
      `Renaming "${codebaseName}" to "${requestedName}" would move its Archon storage ` +
        `(worktrees, state, logs, artifacts) from ${currentPath} to ${requestedPath}. ` +
        'Choose a name that keeps the same storage location.'
    );
    this.name = 'CodebaseStorageIdentityChangeError';
  }
}

/**
 * Every Archon-managed location derived from a codebase's name. Storage and
 * worktrees are resolved by separate functions that do not always agree (the
 * worktree base also reads owner/repo from a path inside the workspaces tree),
 * so a rename must leave both unchanged.
 */
function nameDerivedLocations(codebase: Codebase): string[] {
  const storageRoot = getProjectStoragePaths(
    resolveProjectStorageKey(codebase, codebase.default_cwd)
  ).root;
  if (codebase.kind === 'folder') return [storageRoot];
  return [storageRoot, getWorktreeBase(toRepoPath(codebase.default_cwd), codebase.name).base];
}

/**
 * Change a codebase's display name.
 *
 * The name doubles as the project's storage identity (see
 * `resolveProjectStorageKey` and `getWorktreeBase`): worktrees, `$STATE_DIR`,
 * logs and artifacts of future runs live under roots derived from it. A rename
 * that would change any of them is refused rather than silently splitting the
 * project across two trees.
 *
 * Names are not UNIQUE in the schema, but `findCodebaseByName` resolves them
 * for `--project` and `/update-project`, so a duplicate is refused too. The
 * duplicate check lives in the UPDATE itself so concurrent renames cannot both
 * claim the same name.
 */
export async function renameCodebase(id: string, name: string): Promise<Codebase> {
  const current = await getCodebase(id);
  if (!current) throw new CodebaseNotFoundError(id);
  if (current.name === name) return current;

  const currentPaths = nameDerivedLocations(current);
  const requestedPaths = nameDerivedLocations({ ...current, name });
  const moved = currentPaths.findIndex((path, i) => path !== requestedPaths[i]);
  if (moved !== -1) {
    throw new CodebaseStorageIdentityChangeError(
      current.name,
      name,
      currentPaths[moved],
      requestedPaths[moved]
    );
  }

  const result = await pool.query(
    `UPDATE remote_agent_codebases SET name = $1, updated_at = ${getDialect().now()} WHERE id = $2 ` +
      'AND NOT EXISTS (SELECT 1 FROM remote_agent_codebases WHERE name = $1 AND id <> $2)',
    [name, id]
  );
  const renamed = await getCodebase(id);
  if (!renamed) throw new CodebaseNotFoundError(id);
  if ((result.rowCount ?? 0) === 0) throw new CodebaseNameTakenError(name);
  getLog().info({ codebaseId: id, from: current.name, to: name }, 'db.codebase_renamed');
  return renamed;
}

export async function listCodebases(): Promise<readonly Codebase[]> {
  const result = await pool.query<Codebase>(
    'SELECT * FROM remote_agent_codebases ORDER BY name ASC'
  );
  return result.rows.map(validateCodebase);
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
