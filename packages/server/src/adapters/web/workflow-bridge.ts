import { createLogger } from '@archon/paths';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
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
