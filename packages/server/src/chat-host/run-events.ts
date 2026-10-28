import { ChildRunRedirectError } from '@archon/core/operations/workflow-operations';
import { isApprovalContext } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowCommandSurface } from '@archon/workflows/deps';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import type { ChatRunEvent } from '@archon/chat-contract';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '@archon/core/db/workflows';
import * as conversationDb from '@archon/core/db/conversations';
import { createLogger } from '@archon/paths';
import type { ChatSupervisor } from './supervisor';

type WorkflowStarted = Extract<ChatRunEvent, { type: 'workflow_started' }>;
/** A chat run event before routing supplies the platform conversation id. */
type ProjectedRunEvent =
  | Exclude<ChatRunEvent, WorkflowStarted>
  | Omit<WorkflowStarted, 'conversationId'>;

/** The run's recorded total cost, when it is a usable amount. */
export function runTotalCostUsd(run: WorkflowRun): number | undefined {
  const cost = run.metadata.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

export function projectRunEvent(event: WorkflowEmitterEvent): ProjectedRunEvent | undefined {
  const runId = event.runId;
  switch (event.type) {
    case 'workflow_started':
      return { type: 'workflow_started', runId, workflowName: event.workflowName };
    case 'node_started':
    case 'node_suspended':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'running',
      };
    case 'node_skipped_prior_success':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'completed',
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
        decisions: getApprovalDecisions(event),
        pauseId: event.pauseId,
      };
    case 'workflow_completed':
      return { type: 'terminal', runId, status: 'completed' };
    case 'workflow_failed':
      return { type: 'terminal', runId, status: 'failed', error: event.error };
    case 'workflow_cancelled':
      return { type: 'terminal', runId, status: 'cancelled', error: event.reason };
    case 'loop_iteration_started':
    case 'loop_iteration_completed':
    case 'loop_iteration_failed':
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

function applyRunDetails(
  run: WorkflowRun,
  routed: ChatRunEvent,
  platform: string,
  platforms: ReadonlyMap<string, WorkflowCommandSurface>
): void {
  if (routed.type === 'approval_pending' || routed.type === 'terminal')
    routed.authoredOutcome = run.outcome ?? undefined;
  const approval = run.metadata.approval;
  if (
    routed.type === 'approval_pending' &&
    isApprovalContext(approval) &&
    approval.type === 'child_workflow' &&
    approval.childRunId &&
    approval.nodeId === routed.nodeId &&
    approval.pauseId === routed.pauseId
  ) {
    const surface = platforms.get(platform);
    if (!surface) throw new Error(`Chat platform ${platform} is unavailable`);
    routed.message = new ChildRunRedirectError(
      run.id,
      [approval.childRunId],
      routed.nodeId,
      'approve'
    ).messageFor(surface);
  }
  if (routed.type === 'terminal') {
    const cost = runTotalCostUsd(run);
    if (cost !== undefined) routed.totalCostUsd = cost;
  }
}

export function subscribeChatRunEvents(
  plugins: ReadonlyMap<string, ChatSupervisor>,
  platforms: ReadonlyMap<string, WorkflowCommandSurface>
): () => void {
  const log = createLogger('server.chat-events');
  const emitter = getWorkflowEventEmitter();
  let stopped = false;
  // Routing reads the DB in emission order; delivery runs on one chain per
  // plugin so a stalled plugin's runEvent never delays another plugin's events.
  let routing = Promise.resolve();
  const deliveries = new Map<string, Promise<void>>();
  const unsubscribe = emitter.subscribe(event => {
    const projected = projectRunEvent(event);
    if (!projected) return;
    const fail = (): void => {
      log.warn({ eventType: event.type }, 'chat.run_event_failed');
    };
    routing = routing
      .then(async () => {
        if (stopped) return;
        const run = await workflowDb.getWorkflowRun(event.runId);
        if (!run) return;
        const id = run.parent_conversation_id ?? run.conversation_id;
        if (!id) return;
        const conversation = await conversationDb.getConversationById(id);
        if (!conversation?.platform_conversation_id) return;
        const platform = conversation.platform_type;
        const plugin = plugins.get(platform);
        if (!plugin?.plugin.descriptor.capabilities.runEvents) return;
        const routed: ChatRunEvent =
          projected.type === 'workflow_started'
            ? { ...projected, conversationId: conversation.platform_conversation_id }
            : projected;
        applyRunDetails(run, routed, platform, platforms);
        const delivery = (deliveries.get(platform) ?? Promise.resolve())
          .then(async () => {
            if (!stopped) await plugin.runEvent(routed);
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
