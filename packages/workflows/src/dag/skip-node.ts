import type { DagNode, SkipCause } from '../schemas';
import { readNodeRecordEvent } from '../node-record-reader';
import { finishNodeExecution } from '../node-execution';
import { recordNodeState } from '../node-event-write';
import { safeSendMessage } from '../platform-messages';
import { PROVIDER_EVENT_ROW_TYPES, type IWorkflowStore } from '../store';
import { getLog } from './log';
import { beginExecution, type LayerNodeResult, type RunLayersContext } from './run-context';
import { skipReasonForCause } from './trigger-rule';

export function createBoundaryErrorHistory(store: IWorkflowStore, runId: string) {
  let history: Promise<Set<string>> | undefined;
  return () =>
    (history ??= readReportedBoundaryErrors(store, runId).catch(error => {
      history = undefined;
      throw error;
    }));
}

async function readReportedBoundaryErrors(
  store: IWorkflowStore,
  runId: string
): Promise<Set<string>> {
  const reported = new Set<string>();
  for (const event of await store.listWorkflowEvents(runId, {
    excludeEventTypes: PROVIDER_EVENT_ROW_TYPES,
  })) {
    if (event.event_type !== 'node_skipped') continue;
    const cause = readNodeRecordEvent(event)?.data.cause;
    if (cause?.kind === 'condition_parse_error' && cause.boundary)
      reported.add(cause.boundary.includeId);
  }
  return reported;
}

export async function skipNode(
  ctx: RunLayersContext,
  node: DagNode,
  cause: SkipCause,
  error?: unknown
): Promise<LayerNodeResult> {
  const reported =
    cause.kind === 'condition_parse_error' && cause.boundary !== undefined
      ? await ctx.getReportedBoundaryErrors()
      : undefined;
  const reportBoundary =
    cause.kind === 'condition_parse_error' &&
    cause.boundary !== undefined &&
    !reported?.has(cause.boundary.includeId);
  // Claim before yielding to peers so concurrent skips share one report.
  if (reportBoundary && cause.boundary) reported?.add(cause.boundary.includeId);
  const reason = skipReasonForCause(cause);
  getLog().info({ nodeId: node.id, reason }, 'dag_node_skipped');
  const output = await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      beginExecution(ctx, node),
      { status: 'skipped', reason, cause },
      {
        output: { text: '' },
        diagnostics: {
          iteration: ctx.loopGroupPath.at(-1)?.iteration,
          expr: 'expr' in cause ? cause.expr : undefined,
        },
      }
    )
  );
  if (reportBoundary && cause.kind === 'condition_parse_error' && cause.boundary) {
    getLog().error(
      {
        nodeId: ctx.stepNamePrefix + node.id,
        when: cause.expr,
        boundary: cause.boundary,
        err: error,
      },
      'dag_node_skipped_condition_parse_error'
    );
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `Include '${decodeURIComponent(cause.boundary.includeId)}' (workflow '${cause.boundary.workflow}'): cannot evaluate when: "${cause.expr}" at node '${ctx.stepNamePrefix + node.id}' — node skipped (fail-closed).`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
  }
  return { nodeId: node.id, output };
}
