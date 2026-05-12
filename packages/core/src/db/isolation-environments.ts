/**
 * Database operations for isolation environments
 */
import { pool, getDialect } from './connection';
import type {
  IsolationEnvironmentRow,
  IsolationWorkflowType,
  IIsolationStore,
  CreateEnvironmentParams,
} from '@archon/isolation';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.isolation-environments');
  return cachedLog;
}

/**
 * Get an isolation environment by UUID
 */
export async function getById(id: string): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Find an active isolation environment by workflow identity
 */
export async function findActiveByWorkflow(
  codebaseId: string,
  workflowType: IsolationWorkflowType,
  workflowId: string
): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND workflow_type = $2 AND workflow_id = $3 AND status = 'active'`,
    [codebaseId, workflowType, workflowId]
  );
  return result.rows[0] ?? null;
}

/**
 * Find all active environments for a codebase
 */
export async function listByCodebase(
  codebaseId: string
): Promise<readonly IsolationEnvironmentRow[]> {
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [codebaseId]
  );
  return result.rows;
}

/**
 * Create or update an active isolation environment (upsert).
 * If an active environment with the same (codebase_id, workflow_type, workflow_id) exists,
 * it updates the existing row instead of inserting a duplicate.
 */
export async function create(env: CreateEnvironmentParams): Promise<IsolationEnvironmentRow> {
  const dialect = getDialect();
  const result = await pool.query<IsolationEnvironmentRow>(
    `INSERT INTO remote_agent_isolation_environments
     (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (codebase_id, workflow_type, workflow_id) WHERE status = 'active'
     DO UPDATE SET
       working_path = EXCLUDED.working_path,
       branch_name = EXCLUDED.branch_name,
       provider = EXCLUDED.provider,
       created_by_platform = EXCLUDED.created_by_platform,
       metadata = EXCLUDED.metadata,
       status = 'active',
       created_at = ${dialect.now()}
     RETURNING *`,
    [
      env.codebase_id,
      env.workflow_type,
      env.workflow_id,
      env.provider ?? 'worktree',
      env.working_path,
      env.branch_name,
      env.created_by_platform ?? null,
      JSON.stringify(env.metadata ?? {}),
    ]
  );

  if (!result.rows[0]) {
    throw new Error('Failed to create isolation environment: INSERT succeeded but no row returned');
  }

  getLog().debug(
    { envId: result.rows[0].id, codebaseId: env.codebase_id, branch: env.branch_name },
    'db.isolation_env_create_completed'
  );
  return result.rows[0];
}

/**
 * Update environment status
 */
export async function updateStatus(id: string, status: 'active' | 'destroyed'): Promise<void> {
  const result = await pool.query(
    'UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2',
    [status, id]
  );

  if (result.rowCount === 0) {
    throw new Error(
      `Failed to update isolation environment status: no environment found with id '${id}'`
    );
  }
  getLog().debug({ envId: id, status }, 'db.isolation_env_status_update_completed');
}

/**
 * Update environment metadata (merge with existing)
 */
export async function updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
  const dialect = getDialect();
  const result = await pool.query(
    `UPDATE remote_agent_isolation_environments
     SET metadata = ${dialect.jsonMerge('metadata', 1)}
     WHERE id = $2`,
    [JSON.stringify(metadata), id]
  );

  if (result.rowCount === 0) {
    throw new Error(
      `Failed to update isolation environment metadata: no environment found with id '${id}'`
    );
  }
}

/**
 * Find environments by related issue (from metadata)
 */
export async function findByRelatedIssue(
  codebaseId: string,
  issueNumber: number
): Promise<IsolationEnvironmentRow | null> {
  const dialect = getDialect();
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1
       AND status = 'active'
       AND ${dialect.jsonArrayContains('metadata', 'related_issues', 2)}
     LIMIT 1`,
    [codebaseId, String(issueNumber)]
  );
  return result.rows[0] ?? null;
}

