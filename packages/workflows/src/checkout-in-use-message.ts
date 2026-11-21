import { formatDuration } from '@archon/paths/duration';
import type { IWorkflowPlatform } from './deps';
import { attentionAnswerLines, spellWorkflowCommand } from './deps';
import type { WorkflowRun } from './schemas';
import { pendingWorkflowWaitDeadline, runAttention } from './schemas';
import { describeOperatorPause, operatorPause } from './schemas/operator-pause';
import { workflowPathPriorityTime } from './workflow-path-lock';

/** Spell a workflow action the way the surface rendering the message accepts it. */
function formatRunCommand(platform: IWorkflowPlatform, action: string, shortId?: string): string {
  return spellWorkflowCommand(platform, shortId ? `${action} ${shortId}` : action);
}

/** Explain which run holds the checkout and what the user can do about it. */
export function checkoutInUseMessage(
  platform: IWorkflowPlatform,
  activeWorkflow: WorkflowRun
): string {
  const elapsedMs = Date.now() - workflowPathPriorityTime(activeWorkflow).getTime();
  const duration = formatDuration(elapsedMs);
  const shortId = activeWorkflow.id.slice(0, 8);

  let stateLine: string;
  let actionLines: string;
  if (activeWorkflow.status === 'paused') {
    ({ stateLine, actionLines } = pausedCheckoutState(platform, activeWorkflow, duration, shortId));
    actionLines +=
      // Cancel stops live work, and a paused run has none: abandon discards it.
      `• Discard it: \`${formatRunCommand(platform, 'abandon', shortId)}\`\n` +
      '• Use a different branch: `--branch <other>`';
  } else {
    const verb = activeWorkflow.status === 'pending' ? 'starting' : 'running';
    stateLine = `${verb} ${duration}, run \`${shortId}\``;
    // Cancel only accepts a running run; a pending one has nothing executing yet.
    const cancelLine =
      activeWorkflow.status === 'running'
        ? `• Cancel it: \`${formatRunCommand(platform, 'cancel', shortId)}\`\n`
        : '';
    actionLines =
      `• Wait for it to finish: \`${formatRunCommand(platform, 'status')}\`\n` +
      cancelLine +
      `• If its process is gone: \`${formatRunCommand(platform, 'abandon', shortId)}\`\n` +
      '• Use a different branch: `--branch <other>`';
  }
  return (
    `❌ **This worktree is in use** by \`${activeWorkflow.workflow_name}\` ` +
    `(${stateLine}).\n${actionLines}`
  );
}

function pausedCheckoutState(
  platform: IWorkflowPlatform,
  activeWorkflow: WorkflowRun,
  duration: string,
  shortId: string
): { stateLine: string; actionLines: string } {
  let stateLine: string, actionLines: string;
  const attention = runAttention(activeWorkflow);
  const wait = pendingWorkflowWaitDeadline(activeWorkflow);
  const pause = operatorPause(activeWorkflow);
  if (pause !== null) {
    // An operator pause asks nothing; a gate or wait left on the row is history.
    stateLine = `${describeOperatorPause(pause)} (run \`${shortId}\`)`;
    actionLines = `• Resume it: \`${formatRunCommand(platform, 'resume', shortId)}\`\n`;
  } else if (attention?.kind === 'attention') {
    stateLine = `paused, needs attention (${duration} since phase began, run \`${shortId}\`)`;
    actionLines = `• Answer it: ${attention.message}\n${attentionAnswerLines(platform, attention)
      .map(line => `• ${line}\n`)
      .join('')}`;
  } else if (wait) {
    const waitingFor =
      wait.kind === 'event'
        ? `for event \`${wait.event}\` until`
        : wait.kind === 'quota'
          ? 'on a provider usage or rate limit, trying again at'
          : 'until';
    stateLine = `paused waiting ${waitingFor} ${wait.resumeAt} (${duration} since phase began, run \`${shortId}\`)`;
    actionLines =
      (wait.kind === 'event'
        ? `• Signal event \`${wait.event}\` for run \`${activeWorkflow.id}\`\n`
        : '') + `• Wait until ${wait.resumeAt}: \`${formatRunCommand(platform, 'status')}\`\n`;
  } else if (attention?.kind === 'blocked_on_child' || attention?.kind === 'blocked_on_children') {
    // The parent takes no answer of its own; it continues when its sub-runs finish.
    const childRunIds =
      attention.kind === 'blocked_on_child' ? [attention.childRunId] : attention.childRunIds;
    stateLine = `paused waiting on sub-runs (${duration} since phase began, run \`${shortId}\`)`;
    actionLines = `• Check sub-runs ${childRunIds.map(id => `\`${id}\``).join(', ')}: \`${formatRunCommand(platform, 'status')}\`\n`;
  } else {
    stateLine = `paused waiting for user input (${duration} since phase began, run \`${shortId}\`)`;
    actionLines =
      `• Approve it: \`${formatRunCommand(platform, 'approve', shortId)}\`\n` +
      `• Reject it: \`${formatRunCommand(platform, 'reject', shortId)}\`\n`;
  }
  return { stateLine, actionLines };
}
