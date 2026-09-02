import { createChildWorktreeResolver, createWorkflowDeps } from '@archon/core';
import { resolveRunContinuation } from '@archon/core/handlers';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import { executeWorkflow, hydrateResumableRun } from '@archon/workflows/executor';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';
import {
  isScheduledWorkflowResume,
  isWorkflowWaitContext,
} from '@archon/workflows/schemas/workflow-run';
import { HeadlessPlatform } from '../adapters/headless';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';

const log = createLogger('workflow-resume-service');
const CONTINUATION_SCAN_INTERVAL_MS = 5_000;
const CONTINUATION_SCAN_BATCH_SIZE = 25;
const CONTINUATION_RETRY_DELAY_MS = 60_000;
let continuationScheduler: ReturnType<typeof setInterval> | undefined;
let scanInProgress = false;

function continuationCursor(run: WorkflowRun): WorkflowResumeCursor | undefined {
  if (run.status === 'paused' && isWorkflowWaitContext(run.metadata.wait)) {
    if (run.metadata.wait.kind === 'attention') return undefined;
    return {
      kind: 'wait',
      nodeId: run.metadata.wait.nodeId,
      resumeAt: run.metadata.wait.resumeAt,
    };
  }
  if (run.status === 'failed' && isScheduledWorkflowResume(run.metadata.scheduled_resume)) {
    return {
      kind: 'quota',
      attempt: run.metadata.scheduled_resume.attempt,
      resumeAt: run.metadata.scheduled_resume.resumeAt,
    };
  }
  return undefined;
}

export interface WorkflowResumeDestination {
  platform: IWorkflowPlatform;
  conversationId: string;
  resultConversationId?: string;
}

export type WorkflowResumeTarget =
  | { kind: 'platform'; destination: WorkflowResumeDestination }
  | { kind: 'headless' }
  | { kind: 'unavailable'; reason: string };

export type WorkflowResumeDestinationResolver = (run: WorkflowRun) => Promise<WorkflowResumeTarget>;

export function workflowResumeConversationId(run: WorkflowRun): string {
  return run.conversation_id;
}

export function workflowResumeTargetForConversation(
  conversation: { platform_type: string; platform_conversation_id: string | null },
  platforms: ReadonlyMap<string, IWorkflowPlatform>,
  executionConversationId?: string,
  resultConversationId?: string
): WorkflowResumeTarget {
  if (conversation.platform_type === 'cli' || conversation.platform_type === 'api') {
    return { kind: 'headless' };
  }
  if (!conversation.platform_conversation_id) {
    return { kind: 'unavailable', reason: 'origin conversation has no platform id' };
  }
  const platform = platforms.get(conversation.platform_type);
  if (platform === undefined) {
    return {
      kind: 'unavailable',
      reason: `origin adapter '${conversation.platform_type}' is unavailable`,
    };
  }
  return {
    kind: 'platform',
    destination: {
      platform,
      conversationId: executionConversationId ?? conversation.platform_conversation_id,
      ...(resultConversationId !== undefined
        ? { resultConversationId }
        : conversation.platform_type === 'web'
          ? { resultConversationId: conversation.platform_conversation_id }
          : {}),
    },
  };
}

