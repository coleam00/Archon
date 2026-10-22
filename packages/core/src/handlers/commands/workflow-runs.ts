import { findProjectRunsByReference } from '../../workflows/run-id';
import { isContainerRun, runAttention } from '@archon/workflows/schemas/workflow-run';
import {
  attentionAnswerLines,
  spellWorkflowCommand,
  type WorkflowCommandSurface,
} from '@archon/workflows/deps';
import type { RunActor } from '../../operations/run-authorization';
import {
  CancelRefusedError,
  type CancelWorkflowResult,
  describeAbandonOwner,
  describeReleasedWorktrees,
  type WorkflowOperations,
} from '../../operations/workflow-operations';
import * as workflowDb from '../../db/workflows';
import type { CommandResult, Conversation } from '../../types';
import { getLog } from './log';
import { spell, type WorkflowCommand } from './workflow-command';

export async function createResumeRequest(
  operations: WorkflowOperations,
  runId: string,
  actor: RunActor
): Promise<
  | { ok: true; workflow: NonNullable<CommandResult['workflow']> }
  | { ok: false; message: string; resumeHint?: string }
> {
  const run = await operations.resumeWorkflow(runId, actor);
  // A container run can only be resumed where the container can be rewired, so
  // handing this one back for a chat dispatch would fail the run to say what we
  // can say here for free (#2565).
  if (isContainerRun(run)) {
    return {
      ok: false,
      message: 'it executed inside an isolation container, which chat cannot rewire.',
      resumeHint: `Finish it with \`archon workflow resume ${runId}\` from the CLI in the same project.`,
    };
  }
  return {
    ok: true,
    workflow: { kind: 'resume', run },
  };
}

/**
 * Resolve a run id typed in chat. The worktree-in-use refusal prints the 8-character
 * short id, so the id resolves as a prefix within this conversation's project (a full
 * id is its own prefix). A bound conversation requires a unique project match;
 * projectless conversations leave resolution to the operation.
 */
export async function resolveChatRunId(arg: string, conversation: Conversation): Promise<string> {
  if (!conversation.codebase_id) return arg;
  const matches = await findProjectRunsByReference(workflowDb, arg, conversation.codebase_id);
  if (matches.length > 1) {
    throw new Error(
      `Run id '${arg}' matches more than one run in this project. Use more characters or the full id.`
    );
  }
  const run = matches[0];
  if (!run) throw new Error(`Workflow run not found in this project: ${arg}`);
  return run.id;
}

export async function getActiveChatWorkflowRun(conversation: Conversation) {
  return workflowDb.getActiveWorkflowRun(conversation.id, conversation.codebase_id ?? undefined);
}

/** What a run needs from the operator, and the commands that answer it, one line each. */
function runAttentionLines(
  run: Parameters<typeof runAttention>[0] & { id: string },
  surface: WorkflowCommandSurface
): string {
  const cmd = (command: string): string => spellWorkflowCommand(surface, command);
  const attention = runAttention(run);
  let msg = '';
  if (attention?.kind === 'stalled_tool_calls') {
    msg += '  Tool calls need attention; work remains running.\n';
    for (const call of attention.calls)
      msg += `  ${call.nodeId} · ${call.provider} · ${call.name}: ${call.title || call.name} (running ${Math.floor(call.elapsedMs / 1000)}s; no progress ${Math.floor(call.stalledForMs / 1000)}s)\n`;
  } else if (attention?.kind === 'attention') {
    msg += `  Needs attention: ${attention.message}\n`;
    for (const line of attentionAnswerLines(surface, attention)) msg += `  ${line}\n`;
    msg += `  Abandon: \`${cmd(`abandon ${run.id}`)}\`\n`;
  } else if (attention?.kind === 'awaiting_response') {
    msg += `  Approve: \`${cmd(`approve ${attention.respondTo.runId}`)}\`\n`;
    msg += `  Reject: \`${cmd(`reject ${attention.respondTo.runId} <reason>`)}\`\n`;
  }
  return msg;
}

