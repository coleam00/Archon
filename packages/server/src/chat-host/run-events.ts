import type { ChatRunEvent } from '@archon/chat-contract';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import * as workflowDb from '@archon/core/db/workflows';
import * as conversationDb from '@archon/core/db/conversations';
import { createLogger } from '@archon/paths';
import type { ChatSupervisor } from './supervisor';

export function projectRunEvent(
  event: WorkflowEmitterEvent,
  conversationId: string
): ChatRunEvent | undefined {
  const runId = event.runId;
  switch (event.type) {
    case 'workflow_started':
      return { type: 'workflow_started', runId, workflowName: event.workflowName, conversationId };
    case 'node_started':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'running',
      };
    case 'node_completed':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'completed',
        durationMs: event.duration,
      };
    case 'node_failed':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'failed',
        error: event.error,
      };
    case 'node_skipped':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'skipped',
      };
    case 'approval_pending':
      return {
        type: 'approval_pending',
        runId,
        nodeId: event.nodeId,
        message: event.message,
        decisions: event.decisions,
        pauseId: event.pauseId,
      };
    case 'workflow_completed':
      return { type: 'terminal', runId, status: 'completed' };
    case 'workflow_failed':
      return { type: 'terminal', runId, status: 'failed', error: event.error };
    case 'workflow_cancelled':
      return { type: 'terminal', runId, status: 'cancelled' };
    case 'loop_iteration_started':
    case 'loop_iteration_completed':
    case 'loop_iteration_failed':
    case 'node_suspended':
    case 'node_skipped_prior_success':
    case 'workflow_artifact':
    case 'provider_event':
    case 'container_lifecycle':
    case 'run_attention_changed':
      return undefined;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function subscribeChatRunEvents(plugins: ReadonlyMap<string, ChatSupervisor>): () => void {
  const log = createLogger('server.chat-events');
  const emitter = getWorkflowEventEmitter();
  let stopped = false;
  // Routing reads the DB in emission order; delivery runs on one chain per
  // plugin so a stalled plugin's runEvent never delays another plugin's events.
  let routing = Promise.resolve();
  const deliveries = new Map<string, Promise<void>>();
  const unsubscribe = emitter.subscribe(event => {
    const projected = projectRunEvent(event, event.runId);
    if (!projected) return;
    const fail = (): void => {
      log.warn({ eventType: event.type }, 'chat.run_event_failed');
    };
    routing = routing
      .then(async () => {
        if (stopped) return;
        const run = await workflowDb.getWorkflowRun(event.runId);
        const id = run?.parent_conversation_id ?? run?.conversation_id;
        if (!id) return;
        const conversation = await conversationDb.getConversationById(id);
        if (!conversation?.platform_conversation_id) return;
        const platform = conversation.platform_type;
        const plugin = plugins.get(platform);
        if (!plugin?.plugin.descriptor.capabilities.runEvents) return;
        if (projected.type === 'workflow_started')
          projected.conversationId = conversation.platform_conversation_id;
        if (projected.type === 'terminal') {
          projected.authoredOutcome = run ? (run.outcome ?? undefined) : 'unavailable';
          const cost = run?.metadata.total_cost_usd;
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
            projected.totalCostUsd = cost;
        }
        const delivery = (deliveries.get(platform) ?? Promise.resolve())
          .then(async () => {
            if (!stopped) await plugin.runEvent(projected);
          })
          .catch(fail);
        deliveries.set(platform, delivery);
      })
      .catch(fail);
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
