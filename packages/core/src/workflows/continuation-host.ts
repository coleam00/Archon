import { WorkflowSourceUnavailableError } from '@archon/workflows/executor';
import type { WorkflowHost } from './host-store';
import { WorkflowNotResumableError, type IWorkflowStore } from '@archon/workflows/store';
import { startRunLiveOwner, RunLiveOwnerAlreadyOwnedError } from '../services/run-live-owner';
import { createCodebaseChildResolver } from './child-isolation-resolver';
import { resolveRunWorkflow } from './resolve-run-workflow';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import type { WorkflowResumeAdmission } from '@archon/workflows/engine-port';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  answeredPauseContinuation,
  isScheduledWorkflowResume,
  pendingWorkflowWaitDeadline,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';

const log = createLogger('workflow-continuation-host');
type Accepted = Extract<WorkflowResumeAdmission, { accepted: true }>;
export type ContinuationAdmission =
  | { kind: 'accepted'; run: WorkflowRun; settled: Accepted['settled'] }
  | { kind: 'not-accepted' }
  | { kind: 'unavailable'; reason: string; sourceError?: WorkflowSourceUnavailableError };
export type ContinuationContext =
  | { kind: 'ready'; platform: IWorkflowPlatform; conversationId: string }
  | { kind: 'unavailable'; reason: string };

export async function resumeWorkflowContinuation(
  host: Pick<WorkflowHost, 'deps' | 'records' | 'engine'>,
  runId: string,
  resolveContext: (run: WorkflowRun) => Promise<ContinuationContext>,
  cursor?: WorkflowResumeCursor,
  actorUserId?: string
): Promise<ContinuationAdmission> {
  const run = await host.deps.store.getWorkflowRun(runId);
  if (!run) return { kind: 'unavailable', reason: 'run no longer exists' };
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) return { kind: 'not-accepted' };
  if (!run.working_path) return { kind: 'unavailable', reason: 'run has no recorded working path' };
  if (run.metadata.isolation === 'container') {
    return { kind: 'unavailable', reason: 'container isolation requires manual workflow resume' };
  }
  const context = await resolveContext(run);
  if (context.kind === 'unavailable') return context;
  const codebase = run.codebase_id
    ? await host.records.codebases.getCodebase(run.codebase_id)
    : null;
  const source = await resolveRunWorkflow(
    host.deps,
    run,
    codebase?.default_cwd ?? getArchonWorkspacesPath(),
    context.platform
  );
  if (!source.ok)
    return { kind: 'unavailable', reason: source.message, sourceError: source.sourceError };
  try {
    const owner = await startRunLiveOwner(run.id);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= owner.close().catch((error: unknown) => {
        log.error({ err: error, runId: run.id }, 'workflow_continuation_owner_close_failed');
      });
      return closing;
    };
    let accepted = false;
    try {
      const userId = actorUserId ?? run.user_id ?? undefined;
      const admission = await host.engine.resume({
        platform: context.platform,
        conversationId: context.conversationId,
        cwd: run.working_path,
        legacyWorkflow: source.workflow,
        userMessage: run.user_message ?? '',
        origin: run.origin ?? undefined,
        run,
        cursor,
        options: {
          codebaseId: run.codebase_id ?? undefined,
          baseBranch: codebase?.default_branch?.trim() || undefined,
          resolveChildIsolation: codebase
            ? createCodebaseChildResolver(
                host.records.isolation,
                codebase,
                {
                  baseBranch: codebase.default_branch?.trim() || undefined,
                  createdByPlatform: context.platform.getPlatformType(),
                  createdByUserId: userId,
                },
                host.deps
              )
            : undefined,
        },
      });
      if (!admission.accepted) return { kind: 'not-accepted' };
      accepted = true;
      const settled = admission.settled.finally(close);
      // Hosts may attach their settlement handler after other admissions finish.
      void settled.catch(() => undefined);
      return { kind: 'accepted', run, settled };
    } finally {
      if (!accepted) await close();
    }
  } catch (error) {
    if (
      error instanceof WorkflowNotResumableError ||
      error instanceof RunLiveOwnerAlreadyOwnedError
    )
      return { kind: 'not-accepted' };
    throw error;
  }
}

