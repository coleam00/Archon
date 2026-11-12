import type { WorkflowHost } from './host-store';
import { createCodebaseChildResolver } from './child-isolation-resolver';
import { getArchonWorkspacesPath } from '@archon/paths';
import type { WorkflowResumeOptions } from '@archon/workflows/engine-port';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  resumeRunContinuation,
  type ContinuationAdmission,
  type ContinuationContext,
  type ResolveProject,
} from './continuation-resume';

/** Resume a run with the host's records: its codebase and child-worktree isolation. */
export async function resumeWorkflowContinuation(
  host: Pick<WorkflowHost, 'deps' | 'records' | 'engine'>,
  runId: string,
  resolveContext: (run: WorkflowRun) => Promise<ContinuationContext>,
  cursor?: WorkflowResumeCursor,
  actorUserId?: string,
  executionOptions: Pick<WorkflowResumeOptions, 'deferScratchCleanup'> = {}
): Promise<ContinuationAdmission> {
  const resolveProject: ResolveProject = async (run, resumer) => {
    const codebase = run.codebase_id
      ? await host.records.codebases.getCodebase(run.codebase_id)
      : null;
    const baseBranch = codebase?.default_branch?.trim() || undefined;
    return {
      sourceCwd: codebase?.default_cwd ?? getArchonWorkspacesPath(),
      options: {
        codebaseId: run.codebase_id ?? undefined,
        baseBranch,
        resolveChildIsolation: codebase
          ? createCodebaseChildResolver(
              host.records.isolation,
              codebase,
              {
                baseBranch,
                createdByPlatform: resumer.platform.getPlatformType(),
                createdByUserId: resumer.userId,
              },
              host.deps
            )
          : undefined,
      },
    };
  };
  return resumeRunContinuation(host, runId, resolveContext, cursor, {
    ...executionOptions,
    actorUserId,
    resolveProject,
  });
}
