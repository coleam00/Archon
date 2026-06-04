/**
 * PRD execution identity/provenance helpers shared by CLI and web workflow entrypoints.
 */
import { resolve as resolvePath } from 'node:path';
import { createLogger } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import type { WorkflowExecutionResult } from '@archon/workflows/schemas/workflow';
import {
  getPrdExecutionIdentity,
  getWorkflowProvenance,
  type PrdExecutionIdentity,
  type WorkflowProvenance,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import * as prdExecutionLeaseDb from '../db/prd-execution-leases';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.prd-execution');
  return cachedLog;
}

export interface PrdExecutionContext {
  identity: PrdExecutionIdentity;
  provenance: WorkflowProvenance;
}

async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

async function getGitHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

export async function buildPrdExecutionContext(params: {
  prdId: string;
  canonicalRepoPath: string;
  workingPath: string;
  sourceBranch?: string;
  executionBranch?: string;
}): Promise<PrdExecutionContext> {
  const canonicalRepoPath = resolvePath(params.canonicalRepoPath);
  const workingPath = resolvePath(params.workingPath);
  const currentBranch = await getGitBranch(workingPath);
  const headSha = await getGitHeadSha(workingPath);
  const resolvedSourceBranch = params.sourceBranch ?? (await getGitBranch(canonicalRepoPath));
  const resolvedExecutionBranch = params.executionBranch ?? currentBranch ?? resolvedSourceBranch;

  if (!resolvedSourceBranch) {
    throw new Error(
      `PRD execution '${params.prdId}' could not determine a source branch for ${canonicalRepoPath}.`
    );
  }
  if (!resolvedExecutionBranch) {
    throw new Error(
      `PRD execution '${params.prdId}' could not determine an execution branch for ${workingPath}.`
    );
  }
  if (currentBranch && currentBranch !== resolvedExecutionBranch) {
    throw new Error(
      `PRD execution '${params.prdId}' expected branch '${resolvedExecutionBranch}' but found '${currentBranch}' at ${workingPath}.`
    );
  }

  return {
    identity: {
      kind: 'prd',
      prdId: params.prdId,
      canonicalRepoPath,
      sourceBranch: resolvedSourceBranch,
      executionBranch: resolvedExecutionBranch,
    },
    provenance: {
      canonicalRepoPath,
      workingPath,
      currentBranch,
      headSha,
      requestedSourceBranch: params.sourceBranch,
      requestedExecutionBranch: params.executionBranch,
      capturedAt: new Date().toISOString(),
    },
  };
}

export function buildPrdRunMetadata(prdContext: PrdExecutionContext): Record<string, unknown> {
  return {
    execution_identity: prdContext.identity,
    provenance: prdContext.provenance,
  };
}

export function verifyPrdResumeProvenance(
  run: WorkflowRun,
  prdContext: PrdExecutionContext,
  requestedPrdId?: string
): void {
  const storedIdentity = getPrdExecutionIdentity(run.metadata);
  if (!storedIdentity) {
    throw new Error(
      `Workflow run '${run.id}' has no PRD execution identity recorded. Use a fresh verified launch instead of an implicit resume.`
    );
  }
  const storedProvenance = getWorkflowProvenance(run.metadata);

  if (requestedPrdId && storedIdentity.prdId !== requestedPrdId) {
    throw new Error(
      `Workflow run '${run.id}' belongs to PRD '${storedIdentity.prdId}', not requested PRD '${requestedPrdId}'.`
    );
  }
  if (resolvePath(storedIdentity.canonicalRepoPath) !== prdContext.identity.canonicalRepoPath) {
    throw new Error(
      `Workflow run '${run.id}' was created from canonical repo '${storedIdentity.canonicalRepoPath}', expected '${prdContext.identity.canonicalRepoPath}'.`
    );
  }
  if (storedIdentity.executionBranch !== prdContext.identity.executionBranch) {
    throw new Error(
      `Workflow run '${run.id}' targets execution branch '${storedIdentity.executionBranch}', but the current worktree is on '${prdContext.identity.executionBranch}'.`
    );
  }
  if (run.working_path && resolvePath(run.working_path) !== prdContext.provenance.workingPath) {
    throw new Error(
      `Workflow run '${run.id}' recorded working path '${run.working_path}', but resume is attempting '${prdContext.provenance.workingPath}'.`
    );
  }
  if (
    storedProvenance?.workingPath &&
    resolvePath(storedProvenance.workingPath) !== prdContext.provenance.workingPath
  ) {
    throw new Error(
      `Workflow run '${run.id}' recorded provenance working path '${storedProvenance.workingPath}', but resume is attempting '${prdContext.provenance.workingPath}'.`
    );
  }
}

export async function acquirePrdExecutionLeaseForRun(params: {
  codebaseId: string;
  workflowRunId: string;
  workflowName: string;
  context: PrdExecutionContext;
}): Promise<void> {
  await prdExecutionLeaseDb.acquirePrdExecutionLease({
    codebase_id: params.codebaseId,
    prd_id: params.context.identity.prdId,
    workflow_run_id: params.workflowRunId,
    workflow_name: params.workflowName,
    canonical_repo_path: params.context.identity.canonicalRepoPath,
    source_branch: params.context.identity.sourceBranch,
    execution_branch: params.context.identity.executionBranch,
    working_path: params.context.provenance.workingPath,
    metadata: { provenance: params.context.provenance },
  });
}

export async function releasePrdLeaseIfHeld(
  workflowRunId: string,
  status: 'completed' | 'failed' | 'cancelled' | 'released',
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const lease = await prdExecutionLeaseDb.getPrdExecutionLeaseByRunId(workflowRunId);
    if (!lease || lease.released_at) return;
    await prdExecutionLeaseDb.releasePrdExecutionLease(workflowRunId, status, metadata);
  } catch (error) {
    getLog().warn(
      { err: error as Error, workflowRunId, status },
      'workflow.prd_lease_release_failed'
    );
  }
}

export async function updatePrdLeaseForWorkflowResult(params: {
  workflowRunId: string;
  result?: WorkflowExecutionResult;
  error?: Error | null;
  context?: PrdExecutionContext | null;
}): Promise<void> {
  const { workflowRunId, result, error, context } = params;
  if (result?.success && 'paused' in result && result.paused) {
    try {
      await prdExecutionLeaseDb.updatePrdExecutionLeaseStatus(workflowRunId, 'paused', {
        provenance: context?.provenance,
        paused_at: new Date().toISOString(),
      });
    } catch (updateError) {
      getLog().warn(
        { err: updateError as Error, workflowRunId },
        'workflow.prd_lease_pause_update_failed'
      );
    }
  } else if (result?.success) {
    await releasePrdLeaseIfHeld(workflowRunId, 'completed', {
      provenance: context?.provenance,
      completed_at: new Date().toISOString(),
    });
  } else {
    await releasePrdLeaseIfHeld(workflowRunId, 'failed', {
      provenance: context?.provenance,
      error: result && !result.success ? result.error : error?.message,
      failed_at: new Date().toISOString(),
    });
  }
}
