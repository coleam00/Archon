/**
 * Database operations for codebases
 */
import { resolve } from 'node:path';
import {
  ActiveContainerEnvironmentsError,
  ActiveWorktreeEnvironmentsError,
} from './codebase-delete-error';
import { ACTIVE_CONTAINER_ENVIRONMENT_PREDICATE } from './isolation-environment-predicates';
import { assertAbsoluteDefaultCwd } from './codebase-path';
export { InvalidCodebaseDefaultCwdError } from './codebase-path';
import { pool, getDatabase, getDatabaseType, getDialect } from './connection';
import {
  codebaseUpdateFields,
  type Codebase,
  type CreateCodebaseInput,
  type UpdateCodebaseInput,
} from '../schemas/codebase';
import { createLogger, captureCodebaseRegistered, isPathInside } from '@archon/paths';
import {
  allocateProjectName,
  assertProjectRegistrationAvailable,
} from '../services/project-registration-identity';
import { getProjectSourcePath, parseOwnerRepo } from '@archon/paths';
import { findRegisteredRemote } from '../services/registration-remote';
import { getProjectLocations } from '../services/project-locations';

function validateCodebase<T extends Pick<Codebase, 'name' | 'default_cwd'>>(row: T): T {
  assertAbsoluteDefaultCwd(row.default_cwd, row.name);
  return row;
}

export type CodebaseRegistration = Pick<Codebase, 'id' | 'name' | 'kind'> & {
  stored_default_cwd: Codebase['default_cwd'];
};

/** Administrative metadata stays readable so invalid registrations can be repaired or removed. */
export async function listCodebaseRegistrations(): Promise<readonly CodebaseRegistration[]> {
  const result = await pool.query<CodebaseRegistration>(
    'SELECT id, name, kind, default_cwd AS stored_default_cwd FROM remote_agent_codebases ORDER BY name ASC'
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
  return insertCodebase(data, false);
}

/** Forge registrations own managed source paths, so allocation must move that path with the name. */
export async function createManagedCodebase(data: CreateCodebaseInput): Promise<Codebase> {
  return insertCodebase(data, true);
}

async function insertCodebase(data: CreateCodebaseInput, managed: boolean): Promise<Codebase> {
  assertAbsoluteDefaultCwd(data.default_cwd, data.name);
  const result = await getDatabase().withTransaction(async query => {
    // Share the rename lock: a concurrent rename must not take the new registration's name.
    if (getDatabaseType() === 'postgresql') {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        CODEBASE_IDENTITY_LOCK,
      ]);
    }
    const registered = await query<Codebase>('SELECT * FROM remote_agent_codebases');
    let project = { ...data, kind: data.kind ?? 'repo' };
    if (managed) {
      const owner =
        project.repository_url &&
        (await findRegisteredRemote(registered.rows, project.repository_url, 'registration'));
      if (owner) {
        throw new Error(
          `Project "${owner.name}" is already registered at ${owner.default_cwd}. ` +
            'Two clones of one remote cannot be separate projects; use worktrees for parallel checkouts.'
        );
      }
      const segments = project.name.split('/');
      if (segments.length > 2 && segments.every(segment => parseOwnerRepo(`owner/${segment}`))) {
        project.name = `${segments[0]}/${segments.slice(1).join('-')}`;
      }
      const name = allocateProjectName(project, registered.rows);
      const identity = parseOwnerRepo(name);
      project = {
        ...project,
        name,
        default_cwd: identity
          ? getProjectSourcePath(identity.owner, identity.repo)
          : project.default_cwd,
      };
    }
    assertProjectRegistrationAvailable(project, registered.rows);
    return query<Codebase>(
      'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, default_branch, ai_assistant_type, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [
        project.name,
        project.repository_url ?? null,
        project.default_cwd,
        project.default_branch ?? null,
        project.ai_assistant_type ?? null,
        project.kind,
      ]
    );
  });
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