/** `/workflow cancel <id>` targets that run; bare `/workflow cancel` targets this conversation's running run. */
export async function cancelWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args, actor } = input;
  const cmd = (command: string): string => spell(input, command);
  let runId: string | undefined = args[1];
  try {
    runId = runId
      ? await resolveChatRunId(runId, conversation)
      : (await getActiveChatWorkflowRun(conversation))?.id;
    if (!runId) {
      return { success: true, message: 'No active workflow to cancel.' };
    }
    const result = await operations.cancelWorkflow(runId, actor);
    if (result.kind === 'cooperative') {
      return {
        success: true,
        message: result.cancelled
          ? `Cancelled workflow: \`${result.run.workflow_name}\`${cancelCleanupWarnings(result.cleanupWarnings)}`
          : `Workflow \`${result.run.workflow_name}\` already finished; nothing to cancel.`,
      };
    }
    return { success: true, message: stoppedRunMessage(input, result) };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId: conversation.id, runId }, 'cmd.workflow_cancel_failed');
    if (err instanceof CancelRefusedError) {
      const abandon =
        err.reason === 'no_owner_answered' && runId
          ? `\nAbandon it: \`${cmd(`abandon ${runId}`)}\``
          : '';
      return { success: false, message: `${err.message}${abandon}` };
    }
    return { success: false, message: `Failed to cancel workflow run: ${err.message}` };
  }
}

function stoppedRunMessage(
  input: WorkflowCommand,
  result: Extract<CancelWorkflowResult, { kind: 'stopped' }>
): string {
  let message = `Stopped the run's live owner process (pid ${String(result.pid)}), then cancelled workflow: \`${result.run.workflow_name}\``;
  message += cancelCleanupWarnings(result.cleanupWarnings);
  if (result.cascadeFailures > 0) {
    message += `\n⚠️ ${String(result.cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check ${spell(input, 'status')}.`;
  }
  if (result.blockedParentRunId) {
    message += `\n⚠️ Parent run ${result.blockedParentRunId} was blocked on this sub-run and stays paused. Resume it so it reads this sub-run's outcome, or abandon it too.`;
  }
  return message;
}

export async function getWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { conversation, args, surface } = input;
  const cmd = (command: string): string => spell(input, command);
  const arg = args[1];
  if (!arg) {
    return { success: false, message: `Usage: ${cmd('get <id>')}` };
  }
  try {
    const runId = await resolveChatRunId(arg, conversation);
    const run = await workflowDb.getWorkflowRun(runId);
    // Same scope as the lookup above: a project conversation sees its own runs.
    if (!run || (conversation.codebase_id && run.codebase_id !== conversation.codebase_id))
      return { success: false, message: `Workflow run not found: ${arg}` };
    let msg = `**\`${run.workflow_name}\`** (${run.status})\n  ID: ${run.id}\n`;
    if (run.outcome !== null) msg += `  Authored outcome: ${run.outcome}\n`;
    msg += `  Started: ${new Date(run.started_at).toISOString()}\n`;
    if (run.completed_at !== null)
      msg += `  Finished: ${new Date(run.completed_at).toISOString()}\n`;
    const error = run.metadata.error;
    if (typeof error === 'string' && error.length > 0) msg += `  Error: ${error.slice(0, 300)}\n`;
    msg += runAttentionLines(run, surface);
    return { success: true, message: msg.trim() };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId: arg }, 'cmd.workflow_get_failed');
    return { success: false, message: `Failed to look up workflow run: ${err.message}` };
  }
}