function continuationCursor(run: WorkflowRun): WorkflowResumeCursor | undefined {
  const wait = pendingWorkflowWaitDeadline(run);
  if (wait) return { kind: 'wait', nodeId: wait.nodeId, resumeAt: wait.resumeAt };
  const answered = answeredPauseContinuation(run);
  if (answered) return { kind: 'answered', ...answered };
  if (run.status === 'failed' && isScheduledWorkflowResume(run.metadata.scheduled_resume)) {
    return {
      kind: 'quota',
      attempt: run.metadata.scheduled_resume.attempt,
      resumeAt: run.metadata.scheduled_resume.resumeAt,
    };
  }
  return undefined;
}

export type ContinuationWakeOutcome = { runId: string; deferError?: unknown } & (
  | ContinuationAdmission
  | { kind: 'failed'; error: unknown }
);

type ContinuationStore = Pick<
  IWorkflowStore,
  'listDueWorkflowContinuations' | 'deferWorkflowContinuation'
>;
const structuralFailures = new Map<string, number>();
const MAX_SOURCE_FAILURES = 3;

export async function wakeDueWorkflowContinuations(
  store: ContinuationStore,
  now: Date,
  resume: (run: WorkflowRun, cursor: WorkflowResumeCursor) => Promise<ContinuationAdmission>
): Promise<ContinuationWakeOutcome[]> {
  const blockedCount = [...structuralFailures.values()].filter(
    count => count >= MAX_SOURCE_FAILURES
  ).length;
  // Blocked rows remain due for other hosts; fetch past them so they cannot starve this host.
  const due = (await store.listDueWorkflowContinuations(now, 25 + blockedCount))
    .filter(run => (structuralFailures.get(run.id) ?? 0) < MAX_SOURCE_FAILURES)
    .slice(0, 25);
  return Promise.all(
    due.map(async (run): Promise<ContinuationWakeOutcome> => {
      const cursor = continuationCursor(run);
      if (!cursor) {
        log.warn({ runId: run.id }, 'workflow_continuation_due_cursor_missing');
        return {
          runId: run.id,
          kind: 'unavailable',
          reason: 'due continuation has no wake cursor',
        };
      }
      let outcome: ContinuationWakeOutcome;
      try {
        outcome = { runId: run.id, ...(await resume(run, cursor)) };
      } catch (error) {
        if (!(error instanceof WorkflowSourceUnavailableError))
          log.warn({ err: error, runId: run.id }, 'workflow_continuation_resume_failed');
        outcome = { runId: run.id, kind: 'failed', error };
      }
      const sourceError =
        outcome.kind === 'unavailable'
          ? outcome.sourceError
          : outcome.kind === 'failed' && outcome.error instanceof WorkflowSourceUnavailableError
            ? outcome.error
            : undefined;
      if (sourceError) {
        const count = (structuralFailures.get(run.id) ?? 0) + 1;
        structuralFailures.set(run.id, count);
        if (count >= MAX_SOURCE_FAILURES) {
          log.warn(
            { runId: run.id, path: sourceError.path, attempts: count },
            `This host stopped automatically resuming run ${run.id}: frozen workflow source at ${sourceError.path} is unreadable. Resume on the owning host with archon workflow resume ${run.id}, or abandon with archon workflow abandon ${run.id}.`
          );
          return outcome;
        }
      } else if (outcome.kind === 'accepted') {
        structuralFailures.delete(run.id);
      }
      if (outcome.kind !== 'accepted') {
        try {
          await store.deferWorkflowContinuation(
            run.id,
            new Date(now.getTime() + 60_000).toISOString(),
            cursor
          );
        } catch (error) {
          log.error({ err: error, runId: run.id }, 'workflow_continuation_defer_failed');
          outcome.deferError = error;
        }
      }
      return outcome;
    })
  );
}