export async function findCodebaseByRepoUrl(repoUrl: string): Promise<Codebase | null> {
  return findRegisteredRemote(await listCodebases(), repoUrl);
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

  for (const field of codebaseUpdateFields) {
    const value = data[field];
    if (value === undefined) continue;
    updates.push(`${field} = $${paramIndex++}`);
    values.push(value);
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

export async function repairCodebaseRegistration(
  id: string,
  replacement: Pick<Codebase, 'default_cwd' | 'kind'>
): Promise<void> {
  const result = await pool.query<Codebase>('SELECT * FROM remote_agent_codebases WHERE id = $1', [
    id,
  ]);
  const current = result.rows[0];
  if (!current) throw new CodebaseNotFoundError(id);
  assertAbsoluteDefaultCwd(replacement.default_cwd, current.name);
  const currentPaths = await getProjectLocations(current);
  const replacementPaths = await getProjectLocations({ ...current, ...replacement });
  const moved = currentPaths.findIndex((path, i) => path !== replacementPaths[i]);
  if (moved !== -1 || currentPaths.length !== replacementPaths.length) {
    throw new Error(
      `Repairing "${current.name}" would move its Archon storage (worktrees, state, logs, artifacts). ` +
        'Nothing was changed; use a replacement path and kind that keep the same storage location.'
    );
  }
  const updated = await pool.query(
    `UPDATE remote_agent_codebases SET default_cwd = $1, kind = $2, updated_at = ${getDialect().now()} WHERE id = $3`,
    [replacement.default_cwd, replacement.kind, id]
  );
  if ((updated.rowCount ?? 0) === 0) throw new CodebaseNotFoundError(id);
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

// Retain the shipped rename lock key so registrations serialize with older binaries' renames too.
const CODEBASE_IDENTITY_LOCK = JSON.stringify(['codebase-rename']);

/**
 * Change a codebase's display name.
 *
 * Refuse changes to managed locations rather than splitting existing state
 * and future runs across different roots.
 *
 * Names are not UNIQUE in the schema, but `findCodebaseByName` resolves them
 * for `--project` and `/update-project`, so a duplicate is refused too. The
 * duplicate check lives in the UPDATE itself. On PostgreSQL that is not enough:
 * under READ COMMITTED two concurrent UPDATEs of different rows each evaluate
 * NOT EXISTS without seeing the other, so renames also take an advisory lock.
 * The waiting rename's UPDATE then reads a fresh snapshot that includes the
 * winner. SQLite serializes writers already.
 */
export async function renameCodebase(id: string, name: string): Promise<Codebase> {
  const current = await getCodebase(id);
  if (!current) throw new CodebaseNotFoundError(id);
  if (current.name === name) return current;

  const currentPaths = await getProjectLocations(current);
  const requestedPaths = await getProjectLocations({ ...current, name });
  const moved = currentPaths.findIndex((path, i) => path !== requestedPaths[i]);
  if (moved !== -1) {
    throw new CodebaseStorageIdentityChangeError(
      current.name,
      name,
      currentPaths[moved],
      requestedPaths[moved]
    );
  }

  const result = await getDatabase().withTransaction(async query => {
    if (getDatabaseType() === 'postgresql') {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        CODEBASE_IDENTITY_LOCK,
      ]);
    }
    return query(
      `UPDATE remote_agent_codebases SET name = $1, updated_at = ${getDialect().now()} WHERE id = $2 ` +
        'AND NOT EXISTS (SELECT 1 FROM remote_agent_codebases WHERE name = $1 AND id <> $2)',
      [name, id]
    );
  });
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

export async function deleteCodebase(
  id: string,
  options: { requireWorktreeCleanup?: boolean } = {}
): Promise<void> {
  getLog().debug({ codebaseId: id }, 'db.codebase_delete_cascade_started');
  await getDatabase().withTransaction(async query => {
    // PostgreSQL FK inserts take a key-share lock on the parent. FOR UPDATE
    // serializes registration with deletion; SQLite retries stale write snapshots.
    await query(
      'SELECT id FROM remote_agent_codebases WHERE id = $1' +
        (getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : ''),
      [id]
    );
    const containers = await query<{ id: string }>(
      `SELECT e.id FROM remote_agent_isolation_environments e
       WHERE e.codebase_id = $1 AND ${ACTIVE_CONTAINER_ENVIRONMENT_PREDICATE}
       ORDER BY e.id`,
      [id]
    );
    if (containers.rows.length > 0) {
      throw new ActiveContainerEnvironmentsError(containers.rows.map(env => env.id));
    }
    if (options.requireWorktreeCleanup) {
      const worktrees = await query<{ id: string }>(
        `SELECT id FROM remote_agent_isolation_environments
         WHERE codebase_id = $1 AND provider = 'worktree' AND status = 'active'
         ORDER BY id`,
        [id]
      );
      if (worktrees.rows.length > 0) {
        throw new ActiveWorktreeEnvironmentsError(worktrees.rows.map(env => env.id));
      }
    }
    await query('UPDATE remote_agent_sessions SET codebase_id = NULL WHERE codebase_id = $1', [id]);
    await query('UPDATE remote_agent_conversations SET codebase_id = NULL WHERE codebase_id = $1', [
      id,
    ]);
    await query('DELETE FROM remote_agent_codebases WHERE id = $1', [id]);
  });
  getLog().info({ codebaseId: id }, 'db.codebase_delete_completed');
}
