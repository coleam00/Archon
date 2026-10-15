/**
 * Database operations for isolation environments
 */
import { getRegisteredPlatformPolicies } from '../platforms/registry';
import { pool, getDialect, getDatabaseType } from './connection';
import {
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type {
  IsolationEnvironmentRow,
  IsolationWorkflowType,
  IIsolationStore,
  CreateEnvironmentParams,
} from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { toHydratedTimestamp } from './timestamps';
import { assertAbsoluteDefaultCwd } from './codebase-path';
import { WorktreeRegistrationChangedError } from './codebase-delete-error';
import { ACTIVE_CONTAINER_ENVIRONMENT_PREDICATE } from './isolation-environment-predicates';

// Adopted worktrees have no creation proof, so identical upserts need a fresh store-owned identity.
const WORKTREE_REGISTRATION_ID = 'worktree_registration_id';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.isolation-environments');
  return cachedLog;
}

/**
 * Normalize an isolation-environment row so it matches the
 * `IsolationEnvironmentRow` type's promise for every consumer, regardless of
 * dialect. SQLite stores `metadata` as TEXT (a JSON string, `JSON.stringify`'d
 * on write) while Postgres returns a parsed JSONB object — so the raw SQLite row
 * hands back a STRING, which makes the typed `Record<string, unknown>` a lie on
 * SQLite. That lie once leaked a container during Phase B smoke testing:
 * `destroy()` read `metadata.containerName` off the string as `undefined` and
 * silently skipped `docker rm`. Parsing here at the store boundary makes the type
 * TRUE, so no downstream reader has to re-guard the shape. A corrupt string is
 * logged and normalized to `{}` — the read stays resilient (one bad row must not
 * break `isolation list`/cleanup for all rows), while the destructive path
 * (container `destroy()`) still throws loudly when the resulting object lacks the
 * fields it needs. The same boundary hydrates `created_at`: SQLite stores it as
 * zone-less UTC TEXT that JavaScript parses as LOCAL time, so staleness math like
 * cleanup's `isEnvironmentStale` shifts every environment's computed age by the
 * host's UTC offset (older-looking east of UTC, younger west) without
 * re-anchoring. Mirrors `normalizeWorkflowRun` in workflows.ts.
 */
function normalizeEnvironmentRow<T extends IsolationEnvironmentRow>(row: T): T {
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch (err) {
      getLog().warn({ envId: row.id, err: err as Error }, 'db.isolation_env_metadata_parse_failed');
      row.metadata = {};
    }
  }
  if (typeof row.created_at === 'string') row.created_at = toHydratedTimestamp(row.created_at);
  return row;
}

type EnvironmentWithCodebasePath = IsolationEnvironmentRow & {
  codebase_default_cwd: string;
  codebase_name: string;
};

type EnvironmentWithCodebase = EnvironmentWithCodebasePath & {
  codebase_repository_url: string | null;
};

function normalizeEnvironmentWithCodebase<T extends EnvironmentWithCodebasePath>(row: T): T {
  assertAbsoluteDefaultCwd(row.codebase_default_cwd, row.codebase_name);
  return normalizeEnvironmentRow(row);
}

/**
 * Get an isolation environment by UUID
 */
