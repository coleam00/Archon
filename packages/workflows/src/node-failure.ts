/**
 * Helpers to persist and surface per-node failure diagnostics.
 */
import type { NodeFailureDetail } from './schemas/node-failure';
import {
  WORKFLOW_RUN_NODE_FAILURES_KEY,
  readNodeFailuresFromMetadata,
} from './schemas/node-failure';
import type { WorkflowDeps } from './deps';
import type { WorkflowRun, NodeOutput } from './schemas/workflow-run';

export type { NodeFailureDetail };

export function buildNodeFailureDetail(params: {
  nodeId: string;
  error: string;
  model?: string;
  provider?: string;
  stderr?: string;
  retryCount: number;
  circuitBreaker?: boolean;
  fallbackModel?: string;
}): NodeFailureDetail {
  return {
    node: params.nodeId,
    error: params.error,
    retry_count: params.retryCount,
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.stderr !== undefined && params.stderr.length > 0 ? { stderr: params.stderr } : {}),
    ...(params.circuitBreaker ? { circuit_breaker: true } : {}),
    ...(params.fallbackModel !== undefined ? { fallback_model: params.fallbackModel } : {}),
  };
}

/** Shape written to workflow_events.data for node_failed rows. */
export function nodeFailureEventData(detail: NodeFailureDetail): Record<string, unknown> {
  return {
    error: detail.error,
    model: detail.model,
    provider: detail.provider,
    stderr: detail.stderr,
    retry_count: detail.retry_count,
    circuit_breaker: detail.circuit_breaker,
    fallback_model: detail.fallback_model,
  };
}

export function attachFailureToOutput(
  output: NodeOutput & { costUsd?: number },
  detail: NodeFailureDetail
): NodeOutput & { costUsd?: number } {
  if (output.state !== 'failed') return output;
  return { ...output, failure: detail };
}

/**
 * Append/replace this node's failure record on the workflow run metadata.
 */
export async function recordNodeFailure(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  detail: NodeFailureDetail,
  nodeName: string
): Promise<void> {
  const prior = readNodeFailuresFromMetadata(workflowRun.metadata);
  const failures = [...prior.filter(f => f.node !== detail.node), detail];
  workflowRun.metadata = { ...workflowRun.metadata, [WORKFLOW_RUN_NODE_FAILURES_KEY]: failures };

  await deps.store
    .updateWorkflowRun(workflowRun.id, { metadata: workflowRun.metadata })
    .catch(() => undefined);

  const eventData = nodeFailureEventData(detail);
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_failed',
      step_name: detail.node,
      data: eventData,
    })
    .catch(() => undefined);
  void nodeName;
}
