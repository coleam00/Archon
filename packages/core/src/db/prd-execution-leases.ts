import { pool, getDialect } from './connection';
import type { QueryResult, SqlDialect } from './adapters/types';
import { createLogger } from '@archon/paths';

export type PrdExecutionLeaseStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'released';

export interface PrdExecutionLeaseRow {
  id: string;
  codebase_id: string;
  prd_id: string;
  workflow_run_id: string;
  workflow_name: string;
  canonical_repo_path: string;
  source_branch: string;
  execution_branch: string;
  working_path: string | null;
  status: PrdExecutionLeaseStatus;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  released_at: Date | string | null;
}

export interface PrdExecutionLeaseDbDeps {
  query: <T>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
  getDialect: () => SqlDialect;
  log?: ReturnType<typeof createLogger>;
}

export interface PrdExecutionLeaseDb {
  getActivePrdExecutionLease(
    codebaseId: string,
    prdId: string
  ): Promise<PrdExecutionLeaseRow | null>;
  getPrdExecutionLeaseByRunId(workflowRunId: string): Promise<PrdExecutionLeaseRow | null>;
  acquirePrdExecutionLease(data: {
    codebase_id: string;
    prd_id: string;
    workflow_run_id: string;
    workflow_name: string;
    canonical_repo_path: string;
    source_branch: string;
    execution_branch: string;
    working_path?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PrdExecutionLeaseRow>;
  updatePrdExecutionLeaseStatus(
    workflowRunId: string,
    status: Extract<PrdExecutionLeaseStatus, 'active' | 'paused'>,
    metadata?: Record<string, unknown>
  ): Promise<void>;
  releasePrdExecutionLease(
    workflowRunId: string,
    status: Extract<PrdExecutionLeaseStatus, 'completed' | 'failed' | 'cancelled' | 'released'>,
    metadata?: Record<string, unknown>
  ): Promise<void>;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.prd-execution-leases');
  return cachedLog;
}

function normalizeLeaseRow<T extends PrdExecutionLeaseRow>(row: T): T {
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      row.metadata = {};
    }
  }
  return row;
}