export async function getById(id: string): Promise<IsolationEnvironmentRow | null> {
  const result = await pool.query<IsolationEnvironmentRow>(
    'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? normalizeEnvironmentRow(row) : null;
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
  const row = result.rows[0];
  return row ? normalizeEnvironmentRow(row) : null;
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
  return result.rows.map(normalizeEnvironmentRow);
}

/**
 * Find the newest environment record for an exact project checkout path.
 *
 * Unlike operational environment lists, adoption needs the destroyed row: its
 * branch name is the durable route back to an estate after cleanup removed the
 * worktree. Scope by codebase, path, and the cutoff timestamp so neither an
 * unrelated project nor a later checkout that reused the path can cross the
 * ownership boundary.
 */
export async function findLatestByCodebaseAndWorkingPath(
  codebaseId: string,
  workingPath: string,
  createdBefore: Date
): Promise<IsolationEnvironmentRow | null> {
  // SQLite stores datetime('now') as TEXT in this exact shape, so its cutoff
  // must use the same representation for lexicographic comparison. Postgres
  // compares native timestamps and accepts ISO 8601 directly.
  const cutoff =
    getDatabaseType() === 'sqlite'
      ? createdBefore.toISOString().replace('T', ' ').slice(0, 19)
      : createdBefore.toISOString();
  const result = await pool.query<IsolationEnvironmentRow>(
    `SELECT * FROM remote_agent_isolation_environments
     WHERE codebase_id = $1 AND working_path = $2 AND created_at <= $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [codebaseId, workingPath, cutoff]
  );
  const row = result.rows[0];
  return row ? normalizeEnvironmentRow(row) : null;
}

/**
 * Create or update an active isolation environment (upsert).
 * If an active environment with the same (codebase_id, workflow_type, workflow_id) exists,
 * it updates the existing row instead of inserting a duplicate.
 */
export async function create(env: CreateEnvironmentParams): Promise<IsolationEnvironmentRow> {
  const dialect = getDialect();
  const provider = env.provider ?? 'worktree';
  const metadata = { ...env.metadata };
  if (provider === 'worktree') metadata[WORKTREE_REGISTRATION_ID] = crypto.randomUUID();
  // Note: created_by_user_id is intentionally NOT in the DO UPDATE SET — on
  // re-creation (upsert) we preserve the original creator's attribution.
  // The first user to spin up an environment owns it; subsequent reactivations
  // by different users don't transfer ownership. Mirrors created_by_platform.
  const result = await pool.query<IsolationEnvironmentRow>(
    `INSERT INTO remote_agent_isolation_environments
     (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, created_by_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      provider,
      env.working_path,
      env.branch_name,
      env.created_by_platform ?? null,
      env.created_by_user_id ?? null,
      JSON.stringify(metadata),
    ]
  );

  if (!result.rows[0]) {
    throw new Error('Failed to create isolation environment: INSERT succeeded but no row returned');
  }

  getLog().debug(
    { envId: result.rows[0].id, codebaseId: env.codebase_id, branch: env.branch_name },
    'db.isolation_env_create_completed'
  );
  return normalizeEnvironmentRow(result.rows[0]);
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

/** Mark only the observed worktree resource destroyed, never a replacement registration. */
export async function markWorktreeDestroyed(
  env: Pick<IsolationEnvironmentRow, 'id' | 'working_path' | 'branch_name' | 'metadata'>
): Promise<void> {
  const registrationId = getDialect().jsonText('metadata', WORKTREE_REGISTRATION_ID);
  const result = await pool.query(
    `UPDATE remote_agent_isolation_environments SET status = 'destroyed'
     WHERE id = $1 AND provider = 'worktree' AND status = 'active'
       AND COALESCE(${registrationId}, '') = $2`,
    [env.id, env.metadata[WORKTREE_REGISTRATION_ID] ?? '']
  );
  if (result.rowCount !== 1) {
    throw new WorktreeRegistrationChangedError(env.id);
  }
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
 * A run releases its environment unconditionally only once it can never claim it
 * again: terminal AND not resumable. Derived rather than hand-listed so a new
 * resumable status keeps its pin automatically.
 */
const UNCLAIMABLE_WORKFLOW_STATUSES = TERMINAL_WORKFLOW_STATUSES.filter(
  status => !RESUMABLE_WORKFLOW_STATUSES.includes(status)
);

/**
 * Terminal but resumable ('failed'). Such a run pins its environment until a
 * cleanup sweep settles its outcome (see FailedRunRelease). A paused run is
 * resumable but not terminal, so it always pins.
 */
const SETTLEABLE_WORKFLOW_STATUSES = TERMINAL_WORKFLOW_STATUSES.filter(status =>
  RESUMABLE_WORKFLOW_STATUSES.includes(status)
);

/** Whether a claiming run's lock is one a cleanup sweep can release. */
export function isSettleableRunStatus(status: string): boolean {
  return (SETTLEABLE_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

/**
 * When a cleanup sweep stops counting a failed run as a lock: once its outcome is
 * settled (the branch merged or its PR closed), or once the run has been inactive
 * longer than the sweep's stale window. The run row itself is never touched.
 */
export type FailedRunRelease = { kind: 'settled' } | { kind: 'stale'; staleDays: number };

/**
 * Find a workflow run that still owns an environment — the one signal that pins an
 * env for cleanup. Historical conversation rows are data, not locks: every
 * CLI-launched run leaves one behind, so counting references pinned every
 * environment forever (#2868).
 *
 * "Owns" means the run can still act on the estate: it is running, pending or
 * paused, or it failed and remains resumable. With `release`, a failed run whose
 * outcome the caller has settled no longer owns it; every other claimable run
 * still does, whatever else shares the environment.
 *
 * Run metadata, conversation links, and same-codebase checkout paths all pin
 * estate. Creation proof governs deletion, while any claimable user blocks it.
 */
export async function getLiveRunOwningEnv(
  envId: string,
  release?: FailedRunRelease
): Promise<{ id: string; status: string } | null> {
  const postgres = getDatabaseType() === 'postgresql';
  const dialect = getDialect();
  const envIdExtract = dialect.jsonText('r.metadata', 'isolation_env_id');
  // UUID identifiers must compare as text so $1 has one type across metadata,
  // conversation links, and environment associations.
  const conversationEnvMatch = postgres ? 'c.isolation_env_id::text' : 'c.isolation_env_id';
  // Placeholders follow the status lists' lengths so a new status extends an IN
  // list without a hand-edited parameter position.
  const params: unknown[] = [envId];
  const placeholders = (values: readonly unknown[]): string =>
    values.map(value => `$${String(params.push(value))}`).join(', ');
  const unclaimable = placeholders(UNCLAIMABLE_WORKFLOW_STATUSES);
  let releaseFilter = '';
  if (release) {
    const settleable = placeholders(SETTLEABLE_WORKFLOW_STATUSES);
    if (release.kind === 'settled') {
      releaseFilter = `AND r.status NOT IN (${settleable})`;
    } else {
      // The run's own clock: a failed run's completed_at is when it failed. SQLite's
      // datetime() normalizes either stored text format; a NULL or unparseable time
      // keeps the lock.
      const coalesced = 'COALESCE(r.completed_at, r.last_activity_at, r.started_at)';
      const lastActive = postgres ? coalesced : `datetime(${coalesced})`;
      params.push(release.staleDays);
      const threshold = dialect.nowMinusDays(params.length);
      releaseFilter = `AND (r.status NOT IN (${settleable}) OR ${lastActive} IS NULL OR ${lastActive} >= ${threshold})`;
    }
  }
  const ownedEnvExtract = dialect.jsonText('r.metadata', 'owned_worktree.envId');
  const result = await pool.query<{ id: string; status: string }>(
    `SELECT r.id, r.status
     FROM remote_agent_workflow_runs r
     LEFT JOIN remote_agent_conversations c ON c.id = r.conversation_id
     WHERE (r.status NOT IN (${unclaimable}))
       ${releaseFilter}
       AND (${envIdExtract} = $1 OR ${ownedEnvExtract} = $1 OR ${conversationEnvMatch} = $1
         OR EXISTS (SELECT 1 FROM remote_agent_isolation_environments e
           WHERE ${postgres ? 'e.id::text' : 'e.id'} = $1 AND e.codebase_id = r.codebase_id AND e.working_path = r.working_path))
     ORDER BY r.started_at DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] ?? null;
}

/**
 * Find stale environments (no activity for specified days)
 */
export async function findStaleEnvironments(
  staleDays = 14
): Promise<readonly EnvironmentWithCodebasePath[]> {
  const dialect = getDialect();
  // Both conditions use the same staleDays value but need separate placeholders
  const staleActivityThreshold = dialect.nowMinusDays(1);
  const staleCreationThreshold = dialect.nowMinusDays(2);

  const ageBasedIds = getRegisteredPlatformPolicies()
    .filter(policy => policy.workspaceRetention === 'age-based')
    .map(policy => policy.id);
  const retentionFilter = ageBasedIds.length
    ? `AND e.created_by_platform IN (${ageBasedIds.map((_, index) => `$${index + 3}`).join(', ')})`
    : 'AND 1 = 0';

  const result = await pool.query<EnvironmentWithCodebasePath>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd, c.name as codebase_name
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
       AND e.created_by_platform IS NOT NULL
       ${retentionFilter}
       AND NOT EXISTS (
         SELECT 1 FROM remote_agent_conversations conv
         WHERE conv.isolation_env_id = e.id
           AND conv.last_activity_at > ${staleActivityThreshold}
       )
       AND e.created_at < ${staleCreationThreshold}`,
    [staleDays, staleDays, ...ageBasedIds]
  );
  return result.rows.map(normalizeEnvironmentWithCodebase);
}

/**
 * Find an active isolation environment by branch name.
 * Returns the environment row joined with its codebase's default_cwd,
 * or null if no active environment matches.
 */
export async function findActiveByBranchName(
  branchName: string
): Promise<EnvironmentWithCodebasePath | null> {
  const result = await pool.query<EnvironmentWithCodebasePath>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd, c.name as codebase_name
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.branch_name = $1 AND e.status = 'active'
     ORDER BY e.created_at DESC
     LIMIT 1`,
    [branchName]
  );
  const row = result.rows[0];
  return row ? normalizeEnvironmentWithCodebase(row) : null;
}

/**
 * List all active environments with their codebase info (for cleanup)
 */
export async function listAllActiveWithCodebase(): Promise<readonly EnvironmentWithCodebase[]> {
  const result = await pool.query<EnvironmentWithCodebase>(
    `SELECT e.*, c.default_cwd as codebase_default_cwd, c.name as codebase_name, c.repository_url as codebase_repository_url
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE e.status = 'active'
     ORDER BY e.created_at DESC`
  );
  return result.rows.map(normalizeEnvironmentWithCodebase);
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
  return result.rows.map(normalizeEnvironmentRow);
}

/**
 * List active CONTAINER isolation environments (folder-project container backend),
 * newest first, with the codebase name and age in days. Used by `isolation
 * list/cleanup` to surface + reap containers; the run status (which decides
 * whether a container is reapable) is looked up per-row via
 * {@link import('./workflows').getRunByIsolationEnvId}.
 */
export async function listActiveContainerEnvironments(): Promise<
  readonly (IsolationEnvironmentRow & {
    codebase_name: string;
    days_since_created: number;
  })[]
> {
  const dialect = getDialect();
  const result = await pool.query<
    IsolationEnvironmentRow & { codebase_name: string; days_since_created: number }
  >(
    `SELECT e.*, c.name as codebase_name, ${dialect.daysSince('e.created_at')} as days_since_created
     FROM remote_agent_isolation_environments e
     JOIN remote_agent_codebases c ON e.codebase_id = c.id
     WHERE ${ACTIVE_CONTAINER_ENVIRONMENT_PREDICATE}
     ORDER BY e.created_at DESC`
  );
  return result.rows.map(normalizeEnvironmentRow);
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
