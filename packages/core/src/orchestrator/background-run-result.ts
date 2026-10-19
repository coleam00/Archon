import { createLogger } from '@archon/paths';
import { spellWorkflowCommand, type IWorkflowPlatform } from '@archon/workflows/deps';
import {
  isSourceExecutionStopped,
  type WorkflowExecutionResult,
} from '@archon/workflows/schemas/workflow';
import { toError } from '../utils/error';

export async function surfaceBackgroundRunResult(
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowName: string,
  result: WorkflowExecutionResult
): Promise<void> {
  try {
    if (isSourceExecutionStopped(result)) {
      await platform.sendMessage(
        conversationId,
        `Source execution stopped for run ${result.workflowRunId}${result.success ? '' : `: ${result.error}`}. Inspect its state and ownership with \`${spellWorkflowCommand(platform, `get ${result.workflowRunId}`)}\`.`
      );
      return;
    }
    if ('paused' in result) return;
    const text = result.success
      ? result.summary
      : `Workflow **${workflowName}** failed: ${result.error}`;
    if (!text || !result.workflowRunId) return;
    await platform.sendMessage(conversationId, text, {
      category: 'workflow_result',
      segment: 'new',
      workflowResult: { workflowName, runId: result.workflowRunId },
    });
  } catch (surfaceError) {
    createLogger('orchestrator').warn(
      { err: toError(surfaceError), conversationId },
      'workflow_output_surface_failed'
    );
  }
}
