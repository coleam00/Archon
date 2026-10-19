import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';

const FAILED_RUN_PROMPT_PREVIEW_MAX = 160;

function escapeWorkflowCommandArg(value: string): string {
  return value.replace(/[\\"`]/g, '\\$&');
}

function formatPriorRunPromptPreview(message: string | null): string {
  const normalized = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no message stored)';
  }
  if (normalized.length <= FAILED_RUN_PROMPT_PREVIEW_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, FAILED_RUN_PROMPT_PREVIEW_MAX)}…`;
}

export function formatResumableRunState(status: WorkflowRun['status']): string {
  return status === 'running' ? 'interrupted' : status;
}

export function buildFailedRunResumePrompt(
  surface: WorkflowCommandSurface,
  workflowName: string,
  resumableRun: WorkflowRun,
  userMessage: string
): string {
  const escapedMessage = escapeWorkflowCommandArg(userMessage);
  const run = `run ${workflowName}`;
  const priorPreview = formatPriorRunPromptPreview(resumableRun.user_message);
  // This prompt fires for any non-paused resumable run — that includes a stale
  // 'running' orphan (started but never finished), not only 'failed' runs, so
  // the wording must track the actual status rather than hardcoding "failed".
  const stateLabel = formatResumableRunState(resumableRun.status);

  return [
    '---',
    '',
    `Found a prior ${stateLabel} run of **${workflowName}** (run \`${resumableRun.id}\`).`,
    '',
    '**Run prompt was:**',
    '',
    `> ${priorPreview}`,
    '',
    '---',
    '',
    '**Choose how to proceed:**',
    '',
    '**1. Resume that run** (re-runs the prompt shown above, not your current message):',
    '```',
    spellWorkflowCommand(surface, `resume ${resumableRun.id}`),
    '```',
    '',
    `**2. Discard the ${stateLabel} run, then start fresh with your current message:**`,
    '```',
    spellWorkflowCommand(surface, `abandon ${resumableRun.id}`),
    '```',
    'then re-run your command:',
    '```',
    spellWorkflowCommand(surface, `${run} "${escapedMessage}"`),
    '```',
    '',
    `**3. Start fresh with your current message, leave the ${stateLabel} run as-is** (skips the resume check):`,
    '```',
    spellWorkflowCommand(surface, `${run} --force "${escapedMessage}"`),
    '```',
  ].join('\n');
}