export function createPrdExecutionLeaseDb(
  deps?: Partial<PrdExecutionLeaseDbDeps>
): PrdExecutionLeaseDb {
  const query: PrdExecutionLeaseDbDeps['query'] =
    deps?.query ??
    (<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => pool.query<T>(sql, params));
  const resolveDialect = deps?.getDialect ?? getDialect;
  const log = deps?.log ?? getLog();

  return {
    async getActivePrdExecutionLease(
      codebaseId: string,
      prdId: string
    ): Promise<PrdExecutionLeaseRow | null> {
      try {
        const result = await query<PrdExecutionLeaseRow>(
          `SELECT * FROM remote_agent_prd_execution_leases
           WHERE codebase_id = $1 AND prd_id = $2 AND released_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [codebaseId, prdId]
        );
        const row = result.rows[0];
        return row ? normalizeLeaseRow({ ...row }) : null;
      } catch (error) {
        const err = error as Error;
        log.error({ err, codebaseId, prdId }, 'db.prd_lease_get_active_failed');
        throw new Error(`Failed to get active PRD execution lease: ${err.message}`);
      }
    },

    async getPrdExecutionLeaseByRunId(workflowRunId: string): Promise<PrdExecutionLeaseRow | null> {
      try {
        const result = await query<PrdExecutionLeaseRow>(
          `SELECT * FROM remote_agent_prd_execution_leases
           WHERE workflow_run_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [workflowRunId]
        );
        const row = result.rows[0];
        return row ? normalizeLeaseRow({ ...row }) : null;
      } catch (error) {
        const err = error as Error;
        log.error({ err, workflowRunId }, 'db.prd_lease_get_by_run_failed');
        throw new Error(`Failed to get PRD execution lease by run: ${err.message}`);
      }
    },

    async acquirePrdExecutionLease(data: {
      codebase_id: string;
      prd_id: string;
      workflow_run_id: string;
      workflow_name: string;
      canonical_repo_path: string;
      source_branch: string;
      execution_branch: string;
      working_path?: string;
      metadata?: Record<string, unknown>;
    }): Promise<PrdExecutionLeaseRow> {
      const existing = await this.getActivePrdExecutionLease(data.codebase_id, data.prd_id);
      const dialect = resolveDialect();

      if (existing?.workflow_run_id && existing.workflow_run_id !== data.workflow_run_id) {
        throw new Error(
          `PRD '${data.prd_id}' already has an active lease held by run '${existing.workflow_run_id}' (${existing.workflow_name}, status=${existing.status}).`
        );
      }

      if (existing?.workflow_run_id === data.workflow_run_id) {
        const result = await query<PrdExecutionLeaseRow>(
          `UPDATE remote_agent_prd_execution_leases
           SET workflow_name = $1,
               canonical_repo_path = $2,
               source_branch = $3,
               execution_branch = $4,
               working_path = $5,
               status = 'active',
               updated_at = ${dialect.now()},
               metadata = ${dialect.jsonMerge('metadata', 6)}
           WHERE id = $7
           RETURNING *`,
          [
            data.workflow_name,
            data.canonical_repo_path,
            data.source_branch,
            data.execution_branch,
            data.working_path ?? null,
            JSON.stringify(data.metadata ?? {}),
            existing.id,
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error(`Failed to refresh PRD execution lease for '${data.prd_id}'`);
        }
        return normalizeLeaseRow({ ...row });
      }

      try {
        const result = await query<PrdExecutionLeaseRow>(
          `INSERT INTO remote_agent_prd_execution_leases
           (codebase_id, prd_id, workflow_run_id, workflow_name, canonical_repo_path, source_branch, execution_branch, working_path, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
           RETURNING *`,
          [
            data.codebase_id,
            data.prd_id,
            data.workflow_run_id,
            data.workflow_name,
            data.canonical_repo_path,
            data.source_branch,
            data.execution_branch,
            data.working_path ?? null,
            JSON.stringify(data.metadata ?? {}),
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error(`Failed to create PRD execution lease for '${data.prd_id}'`);
        }
        return normalizeLeaseRow({ ...row });
      } catch (error) {
        const err = error as Error;
        log.error(
          {
            err,
            codebaseId: data.codebase_id,
            prdId: data.prd_id,
            workflowRunId: data.workflow_run_id,
          },
          'db.prd_lease_acquire_failed'
        );
        throw new Error(`Failed to acquire PRD execution lease: ${err.message}`);
      }
    },

    async updatePrdExecutionLeaseStatus(
      workflowRunId: string,
      status: Extract<PrdExecutionLeaseStatus, 'active' | 'paused'>,
      metadata?: Record<string, unknown>
    ): Promise<void> {
      const dialect = resolveDialect();
      const result = await query(
        `UPDATE remote_agent_prd_execution_leases
         SET status = $1,
             updated_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE workflow_run_id = $3 AND released_at IS NULL`,
        [status, JSON.stringify(metadata ?? {}), workflowRunId]
      );

      if (result.rowCount === 0) {
        throw new Error(
          `Failed to update PRD execution lease status: no active lease found for run '${workflowRunId}'`
        );
      }
    },

    async releasePrdExecutionLease(
      workflowRunId: string,
      status: Extract<PrdExecutionLeaseStatus, 'completed' | 'failed' | 'cancelled' | 'released'>,
      metadata?: Record<string, unknown>
    ): Promise<void> {
      const dialect = resolveDialect();
      const result = await query(
        `UPDATE remote_agent_prd_execution_leases
         SET status = $1,
             updated_at = ${dialect.now()},
             released_at = ${dialect.now()},
             metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE workflow_run_id = $3 AND released_at IS NULL`,
        [status, JSON.stringify(metadata ?? {}), workflowRunId]
      );

      if (result.rowCount === 0) {
        throw new Error(
          `Failed to release PRD execution lease: no active lease found for run '${workflowRunId}'`
        );
      }
    },
  };
}

const defaultPrdExecutionLeaseDb = createPrdExecutionLeaseDb();

export const getActivePrdExecutionLease =
  defaultPrdExecutionLeaseDb.getActivePrdExecutionLease.bind(defaultPrdExecutionLeaseDb);
export const getPrdExecutionLeaseByRunId =
  defaultPrdExecutionLeaseDb.getPrdExecutionLeaseByRunId.bind(defaultPrdExecutionLeaseDb);
export const acquirePrdExecutionLease = defaultPrdExecutionLeaseDb.acquirePrdExecutionLease.bind(
  defaultPrdExecutionLeaseDb
);
export const updatePrdExecutionLeaseStatus =
  defaultPrdExecutionLeaseDb.updatePrdExecutionLeaseStatus.bind(defaultPrdExecutionLeaseDb);
export const releasePrdExecutionLease = defaultPrdExecutionLeaseDb.releasePrdExecutionLease.bind(
  defaultPrdExecutionLeaseDb
);
