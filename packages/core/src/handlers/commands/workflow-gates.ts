import {
  workflowOperationErrorMessage,
  type RejectionOperationResult,
} from '../../operations/workflow-operations';
import type { CommandResult } from '../../types';
import { getLog } from './log';
import { spell, type WorkflowCommand } from './workflow-command';
import { createResumeRequest, resolveChatRunId } from './workflow-runs';

/**
 * Attach a resume request to an already-recorded gate decision.
 *
 * The decision is committed by the time this runs, so a continuation that cannot
 * be resolved is reported as a follow-up step, never as a failed command — saying
 * "failed" about a gate that IS resolved would send the user to re-approve a run
 * that refuses a second decision.
 */
async function withRunContinuation(
  input: WorkflowCommand,
  runId: string,
  headline: string,
  action: 'approve' | 'reject' | 'respond'
): Promise<CommandResult> {
  let continuation: Awaited<ReturnType<typeof createResumeRequest>>;
  try {
    continuation = await createResumeRequest(input.operations, runId, input.actor);
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, errorType: err.constructor.name, runId, action },
      'cmd.workflow_gate_continuation_unresolved'
    );
    continuation = { ok: false, message: err.message };
  }
  if (!continuation.ok) {
    const hint =
      continuation.resumeHint ??
      `Resume it with \`${spell(input, `resume ${runId}`)}\` once that is fixed.`;
    return {
      success: true,
      message: `${headline}\nThe run could not be continued automatically: ${continuation.message}\n${hint}`,
    };
  }
  return {
    success: true,
    message: `${headline}\nContinuation requested.`,
    workflow: continuation.workflow,
  };
}

/** A recorded rejection: the run was cancelled, or it continues with the rejection. */
async function rejectionResult(
  input: WorkflowCommand,
  runId: string,
  result: RejectionOperationResult,
  action: 'reject' | 'respond'
): Promise<CommandResult> {
  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    const warnings = (result.cleanupWarnings ?? []).map(warning => `\n⚠️ ${warning}`).join('');
    return {
      success: true,
      message: `Workflow \`${result.workflowName}\` rejected and cancelled${suffix}.${warnings}`,
    };
  }
  // Not cancelled means either a legacy on_reject rework is staged, or
  // (#2707 step 1) a new-mode gate resolved with structured output —
  // continue the run either way so the resolution actually takes effect
  // (#2565).
  return withRunContinuation(
    input,
    runId,
    result.newMode
      ? `Workflow \`${result.workflowName}\` rejected.`
      : `Workflow \`${result.workflowName}\` rejected. Feedback recorded.`,
    action
  );
}

export async function approveWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args, surface, actor } = input;
  const cmd = (command: string): string => spell(input, command);
  /** A child-run redirect is spelled for THIS surface; anything else reports as-is. */
  const failureText = (err: Error): string => workflowOperationErrorMessage(err, surface);
  let runId = args[1];
  if (!runId) {
    return {
      success: false,
      message: `Usage: ${cmd('approve <id> [comment]')}\n\nApproves a paused workflow run.`,
    };
  }
  // approveWorkflow owns the empty-comment default and the "no feedback"
  // reading an interactive-loop gate finalizes on (#2074).
  const comment = args.slice(2).join(' ');
  try {
    runId = await resolveChatRunId(runId, conversation);
    const result = await operations.approveWorkflow(runId, comment, actor, {
      via: conversation.platform_type,
    });
    const pathInfo = result.workingPath ? `\nPath: \`${result.workingPath}\`` : '';
    const headline =
      result.type === 'interactive_loop'
        ? `Workflow \`${result.workflowName}\` loop input received.${pathInfo}`
        : `Workflow \`${result.workflowName}\` approved.${pathInfo}`;
    // Resolving is only half the action — continue the run too (#2565).
    // Before #2565 this told the user to "type your response to resume",
    // which relied on a natural-language branch that no longer exists.
    return await withRunContinuation(input, runId, headline, 'approve');
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cmd.workflow_approve_failed');
    return { success: false, message: `Failed to approve workflow run: ${failureText(err)}` };
  }
}

export async function rejectWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args, surface, actor } = input;
  const cmd = (command: string): string => spell(input, command);
  /** A child-run redirect is spelled for THIS surface; anything else reports as-is. */
  const failureText = (err: Error): string => workflowOperationErrorMessage(err, surface);
  let runId = args[1];
  if (!runId) {
    return {
      success: false,
      message: `Usage: ${cmd('reject <id> [reason]')}\n\nRejects a paused workflow run.`,
    };
  }
  const reason = args.slice(2).join(' ');
  try {
    runId = await resolveChatRunId(runId, conversation);
    const result = await operations.rejectWorkflow(runId, reason, actor, {
      via: conversation.platform_type,
    });
    return await rejectionResult(input, runId, result, 'reject');
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cmd.workflow_reject_failed');
    return { success: false, message: `Failed to reject workflow run: ${failureText(err)}` };
  }
}

export async function respondToWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args, surface, actor } = input;
  const cmd = (command: string): string => spell(input, command);
  /** A child-run redirect is spelled for THIS surface; anything else reports as-is. */
  const failureText = (err: Error): string => workflowOperationErrorMessage(err, surface);
  // General drive verb (#2707 step 2): resolves a paused gate with any of its
  // author-declared decisions. 'approve'/'reject' behave identically to the
  // dedicated approve and reject commands — respondToWorkflow delegates those two ids to the
  // exact same approveWorkflow/rejectWorkflow functions — this handler just
  // formats whichever result shape comes back.
  let runId = args[1];
  const decision = args[2];
  if (!runId || !decision) {
    return {
      success: false,
      message:
        `Usage: ${cmd('respond <id> <decision> [text]')}\n\n` +
        "Resolves a paused gate with any of its declared decisions ('approve'/'reject' " +
        `are sugar for the dedicated ${cmd('approve|reject')} commands).`,
    };
  }
  const text = args.slice(3).join(' ');
  try {
    runId = await resolveChatRunId(runId, conversation);
    const result = await operations.respondToWorkflow(runId, decision, text, actor, {
      via: conversation.platform_type,
    });
    if ('cancelled' in result) return await rejectionResult(input, runId, result, 'respond');
    const pathInfo = result.workingPath ? `\nPath: \`${result.workingPath}\`` : '';
    const headline =
      result.type === 'interactive_loop'
        ? `Workflow \`${result.workflowName}\` loop input received.${pathInfo}`
        : `Workflow \`${result.workflowName}\` responded '${decision}'.${pathInfo}`;
    return await withRunContinuation(input, runId, headline, 'respond');
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId, decision }, 'cmd.workflow_respond_failed');
    return {
      success: false,
      message: `Failed to respond to workflow run: ${failureText(err)}`,
    };
  }
}
