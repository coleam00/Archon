import { addMessage } from '@archon/core/db/messages';
import { toPersistedMessageMetadata } from '@archon/core/types';
import { createWorkflowDeps } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import {
  resumeWorkflowContinuation,
  wakeDueWorkflowContinuations,
  type ContinuationAdmission,
} from '@archon/core/workflows/continuation-host';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { createLogger } from '@archon/paths';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import { spellWorkflowCommand, type IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowResumeCursor } from '@archon/workflows/store';

const log = createLogger('workflow-resume-service');
const CONTINUATION_SCAN_INTERVAL_MS = 5_000;
let continuationScheduler: ReturnType<typeof setInterval> | undefined;
let scanInProgress = false;

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

export function workflowResumeConversationId(run: WorkflowRun): string | null {
  return run.conversation_id ?? run.parent_conversation_id;
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

export async function workflowResumeTargetForRun(
  run: WorkflowRun,
  platforms: ReadonlyMap<string, IWorkflowPlatform>
): Promise<WorkflowResumeTarget> {
  const conversationId = workflowResumeConversationId(run);
  if (conversationId === null) return { kind: 'headless' };
  const conversation = await conversationDb.getConversationById(conversationId);
  if (!conversation) {
    return { kind: 'unavailable', reason: 'origin conversation no longer exists' };
  }
  if (run.parent_conversation_id === null || run.conversation_id === null) {
    return workflowResumeTargetForConversation(conversation, platforms);
  }

  const parent = await conversationDb.getConversationById(run.parent_conversation_id);
  if (!parent?.platform_conversation_id) {
    return { kind: 'unavailable', reason: 'parent conversation no longer exists' };
  }
  if (!conversation.platform_conversation_id) {
    return { kind: 'unavailable', reason: 'worker conversation has no platform id' };
  }
  return workflowResumeTargetForConversation(
    parent,
    platforms,
    conversation.platform_conversation_id,
    parent.platform_conversation_id
  );
}

export async function resumeWorkflowRunFromServer(
  run: WorkflowRun,
  actorUserId?: string,
  target: WorkflowResumeTarget = { kind: 'headless' },
  cursor?: WorkflowResumeCursor
): Promise<boolean> {
  try {
    const admission = await admitFromServer(run, async () => target, cursor, actorUserId);
    return admission.kind === 'accepted';
  } catch (error) {
    log.warn({ err: error, runId: run.id }, 'workflow_resume_headless_unexpected_error');
    return false;
  }
}

async function admitFromServer(
  run: WorkflowRun,
  resolveTarget: WorkflowResumeDestinationResolver,
  cursor?: WorkflowResumeCursor,
  actorUserId?: string
): Promise<ContinuationAdmission> {
  let destination: WorkflowResumeDestination | undefined;
  const admission = await resumeWorkflowContinuation(
    new InProcessWorkflowEngine(createWorkflowDeps()),
    run.id,
    async freshRun => {
      const historyConversationId = workflowResumeConversationId(freshRun);
      const target = await resolveTarget(freshRun);
      if (target.kind === 'unavailable') return target;
      if (
        target.kind === 'headless' &&
        historyConversationId &&
        !(await conversationDb.getConversationById(historyConversationId))
      ) {
        return { kind: 'unavailable', reason: 'origin conversation no longer exists' };
      }
      destination = target.kind === 'platform' ? target.destination : undefined;
      return {
        kind: 'ready',
        platform:
          destination?.platform ??
          new HeadlessPlatform(
            historyConversationId
              ? async (message, metadata): Promise<void> => {
                  await addMessage(
                    historyConversationId,
                    'assistant',
                    message,
                    toPersistedMessageMetadata(metadata)
                  );
                }
              : undefined
          ),
        conversationId: destination?.conversationId ?? freshRun.conversation_id ?? freshRun.id,
      };
    },
    cursor,
    actorUserId
  );
  if (admission.kind === 'unavailable') {
    log.warn(
      { runId: run.id, reason: admission.reason },
      'workflow_resume_destination_unavailable'
    );
  }
  if (admission.kind === 'accepted') {
    const resumableRun = admission.run;
    const platform = destination?.platform;
    void admission.settled
      .then(
        result => {
          if (!platform || destination?.resultConversationId === undefined || 'paused' in result)
            return;
          let message: string;
          let resultRunId: string;
          if (result.success) {
            if (result.summary === undefined) return;
            message = result.summary;
            resultRunId = result.workflowRunId;
          } else {
            if (result.workflowRunId === undefined) return;
            message = `Workflow **${resumableRun.workflow_name}** failed: ${result.error}`;
            resultRunId = result.workflowRunId;
          }
          void platform
            .sendMessage(destination.resultConversationId, message, {
              category: 'workflow_result',
              segment: 'new',
              workflowResult: { workflowName: resumableRun.workflow_name, runId: resultRunId },
            })
            .catch((error: unknown) => {
              log.warn(
                { err: error as Error, runId: resumableRun.id },
                'workflow_resume_result_surface_failed'
              );
            });
        },
        (error: unknown) => {
          // A run whose terminal status could not be written is NOT an ordinary failure:
          // its row still reads `running`, and `listDueWorkflowContinuations` only selects
          // paused/failed rows, so nothing will revisit it. Marking it failed here would
          // use the write channel that just failed — either it fails again, or it succeeds
          // and buries the real error under a generic "headless resume failed". Escalate
          // under its own tag instead and leave the row for an operator to resolve.
          if (error instanceof TerminalStatusWriteError) {
            log.error(
              {
                err: error,
                runId: resumableRun.id,
                workflowName: resumableRun.workflow_name,
              },
              'workflow_resume_headless_terminal_write_failed'
            );
            if (platform && destination?.resultConversationId !== undefined) {
              void platform
                .sendMessage(
                  destination.resultConversationId,
                  `⚠️ Run \`${resumableRun.id.slice(0, 8)}\` of **${resumableRun.workflow_name}** finished, but its ` +
                    'final status could not be saved. The run may still show as running — check it ' +
                    `with \`${spellWorkflowCommand(platform, `status ${resumableRun.id}`)}\` before starting another.`
                )
                .catch((sendError: unknown) => {
                  log.warn(
                    { err: sendError as Error, runId: resumableRun.id },
                    'workflow_resume_result_surface_failed'
                  );
                });
            }
            return;
          }
          log.error(
            { err: error as Error, runId: resumableRun.id },
            'workflow_resume_headless_execute_failed'
          );
        }
      )
      .catch((error: unknown) => {
        log.error(
          { err: error as Error, runId: resumableRun.id },
          'workflow_resume_headless_completion_failed'
        );
      });
  }
  return admission;
}

/** The server owns cadence and overlap; independent hosts compete through the engine CAS. */
export function startWorkflowContinuationScheduler(
  resolveDestination: WorkflowResumeDestinationResolver = async () => ({ kind: 'headless' }),
  onTick?: () => void
): void {
  if (continuationScheduler !== undefined) return;
  const tick = (): void => {
    if (!scanInProgress) {
      scanInProgress = true;
      void wakeDueWorkflowContinuations(new Date(), (run, cursor) =>
        admitFromServer(run, resolveDestination, cursor)
      )
        .catch((error: unknown) => {
          log.error({ err: error }, 'workflow_continuation_scan_failed');
        })
        .finally(() => {
          scanInProgress = false;
        });
    }
    onTick?.();
  };
  tick();
  continuationScheduler = setInterval(tick, CONTINUATION_SCAN_INTERVAL_MS);
  continuationScheduler.unref?.();
}

export function stopWorkflowContinuationScheduler(): void {
  if (continuationScheduler === undefined) return;
  clearInterval(continuationScheduler);
  continuationScheduler = undefined;
}
