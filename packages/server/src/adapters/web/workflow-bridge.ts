import { createLogger } from '@archon/paths';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';
import { SSETransport } from './transport';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.web.bridge');
  return cachedLog;
}

export function mapWorkflowEvent(event: WorkflowEmitterEvent): string | null {
  switch (event.type) {
    case 'workflow_started':
    case 'workflow_completed':
    case 'workflow_failed':
      return JSON.stringify({
        type: 'workflow_status',
        runId: event.runId,
        workflowName: event.workflowName,
        status:
          event.type === 'workflow_started'
            ? 'running'
            : event.type === 'workflow_completed'
              ? 'completed'
              : 'failed',
        error: event.type === 'workflow_failed' ? event.error : undefined,
        timestamp: Date.now(),
      });

    case 'loop_iteration_started':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        nodeId: event.nodeId,
        step: event.iteration - 1,
        total: event.maxIterations,
        name: `iteration-${String(event.iteration)}`,
        status: 'running',
        iteration: event.iteration,
        timestamp: Date.now(),
      });

    case 'loop_iteration_completed':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        nodeId: event.nodeId,
        step: event.iteration - 1,
        // total: 0 intentionally — maxIterations is not carried by loop_iteration_completed/failed events.
        // workflow-store.ts handleLoopIteration guards against 0 by preserving the prior wf.maxIterations value.
        total: 0,
        name: `iteration-${String(event.iteration)}`,
        status: 'completed',
        duration: event.duration,
        iteration: event.iteration,
        timestamp: Date.now(),
      });

    case 'loop_iteration_failed':
      return JSON.stringify({
        type: 'workflow_step',
        runId: event.runId,
        nodeId: event.nodeId,
        step: event.iteration - 1,
        // total: 0 intentionally — maxIterations is not carried by loop_iteration_completed/failed events.
        // workflow-store.ts handleLoopIteration guards against 0 by preserving the prior wf.maxIterations value.
        total: 0,
        name: `iteration-${String(event.iteration)}`,
        status: 'failed',
        iteration: event.iteration,
        timestamp: Date.now(),
      });

    case 'workflow_artifact':
      return JSON.stringify({
        type: 'workflow_artifact',
        runId: event.runId,
        artifactType: event.artifactType,
        label: event.label,
        url: event.url,
        path: event.path,
        timestamp: Date.now(),
      });

    case 'node_started':
    case 'node_completed':
    case 'node_failed':
    case 'node_skipped':
      return JSON.stringify({
        type: 'dag_node',
        runId: event.runId,
        nodeId: event.nodeId,
        name: event.nodeName,
        status:
          event.type === 'node_started'
            ? 'running'
            : event.type === 'node_completed'
              ? 'completed'
              : event.type === 'node_failed'
                ? 'failed'
                : 'skipped',
        duration: event.type === 'node_completed' ? event.duration : undefined,
        error: event.type === 'node_failed' ? event.error : undefined,
        reason: event.type === 'node_skipped' ? event.reason : undefined,
        timestamp: Date.now(),
      });

    case 'tool_started':
      return JSON.stringify({
        type: 'workflow_tool_activity',
        runId: event.runId,
        toolName: event.toolName,
        stepName: event.stepName,
        status: 'started',
        timestamp: Date.now(),
      });

    case 'tool_completed':
      return JSON.stringify({
        type: 'workflow_tool_activity',
        runId: event.runId,
        toolName: event.toolName,
        stepName: event.stepName,
        status: 'completed',
        durationMs: event.durationMs,
        timestamp: Date.now(),
      });

    case 'approval_pending':
      return JSON.stringify({
        type: 'workflow_status',
        runId: event.runId,
        workflowName: '',
        status: 'paused',
        timestamp: Date.now(),
        approval: {
          nodeId: event.nodeId,
          message: event.message,
        },
      });

    case 'workflow_cancelled':
      return JSON.stringify({
        type: 'workflow_status',
        runId: event.runId,
        workflowName: '',
        status: 'cancelled',
        timestamp: Date.now(),
      });

    default: {
      const exhaustiveCheck: never = event;
      getLog().warn(
        { type: (exhaustiveCheck as { type: string }).type },
        'unhandled_workflow_event'
      );
      return null;
    }
  }
}