/**
 * Count active environments for a codebase (for limit checks)
 */
export async function countActiveByCodebase(codebaseId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND status = 'active'`,
    [codebaseId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Find conversations using an isolation environment
 */
export async function getConversationsUsingEnv(envId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM remote_agent_conversations WHERE isolation_env_id = $1',
    [envId]
  );
  return result.rows.map(r => r.id);
}

/**
 * Find stale environments (no activity for specified days)
 * Excludes Telegram (persistent workspaces never auto-cleanup)
 */
export async function findStaleEnvironments(
  staleDays = 14
): Promise<readonly (IsolationEnvironmentRow & { codebase_default_cwd: string })[]> {
  const dialect = getDialect();
  // Both conditions use the same staleDays value but need separate placeholders
  const staleActivityThreshold = dialect.nowMinusDays(1);
  const staleCreationThreshold = dialect.nowMinusDays(2);

  const result = await pool.query<IsolationEnvironmentRow & { codebase_default_cwd: string }>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
       AND e.created_by_platform != 'telegram'
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_conversations conv
         WHERE conv.isolation_env_id = e.id
           AND conv.last_activity_at > ${staleActivityThreshold}
       )
       AND e.created_at < ${staleCreationThreshold}`,
    [staleDays, staleDays]
  );
  return result.rows;
}

/**
 * Find an active isolation environment by branch name.
 * Returns the environment row joined with its codebase's default_cwd,
 * or null if no active environment matches.
 */
export async function findActiveByBranchName(
  branchName: string
): Promise<(IsolationEnvironmentRow & { codebase_default_cwd: string }) | null> {
  const result = await pool.query<IsolationEnvironmentRow & { codebase_default_cwd: string }>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.branch_name = $1 AND e.status = 'active'
     ORDER BY e.created_at DESC
     LIMIT 1`,
    [branchName]
  );
  return result.rows[0] ?? null;
}

/**
 * List all active environments with their codebase info (for cleanup)
 */
export async function listAllActiveWithCodebase(): Promise<
  readonly (IsolationEnvironmentRow & {
    codebase_default_cwd: string;
    codebase_repository_url: string | null;
  })[]
> {
  const result = await pool.query<
    IsolationEnvironmentRow & {
      codebase_default_cwd: string;
      codebase_repository_url: string | null;
    }
  >(
    `SELECT e.*, c.default_cwd as codebase_default_cwd, c.repository_url as codebase_repository_url
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
     ORDER BY e.created_at DESC`
  );
  return result.rows;
}

/**
 * List active environments for a codebase with days since last activity
 * Used for worktree breakdown and limit messaging
 */
export async function listByCodebaseWithAge(
  codebaseId: string
): Promise<readonly (IsolationEnvironmentRow & { days_since_activity: number })[]> {
  const dialect = getDialect();
  const daysSinceCreated = dialect.daysSince('e.created_at');
  const daysSinceActivity = dialect.daysSince('MAX(conv.last_activity_at)');

  const result = await pool.query<IsolationEnvironmentRow & { days_since_activity: number }>(
    `SELECT e.*,
            COALESCE(
              (SELECT ${daysSinceActivity}
               FROM remote_agent_conversations conv
               WHERE conv.isolation_env_id = e.id),
              ${daysSinceCreated}
            ) as days_since_activity
     FROM remote_agent_isolation_environments e
     WHERE e.codebase_id = $1 AND e.status = 'active'
     ORDER BY e.created_at DESC`,
    [codebaseId]
  );
  return result.rows;
}

/**
 * Create an IIsolationStore adapter from the DB query functions.
 * Used by IsolationResolver for dependency injection.
 */
export function createIsolationStore(): IIsolationStore {
  return {
    getById,
    findActiveByWorkflow,
    create: (env: CreateEnvironmentParams) => create(env),
    updateStatus,
    countActiveByCodebase,
  };
}