/** Resume one persisted run through the same frozen-source path used by the API. */
export async function resumeWorkflowRunFromServer(
  run: WorkflowRun,
  actorUserId?: string,
  target: WorkflowResumeTarget = { kind: 'headless' },
  cursor?: WorkflowResumeCursor
): Promise<boolean> {
  if (!run.working_path) {
    log.debug({ runId: run.id }, 'workflow_resume_headless_no_working_path');
    return false;
  }
  const workingPath = run.working_path;
  if (target.kind === 'unavailable') {
    log.warn({ runId: run.id, reason: target.reason }, 'workflow_resume_destination_unavailable');
    return false;
  }
  if (run.metadata.isolation === 'container') {
    log.warn({ runId: run.id }, 'workflow_resume_container_requires_cli');
    return false;
  }
  try {
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    const workflowCwd = codebase?.default_cwd ?? getArchonWorkspacesPath();
    const deps = createWorkflowDeps();
    const continuation = await resolveRunContinuation(run.id, workflowCwd);
    if (!continuation.ok) {
      log.info(
        { runId: run.id, reason: continuation.message },
        'workflow_resume_headless_unresolvable'
      );
      return false;
    }

    const destination = target.kind === 'platform' ? target.destination : undefined;
    const platform = destination?.platform ?? new HeadlessPlatform(run.conversation_id);
    const platformConversationId = destination?.conversationId ?? run.conversation_id;
    const runLiveOwner = await startRunLiveOwner(run.id);
    let runLiveOwnerClose: Promise<void> | undefined;
    const closeRunLiveOwner = (): Promise<void> => {
      runLiveOwnerClose ??= runLiveOwner.close().catch((error: unknown) => {
        log.error(
          { err: error as Error, runId: run.id },
          'workflow_resume_headless_owner_close_failed'
        );
      });
      return runLiveOwnerClose;
    };
    let executionStarted = false;
    try {
      let hydrated: Awaited<ReturnType<typeof hydrateResumableRun>>;
      try {
        hydrated = await hydrateResumableRun(deps, run, cursor);
      } catch (error) {
        if (error instanceof workflowDb.WorkflowNotResumableError) {
          log.info(
            { runId: run.id, status: error.currentStatus },
            'workflow_resume_headless_lost_race'
          );
          return false;
        }
        throw error;
      }
      if (!hydrated) {
        log.info({ runId: run.id }, 'workflow_resume_headless_nothing_to_resume');
        return false;
      }

      const effectiveUserId = actorUserId ?? run.user_id ?? undefined;
      const resolveChildIsolation =
        codebase && codebase.kind !== 'folder'
          ? createChildWorktreeResolver({
              codebaseId: codebase.id,
              codebaseName: codebase.name,
              canonicalRepoPath: codebase.default_cwd,
              baseBranch: codebase.default_branch?.trim() || undefined,
              createdByPlatform: platform.getPlatformType(),
              createdByUserId: effectiveUserId,
            })
          : undefined;

      const execution = executeWorkflow(
        deps,
        platform,
        platformConversationId,
        workingPath,
        continuation.workflow.definition,
        run.user_message ?? '',
        run.conversation_id,
        {
          codebaseId: run.codebase_id ?? undefined,
          userId: effectiveUserId,
          baseBranch: codebase?.default_branch?.trim() || undefined,
          resolveChildIsolation,
          ...hydrated,
        }
      );
      executionStarted = true;
      void execution
        .then(
          async result => {
            await closeRunLiveOwner();
            if (destination?.resultConversationId === undefined || 'paused' in result) return;
            let message: string;
            let resultRunId: string;
            if (result.success) {
              if (result.summary === undefined) return;
              message = result.summary;
              resultRunId = result.workflowRunId;
            } else {
              if (result.workflowRunId === undefined) return;
              message = `Workflow **${run.workflow_name}** failed: ${result.error}`;
              resultRunId = result.workflowRunId;
            }
            void platform
              .sendMessage(destination.resultConversationId, message, {
                category: 'workflow_result',
                segment: 'new',
                workflowResult: { workflowName: run.workflow_name, runId: resultRunId },
              })
              .catch((error: unknown) => {
                log.warn(
                  { err: error as Error, runId: run.id },
                  'workflow_resume_result_surface_failed'
                );
              });
          },
          async (error: unknown) => {
            // A run whose terminal status could not be written is NOT an ordinary failure:
            // its row still reads `running`, and `listDueWorkflowContinuations` only selects
            // paused/failed rows, so nothing will revisit it. Marking it failed here would
            // use the write channel that just failed — either it fails again, or it succeeds
            // and buries the real error under a generic "headless resume failed". Escalate
            // under its own tag instead and leave the row for an operator to resolve.
            if (error instanceof TerminalStatusWriteError) {
              log.error(
                { err: error, runId: run.id, workflowName: run.workflow_name },
                'workflow_resume_headless_terminal_write_failed'
              );
              await closeRunLiveOwner();
              if (destination?.resultConversationId !== undefined) {
                void platform
                  .sendMessage(
                    destination.resultConversationId,
                    `⚠️ Run \`${run.id.slice(0, 8)}\` of **${run.workflow_name}** finished, but its ` +
                      'final status could not be saved. The run may still show as running — check it ' +
                      `with \`/workflow status ${run.id}\` before starting another.`
                  )
                  .catch((sendError: unknown) => {
                    log.warn(
                      { err: sendError as Error, runId: run.id },
                      'workflow_resume_result_surface_failed'
                    );
                  });
              }
              return;
            }
            log.error(
              { err: error as Error, runId: run.id },
              'workflow_resume_headless_execute_failed'
            );
            await workflowDb
              .failWorkflowRun(run.id, `Headless resume failed: ${(error as Error).message}`)
              .catch((failError: unknown) => {
                log.error(
                  { err: failError as Error, runId: run.id },
                  'workflow_resume_headless_fail_mark_failed'
                );
              });
            await closeRunLiveOwner();
          }
        )
        .finally(closeRunLiveOwner)
        .catch((error: unknown) => {
          log.error(
            { err: error as Error, runId: run.id },
            'workflow_resume_headless_completion_failed'
          );
        });
      return true;
    } finally {
      if (!executionStarted) await closeRunLiveOwner();
    }
  } catch (error) {
    log.warn({ err: error as Error, runId: run.id }, 'workflow_resume_headless_unexpected_error');
    return false;
  }
}

