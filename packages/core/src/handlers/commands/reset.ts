import { RunActionForbiddenError, type RunActor } from '../../operations/run-authorization';
import {
  describeReleasedWorktrees,
  type AbandonConversationRunsResult,
  type WorkflowOperations,
} from '../../operations/workflow-operations';
import type { CommandResult, Conversation } from '../../types';
import * as db from '../../db/conversations';
import * as sessionDb from '../../db/sessions';
import { safeDeactivateSession } from '../../state/session-transitions';
import { getLog } from './log';

/**
 * `/reset` is an explicit "start fresh" intent, and deactivating the AI
 * session alone does not deliver it: the execution binding (cwd +
 * isolation env) survives, and so does every resumable run, so the next
 * message can continue an old run on an old worktree instead of starting
 * over. This clears all three.
 *
 * `codebase_id` is deliberately PRESERVED. The resulting row —
 * {codebase_id: <kept>, cwd: null, isolation_env_id: null} — is byte-for-
 * byte what /setproject already writes, so this is a well-trodden state,
 * not a novel one. Detaching the project is /detach-project's job.
 */
export async function handleResetCommand(
  conversation: Conversation,
  actor: RunActor,
  operations: WorkflowOperations
): Promise<CommandResult> {
  let abandonedRuns: AbandonConversationRunsResult;
  try {
    abandonedRuns = await operations.abandonResumableRunsForConversation(conversation.id, actor);
  } catch (error) {
    const err = error as Error;
    if (error instanceof RunActionForbiddenError) return { success: false, message: error.message };
    getLog().error({ err, conversationId: conversation.id }, 'cmd.reset_abandon_failed');
    return { success: false, message: `Could not reset conversation: ${err.message}` };
  }
  const session = await clearActiveSession(conversation.id);
  const binding = await clearWorkspaceBinding(conversation.id);
  return resetResult(abandonedRuns, session, binding);
}

async function clearActiveSession(
  conversationId: string
): Promise<{ hadActiveSession: boolean; error: string | null }> {
  let hadActiveSession = false;
  try {
    const session = await sessionDb.getActiveSession(conversationId);
    hadActiveSession = session !== null;
    if (session) {
      await safeDeactivateSession(session.id, 'reset');
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'cmd.reset_clear_session_failed');
    return { hadActiveSession, error: err.message };
  }
  return { hadActiveSession, error: null };
}

async function clearWorkspaceBinding(
  conversationId: string
): Promise<{ cleared: boolean; error: string | null }> {
  try {
    await db.updateConversation(conversationId, { cwd: null, isolation_env_id: null });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'cmd.reset_clear_binding_failed');
    return { cleared: false, error: err.message };
  }
  return { cleared: true, error: null };
}

function resetResult(
  {
    abandoned,
    cleanupWarnings,
    releasedWorktrees,
    blockedParentRunId,
  }: AbandonConversationRunsResult,
  session: { hadActiveSession: boolean; error: string | null },
  binding: { cleared: boolean; error: string | null }
): CommandResult {
  const parts = [
    session.error !== null
      ? `Could not clear the AI session: ${session.error}`
      : session.hadActiveSession
        ? 'Session cleared.'
        : 'No active session.',
  ];
  parts.push(
    binding.cleared
      ? 'Cleared workspace binding (worktree + isolation env).'
      : `Could not clear the workspace binding: ${binding.error ?? 'unknown error'}`
  );
  for (const warning of cleanupWarnings ?? []) parts.push(`⚠️ ${warning}`);
  if (abandoned > 0) parts.push(`Abandoned ${String(abandoned)} resumable run(s).`);
  parts.push(...describeReleasedWorktrees(releasedWorktrees));
  if (blockedParentRunId !== null) {
    parts.push(
      `⚠️ Parent run ${blockedParentRunId} was blocked on an abandoned sub-run and stays paused. Resume it so it reads this sub-run's outcome, or abandon it too.`
    );
  }

  const resetComplete = session.error === null && binding.cleared && blockedParentRunId === null;
  parts.push(
    resetComplete
      ? 'Project attachment preserved — next message starts fresh.'
      : 'Project attachment preserved. Reset is incomplete — retry /reset before sending the next message.'
  );

  return {
    success: resetComplete,
    message: parts.join(' '),
  };
}