/** Read the first present string field from a parsed event `data` object. */
function dataStr(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** DB event_type → run-level status, emitted as a `workflow_status` SSE event. */
const ROW_WORKFLOW_STATUS: Record<string, 'running' | 'completed' | 'failed' | 'cancelled'> = {
  workflow_started: 'running',
  workflow_completed: 'completed',
  workflow_failed: 'failed',
  workflow_cancelled: 'cancelled',
};

/** DB event_type → node-level status, emitted as a `dag_node` SSE event. */
const ROW_NODE_STATUS: Record<string, 'running' | 'completed' | 'failed' | 'skipped'> = {
  node_started: 'running',
  step_started: 'running',
  loop_iteration_started: 'running',
  node_completed: 'completed',
  step_completed: 'completed',
  loop_iteration_completed: 'completed',
  node_failed: 'failed',
  loop_iteration_failed: 'failed',
  node_skipped: 'skipped',
  node_skipped_prior_success: 'skipped',
};

/** SSE payload shapes the console dashboard reacts to — a typed contract for the hand-built JSON. */
interface WorkflowStatusSsePayload {
  type: 'workflow_status';
  runId: string;
  workflowName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  error?: string;
  approval?: { nodeId: string; message: string };
  timestamp: number;
}

interface DagNodeSsePayload {
  type: 'dag_node';
  runId: string;
  nodeId: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
  timestamp: number;
}

/**
 * The persisted event types the dashboard poller should query — exactly the ones
 * `mapWorkflowEventRow` maps. Filtering to these in SQL keeps high-frequency `tool_*`
 * rows out of the poller's result, so a single 1-second bucket realistically never
 * exceeds the drain limit (the boundary paging can't stall on overflow).
 */
export const DASHBOARD_SOURCE_EVENT_TYPES: readonly string[] = [
  ...Object.keys(ROW_WORKFLOW_STATUS),
  ...Object.keys(ROW_NODE_STATUS),
  'approval_requested',
  'approval_received',
];

/**
 * Map a persisted workflow_events DB row to a dashboard SSE event string (or null
 * to skip). Used by the DashboardEventPoller to replay events written by ANY
 * process (incl. out-of-process CLI runs) to `__dashboard__`.
 *
 * Only emits the event types the dashboard reacts to — `workflow_status` and
 * `dag_node` (the client `invalidate('runs')` + refetches on those). High-frequency
 * `tool_*` and internal markers (`node_session_resumed`, `node_always_run_reset`,
 * `workflow_artifact`, `ralph_*`) are skipped — the surrounding lifecycle events
 * already trigger the refetch. Keyed by `workflow_run_id`; since the client
 * refetches rather than applying the payload, the exact field values are
 * best-effort (the REST refetch is the source of truth).
 */
export function mapWorkflowEventRow(row: WorkflowEventRow): string | null {
  const runId = row.workflow_run_id;
  const data = row.data;
  const timestamp = Date.now();

  const workflowStatus = ROW_WORKFLOW_STATUS[row.event_type];
  if (workflowStatus) {
    const payload: WorkflowStatusSsePayload = {
      type: 'workflow_status',
      runId,
      workflowName: dataStr(data, 'workflow_name', 'workflowName') ?? '',
      status: workflowStatus,
      error: row.event_type === 'workflow_failed' ? dataStr(data, 'error') : undefined,
      timestamp,
    };
    return JSON.stringify(payload);
  }

  if (row.event_type === 'approval_requested') {
    const payload: WorkflowStatusSsePayload = {
      type: 'workflow_status',
      runId,
      workflowName: '',
      status: 'paused',
      timestamp,
      approval: {
        nodeId: row.step_name ?? dataStr(data, 'nodeId', 'node_id') ?? '',
        message: dataStr(data, 'message') ?? '',
      },
    };
    return JSON.stringify(payload);
  }

  // Decision recorded → the run leaves the paused gate; trigger a refetch so the
  // approval banner clears. The real next status arrives via the refetch.
  if (row.event_type === 'approval_received') {
    const payload: WorkflowStatusSsePayload = {
      type: 'workflow_status',
      runId,
      workflowName: '',
      status: 'running',
      timestamp,
    };
    return JSON.stringify(payload);
  }

  const nodeStatus = ROW_NODE_STATUS[row.event_type];
  if (nodeStatus) {
    const payload: DagNodeSsePayload = {
      type: 'dag_node',
      runId,
      nodeId: row.step_name ?? '',
      name: row.step_name ?? '',
      status: nodeStatus,
      error:
        row.event_type === 'node_failed' || row.event_type === 'loop_iteration_failed'
          ? dataStr(data, 'error')
          : undefined,
      timestamp,
    };
    return JSON.stringify(payload);
  }

  return null;
}

export class WorkflowEventBridge {
  private unsubscribeWorkflowEvents: (() => void) | null = null;
  private outputCallbacks = new Map<string, (text: string) => void>();
  private onStepTransition: ((workerConversationId: string) => void) | null = null;

  constructor(private transport: SSETransport) {}

  /**
   * Register a callback that fires on step transitions (completed/failed).
   * Used by WebAdapter to flush worker conversation buffers so workflow logs
   * are persisted promptly instead of waiting for the 30s periodic flush.
   */
  setStepTransitionCallback(cb: (workerConversationId: string) => void): void {
    this.onStepTransition = cb;
  }

  /**
   * Subscribe to WorkflowEventEmitter and forward events to SSE streams.
   */
  start(): void {
    const emitter = getWorkflowEventEmitter();
    this.unsubscribeWorkflowEvents = emitter.subscribe((event: WorkflowEmitterEvent) => {
      const conversationId = emitter.getConversationId(event.runId);
      const sseEvent = mapWorkflowEvent(event);
      if (sseEvent) {
        // Emit to per-conversation stream (existing behavior)
        if (conversationId) {
          this.transport.emitWorkflowEvent(conversationId, sseEvent);
        }
        // Fan-out to dashboard stream — no-op when no dashboard client connected
        this.transport.emitWorkflowEvent('__dashboard__', sseEvent);
      }
    });
  }

  stop(): void {
    if (this.unsubscribeWorkflowEvents) {
      this.unsubscribeWorkflowEvents();
      this.unsubscribeWorkflowEvents = null;
    }
    this.outputCallbacks.clear();
  }

  /**
   * Bridge workflow events from a worker conversation to a parent conversation's SSE stream.
   * Forwards compact progress events (step progress, status) and output previews.
   */
  bridgeWorkerEvents(workerConversationId: string, parentConversationId: string): () => void {
    const emitter = getWorkflowEventEmitter();

    const unsubscribe = emitter.subscribeForConversation(
      workerConversationId,
      (event: WorkflowEmitterEvent) => {
        const sseEvent = mapWorkflowEvent(event);
        if (sseEvent) {
          // Send to parent's stream (not worker's)
          this.transport.emitWorkflowEvent(parentConversationId, sseEvent);
        }
        // Flush worker conversation buffer on step transitions so workflow logs
        // are available via REST immediately, not after the 30s periodic flush.
        if (
          this.onStepTransition &&
          (event.type === 'loop_iteration_completed' ||
            event.type === 'loop_iteration_failed' ||
            event.type === 'node_completed' ||
            event.type === 'node_failed')
        ) {
          this.onStepTransition(workerConversationId);
        }
      }
    );

    return unsubscribe;
  }

  registerOutputCallback(conversationId: string, cb: (text: string) => void): void {
    this.outputCallbacks.set(conversationId, cb);
  }

  removeOutputCallback(conversationId: string): void {
    this.outputCallbacks.delete(conversationId);
  }

  emitOutput(conversationId: string, text: string): void {
    const callback = this.outputCallbacks.get(conversationId);
    if (callback) {
      try {
        callback(text);
      } catch (e: unknown) {
        getLog().warn({ conversationId, err: e }, 'output_callback_failed');
      }
    }
  }

  clearConversation(conversationId: string): void {
    this.outputCallbacks.delete(conversationId);
  }
}