export async function scanDueWorkflowContinuations(
  now = new Date(),
  resume: (run: WorkflowRun, cursor: WorkflowResumeCursor) => Promise<boolean> = (run, cursor) =>
    resumeWorkflowRunFromServer(run, undefined, { kind: 'headless' }, cursor)
): Promise<number> {
  if (scanInProgress) return 0;
  scanInProgress = true;
  try {
    const due = await workflowDb.listDueWorkflowContinuations(now, CONTINUATION_SCAN_BATCH_SIZE);
    const results = await Promise.all(
      due.map(async run => {
        const cursor = continuationCursor(run);
        if (cursor === undefined) {
          log.warn({ runId: run.id }, 'workflow_continuation_due_cursor_missing');
          return false;
        }
        let resumed = false;
        try {
          resumed = await resume(run, cursor);
        } catch (error) {
          log.warn(
            { err: error as Error, runId: run.id },
            'workflow_continuation_resume_unexpected_error'
          );
        }
        if (!resumed) {
          await workflowDb
            .deferWorkflowContinuation(
              run.id,
              new Date(now.getTime() + CONTINUATION_RETRY_DELAY_MS).toISOString(),
              cursor
            )
            .catch((deferError: unknown) => {
              log.error(
                { err: deferError as Error, runId: run.id },
                'workflow_continuation_defer_failed'
              );
            });
        }
        return resumed;
      })
    );
    return results.filter(Boolean).length;
  } finally {
    scanInProgress = false;
  }
}

export function startWorkflowContinuationScheduler(
  resolveDestination?: WorkflowResumeDestinationResolver
): void {
  if (continuationScheduler !== undefined) return;
  const resume = async (run: WorkflowRun, cursor: WorkflowResumeCursor): Promise<boolean> => {
    const target = resolveDestination
      ? await resolveDestination(run)
      : ({ kind: 'headless' } as const);
    return resumeWorkflowRunFromServer(run, undefined, target, cursor);
  };
  void scanDueWorkflowContinuations(new Date(), resume).catch((error: unknown) => {
    log.error({ err: error as Error }, 'workflow_continuation_scan_failed');
  });
  continuationScheduler = setInterval(() => {
    void scanDueWorkflowContinuations(new Date(), resume).catch((error: unknown) => {
      log.error({ err: error as Error }, 'workflow_continuation_scan_failed');
    });
  }, CONTINUATION_SCAN_INTERVAL_MS);
  continuationScheduler.unref?.();
}

export function stopWorkflowContinuationScheduler(): void {
  if (continuationScheduler === undefined) return;
  clearInterval(continuationScheduler);
  continuationScheduler = undefined;
}
