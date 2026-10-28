import type { HaltNode, NodeOutput } from '../../../schemas';
import { serializeNodeOutput } from '../../../node-record-serialization';
import { recordNodeState } from '../../../node-event-write';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { requireTerminalStatusWrite } from '../../../terminal-status-write';
import { safeSendMessage } from '../../../platform-messages';
import { beginExecution, type RunLayersContext } from '../../run-context';
import { substituteNodeOutputRefs } from '../../references';

export async function executeHaltNode(ctx: RunLayersContext, node: HaltNode): Promise<NodeOutput> {
  const execution = beginExecution(ctx, node);
  await recordNodeState({ store: ctx.deps.store, logDir: ctx.logDir }, execution);
  // Cancel node dispatch — terminates the workflow run
  const reason = substituteNodeOutputRefs(node.reason, ctx.nodeOutputs, ctx.loopBodyScopes);
  const cancelMsg = `❌ **Workflow cancelled** (node \`${node.id}\`): ${reason}`;
  await safeSendMessage(ctx.platform, ctx.conversationId, cancelMsg, {
    workflowId: ctx.workflowRun.id,
    nodeName: node.id,
  });
  await requireTerminalStatusWrite(
    ctx.deps.store.cancelWorkflowRun(ctx.workflowRun.id, {
      step_name: ctx.stepNamePrefix + node.id,
      reason,
      cancel_reason: 'halt_node',
    }),
    { workflowRunId: ctx.workflowRun.id, site: 'dag.halt_cancel' }
  );
  getWorkflowEventEmitter().emit({
    type: 'workflow_cancelled',
    runId: ctx.workflowRun.id,
    nodeId: node.id,
    reason,
  });
  // The cancellation transaction owns terminality; no node completion was committed.
  return serializeNodeOutput(execution);
}
