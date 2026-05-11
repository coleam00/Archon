/**
 * Database operations for per-codebase environment variables.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.env-vars');
  return cachedLog;
}

export interface CodebaseEnvVar {
  id: string;
  codebase_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

/** Get all env vars for a codebase as a flat Record. */
export async function getCodebaseEnvVars(codebaseId: string): Promise<Record<string, string>> {
  const result = await pool.query<CodebaseEnvVar>(
    'SELECT key, value FROM remote_agent_codebase_env_vars WHERE codebase_id = $1 ORDER BY key ASC',
    [codebaseId]
  );
  return Object.fromEntries(result.rows.map(r => [r.key, r.value]));
}

/** Upsert a single env var (INSERT or UPDATE on conflict). */
export async function setCodebaseEnvVar(
  codebaseId: string,
  key: string,
  value: string
): Promise<void> {
  const dialect = getDialect();
  const id = dialect.generateUuid();
  await pool.query(
    `INSERT INTO remote_agent_codebase_env_vars (id, codebase_id, key, value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (codebase_id, key) DO UPDATE SET value = $4, updated_at = ${dialect.now()}`,
    [id, codebaseId, key, value]
  );
  getLog().debug({ codebaseId, key }, 'db.env_var_set_completed');
}

/** Delete a single env var. No-op if key doesn't exist. */
export async function deleteCodebaseEnvVar(codebaseId: string, key: string): Promise<void> {
  await pool.query(
    'DELETE FROM remote_agent_codebase_env_vars WHERE codebase_id = $1 AND key = $2',
    [codebaseId, key]
  );
  getLog().debug({ codebaseId, key }, 'db.env_var_delete_completed');
}
