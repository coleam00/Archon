import type { TokenUsage } from '@archon/provider-contract';
import type { IWorkflowPlatform, WorkflowDeps } from '../deps';
import { safeSendMessage } from '../platform-messages';
import { persistNodeEvent, recordDerivedNodeState, recordNodeState } from '../node-event-write';
import { finishNodeExecution } from '../node-execution';
import { persistedOutputContract, type NodeExecutionResult } from '../node-record-serialization';
import { declaredOutputPathsFromSchema } from '../output-ref';
import type { LoopGroupNode, LoopNode, WorkflowRun } from '../schemas';
import type { LoopCompletionChannel } from '../schemas/loop';
import { type NodeExecutionRecord } from '../schemas/node-execution';
import { getLog } from './log';

/** Cap for the iteration-output excerpt embedded in gate messages — keeps the
 *  persisted `metadata.approval.message` and SSE payloads bounded (mirrors the
 *  tool-input truncation used for progress events). */
export const GATE_EXCERPT_MAX = 500;

type LoopCompletionResults = {
  until: { signal: string; completed: boolean };
  until_bash: { completed: boolean };
  until_field: { field: string; completed: boolean };
};

export type LoopCompletionCheck = {
  [Channel in LoopCompletionChannel]: { channel: Channel } & LoopCompletionResults[Channel];
}[LoopCompletionChannel];

export function describeLoopCompletionCheck(check: LoopCompletionCheck): string {
  switch (check.channel) {
    case 'until':
      return `\`until\` signal (\`${check.signal}\`)`;
    case 'until_bash':
      return '`until_bash`';
    case 'until_field':
      return `\`until_field\` (\`${check.field}\`)`;
  }
  const unreachable: never = check;
  return unreachable;
}

/**
 * Build the honest interactive-gate message (#2074, change D): an engine-generated
 * status line naming the completion channels that fired (or every declared channel
 * when none fired), plus a bounded excerpt of the final iteration output, prepended
 * to the author's static `gate_message`. Shared by executeLoopNode and
 * executeLoopGroupNode so both gates tell the truth about the iteration they paused on.
 */
export function buildHonestGateMessage(
  completionChecks: LoopCompletionCheck[],
  lastIterationOutput: string,
  gateMessage: string
): string {
  const trimmed = lastIterationOutput.trim();
  const excerpt = trimmed.slice(0, GATE_EXCERPT_MAX);
  const completedChecks = completionChecks.filter(check => check.completed);
  const describedChecks = (completedChecks.length > 0 ? completedChecks : completionChecks).map(
    describeLoopCompletionCheck
  );
  const statusLine =
    completedChecks.length > 0
      ? `✅ Completion condition${completedChecks.length === 1 ? '' : 's'} met via ${describedChecks.join(' and ')}.`
      : `⚠️ No completion condition met in this iteration (${describedChecks.join(', ')}).`;
  const excerptBlock = excerpt
    ? `\n\n> ${excerpt}${trimmed.length > GATE_EXCERPT_MAX ? '…' : ''}`
    : '';
  return `${statusLine}${excerptBlock}\n\n${gateMessage}`;
}

/** Complete a signaled loop without another provider call, retaining its paused observations. */
export async function finalizeLoopFromSignal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  node: LoopNode | LoopGroupNode,
  stepName: string,
  nodeLabel: string,
  finalizeOutput: string,
  finalizeUsage: { costUsd?: number; costPartial?: boolean; tokens?: TokenUsage } | undefined,
  finalizeStructuredOutput: unknown,
  logDir: string,
  execution?: NodeExecutionRecord,
  sessionId?: string
): Promise<NodeExecutionResult> {
  const nodeId = node.id;
  // Impossible by construction today (the gate writes signaledOutput whenever
  // completionSignaled is true) — this warn guards a future decoupling so a
  // finalize that silently loses the iteration output is diagnosable.
  if (finalizeOutput === '') {
    getLog().warn(
      { workflowRunId: workflowRun.id, nodeId },
      'loop_node.finalize_missing_signaled_output'
    );
  }
  await safeSendMessage(
    platform,
    conversationId,
    `${nodeLabel} '${nodeId}' accepted after a completion condition was met (no re-run)`,
    { workflowId: workflowRun.id, nodeName: nodeId }
  );
  const output = {
    text: finalizeOutput,
    structured: finalizeStructuredOutput,
    declaredOutputPaths: declaredOutputPathsFromSchema(node.output_format),
  };
  if (execution !== undefined) {
    return recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output,
          ...finalizeUsage,
          sessionId,
          // Approval does no execution work. Keep the duration observed before pause.
          durationMs: execution.timing.durationMs,
        }
      )
    );
  }
  // Older paused loop gates may lack execution identity and observed start time.
  // Preserve their completion without inventing historical execution metadata.
  const event: import('../store').NodeStateEventInput = {
    workflow_run_id: workflowRun.id,
    event_type: 'node_completed',
    step_name: stepName,
    data: {
      node_output: finalizeOutput,
      ...(finalizeStructuredOutput !== undefined
        ? { structured_output: finalizeStructuredOutput }
        : {}),
      ...(output.declaredOutputPaths !== undefined
        ? persistedOutputContract(output.declaredOutputPaths)
        : {}),
      ...(finalizeUsage?.costUsd !== undefined ? { cost_usd: finalizeUsage.costUsd } : {}),
      ...(finalizeUsage?.tokens !== undefined ? { tokens: finalizeUsage.tokens } : {}),
    },
  };
  await persistNodeEvent(deps.store, event);
  await recordDerivedNodeState({ logDir }, node, event);
  return {
    state: 'completed',
    output: finalizeOutput,
    ...(finalizeStructuredOutput !== undefined
      ? { structuredOutput: finalizeStructuredOutput }
      : {}),
    ...(output.declaredOutputPaths !== undefined
      ? { declaredOutputPaths: output.declaredOutputPaths }
      : {}),
    ...(finalizeUsage?.costUsd !== undefined ? { costUsd: finalizeUsage.costUsd } : {}),
    ...(finalizeUsage?.tokens !== undefined ? { tokens: finalizeUsage.tokens } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