export async function listActiveWorkflowRuns(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, surface } = input;
  const cmd = (command: string): string => spell(input, command);
  try {
    const { runs: activeRuns } = await operations.getWorkflowStatus({
      codebaseId: conversation.codebase_id ?? undefined,
    });

    if (activeRuns.length === 0) {
      return { success: true, message: 'No active workflows.' };
    }

    let msg = `**Active Workflows (${String(activeRuns.length)})**\n\n`;
    for (const run of activeRuns) {
      msg += `**\`${run.workflow_name}\`** (${run.status})\n`;
      if (run.outcome !== null) msg += `  Authored outcome: ${run.outcome}\n`;
      msg += `  ID: ${run.id}\n`;
      msg += `  Path: ${run.working_path ?? '(unknown)'}\n`;
      if (run.active_nodes.length > 0) {
        msg += `  Active node${run.active_nodes.length === 1 ? '' : 's'}: ${run.active_nodes.join(', ')}\n`;
      }
      msg += `  Started: ${new Date(run.started_at).toISOString()}\n`;
      msg += runAttentionLines(run, surface);
      msg += '\n';
    }

    const hasRunning = activeRuns.some(r => r.status === 'running');
    if (hasRunning) msg += `Use \`${cmd('cancel <id>')}\` to stop a running workflow.`;
    return { success: true, message: msg.trim() };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId: conversation.id }, 'cmd.workflow_status_failed');
    return {
      success: false,
      message: 'Failed to retrieve workflow status. Please try again.',
    };
  }
}

export async function resumeWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args, actor } = input;
  const cmd = (command: string): string => spell(input, command);
  let runId = args[1];
  if (!runId) {
    return {
      success: false,
      message: `Usage: ${cmd('resume <id>')}\n\nResumes a failed or paused workflow from completed nodes.`,
    };
  }
  try {
    runId = await resolveChatRunId(runId, conversation);
    const continuation = await createResumeRequest(operations, runId, actor);
    if (!continuation.ok) {
      return { success: false, message: continuation.message };
    }
    return {
      success: true,
      message: 'Resume requested',
      workflow: continuation.workflow,
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cmd.workflow_resume_failed');
    return { success: false, message: `Failed to resume workflow run: ${err.message}` };
  }
}

export async function abandonWorkflowRun(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args, actor } = input;
  const cmd = (command: string): string => spell(input, command);
  let runId = args[1];
  if (!runId) {
    return {
      success: false,
      message: `Usage: ${cmd('abandon <id>')}\n\nUse ${cmd('status')} to see active runs.`,
    };
  }
  try {
    runId = await resolveChatRunId(runId, conversation);
    const { run, cascadeFailures, cleanupWarnings, releasedWorktrees, blockedParentRunId, owner } =
      await operations.abandonWorkflow(runId, actor);
    let message = [
      ...describeAbandonOwner(owner),
      `Abandoned workflow run \`${run.workflow_name}\` (${runId})`,
      ...describeReleasedWorktrees(releasedWorktrees),
    ].join('\n');
    for (const warning of cleanupWarnings ?? []) message += `\n⚠️ ${warning}`;
    if (cascadeFailures > 0) {
      message += `\n⚠️ ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check ${cmd('status')}.`;
    }
    if (blockedParentRunId) {
      message += `\n⚠️ Parent run ${blockedParentRunId} was blocked on this sub-run and stays paused. Resume it so it reads this sub-run's outcome, or abandon it too.`;
    }
    return { success: true, message };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cmd.workflow_abandon_failed');
    return { success: false, message: `Failed to abandon workflow run: ${err.message}` };
  }
}

export async function resetWorkflowSessions(input: WorkflowCommand): Promise<CommandResult> {
  const { operations, conversation, args } = input;
  const cmd = (command: string): string => spell(input, command);
  const workflowName = args[1];
  const nodeId = args[2];
  if (!workflowName) {
    return {
      success: false,
      message: `Usage: ${cmd('reset-sessions <workflow-name> [<node-id>]')}\n\nClears persisted AI session memory for this workflow in this conversation.`,
    };
  }
  try {
    const { deleted } = await operations.resetWorkflowNodeSessions({
      workflow_name: workflowName,
      scope_key: conversation.id,
      node_id: nodeId,
    });
    const nodeSuffix = nodeId ? ` node \`${nodeId}\` of` : '';
    return {
      success: true,
      message: `Cleared ${deleted} persisted session(s) for${nodeSuffix} workflow \`${workflowName}\` in this conversation.`,
    };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName, nodeId }, 'cmd.workflow_reset_sessions_failed');
    return {
      success: false,
      message: `Failed to reset workflow sessions: ${err.message}`,
    };
  }
}

function cancelCleanupWarnings(warnings: readonly string[] = []): string {
  return warnings.map(warning => `\n⚠️ ${warning}`).join('');
}
