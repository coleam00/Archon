import type { ApprovalContext } from './schemas/workflow-run';
import type { NodeExecutionMetadata } from './schemas/node-execution';
/**
 * WorkflowEventEmitter - typed event emitter for workflow execution observability.
 *
 * Lives in @archon/workflows so the executor can emit events.
 * The Web adapter in @archon/server subscribes to forward events to SSE streams.
 *
 * Design:
 * - Singleton pattern via getWorkflowEventEmitter()
 * - Fire-and-forget: listener errors never propagate to the executor
 * - Conversation-scoped subscriptions via registerRun() mapping
 */
import { EventEmitter } from 'events';
import type { ArtifactType, EffortLevel, NodeSkipReason, SkipCause } from './schemas';
import type { ProviderEventEnvelope } from './schemas/provider-event';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.emitter');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface WorkflowStartedEvent {
  type: 'workflow_started';
  runId: string;
  workflowName: string;
  conversationId: string | null;
  transcriptPath: string;
}

interface WorkflowCompletedEvent {
  type: 'workflow_completed';
  runId: string;
  workflowName: string;
  duration: number;
}

interface WorkflowFailedEvent {
  type: 'workflow_failed';
  runId: string;
  workflowName: string;
  error: string;
}

interface LoopIterationStartedEvent {
  type: 'loop_iteration_started';
  runId: string;
  nodeId?: string; // present when loop runs as a DAG node
  iteration: number;
  maxIterations: number;
}

interface LoopIterationCompletedEvent {
  type: 'loop_iteration_completed';
  runId: string;
  nodeId?: string; // present when loop runs as a DAG node
  iteration: number;
  duration: number;
  completionDetected: boolean;
}

interface LoopIterationFailedEvent {
  type: 'loop_iteration_failed';
  runId: string;
  nodeId?: string; // present when loop runs as a DAG node
  iteration: number;
  error: string;
}

interface WorkflowArtifactEvent {
  type: 'workflow_artifact';
  runId: string;
  artifactType: ArtifactType;
  label: string;
  url?: string;
  path?: string;
}

interface NodeStartedEvent {
  execution?: NodeExecutionMetadata;
  type: 'node_started';
  runId: string;
  nodeId: string;
  nodeName: string; // command name or node.id for inline prompts
  provider?: string; // resolved AI provider (absent for bash/script nodes)
  model?: string; // resolved model string (absent for bash/script nodes)
  tier?: 'small' | 'medium' | 'large'; // only set when node.model was a tier keyword
  effort?: EffortLevel; // resolved AI effort (absent when unset or unsupported)
}

interface NodeSuspendedEvent {
  type: 'node_suspended';
  runId: string;
  nodeId: string;
  nodeName: string;
  execution: NodeExecutionMetadata;
}

interface NodeCompletedEvent {
  execution?: NodeExecutionMetadata;
  type: 'node_completed';
  runId: string;
  nodeId: string;
  nodeName: string;
  duration?: number;
  costUsd?: number;
  stopReason?: string;
  numTurns?: number;
}

interface NodeFailedEvent {
  execution?: NodeExecutionMetadata;
  type: 'node_failed';
  runId: string;
  nodeId: string;
  nodeName: string;
  error: string;
}

interface NodeSkippedEvent {
  execution?: NodeExecutionMetadata;
  type: 'node_skipped';
  runId: string;
  nodeId: string;
  nodeName: string;
  reason: Exclude<NodeSkipReason, 'prior_success'>;
  cause: SkipCause;
}

/**
 * A resumed pass declined to re-run a node an earlier pass completed. Mirrors the
 * persisted `node_skipped_prior_success` event_type so a consumer switching on
 * `type` cannot fold prior success into a genuine skip.
 */
interface NodeSkippedPriorSuccessEvent {
  type: 'node_skipped_prior_success';
  runId: string;
  nodeId: string;
  nodeName: string;
}

/**
 * One provider event, in the envelope the store and the JSONL log record (see
 * `schemas/provider-event.ts`). `stepName` is the persisted step name, so a live frame
 * and a served record name the node the same way.
 */
export type ProviderEventEmitterEvent = {
  type: 'provider_event';
  runId: string;
  stepName: string;
} & ProviderEventEnvelope;

interface ApprovalPendingEvent {
  type: 'approval_pending';
  runId: string;
  nodeId: string;
  message: string;
  decisions?: ApprovalContext['decisions'];
  pauseId?: ApprovalContext['pauseId'];
}

interface WorkflowCancelledEvent {
  type: 'workflow_cancelled';
  runId: string;
  nodeId: string;
  reason: string;
}

/**
 * Container isolation backend lifecycle (folder-project container runs).
 * `created`/`destroyed` bracket the run; `stopped`/`resumed` bracket a suspend
 * across a pause; the `writeback_*` phases track the engine-level write-back gate
 * (requested → applied / discarded) (Phase C).
 */
export interface ContainerLifecycleEvent {
  type: 'container_lifecycle';
  runId: string;
  phase:
    | 'created'
    | 'stopped'
    | 'resumed'
    | 'destroyed'
    | 'writeback_requested'
    | 'writeback_applied'
    | 'writeback_discarded';
  containerId?: string;
}

export type WorkflowEmitterEvent =
  | { type: 'run_attention_changed'; runId: string; streamId: string; hasAttention: boolean }
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | LoopIterationStartedEvent
  | LoopIterationCompletedEvent
  | LoopIterationFailedEvent
  | NodeSuspendedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | NodeSkippedPriorSuccessEvent
  | WorkflowArtifactEvent
  | ProviderEventEmitterEvent
  | ApprovalPendingEvent
  | WorkflowCancelledEvent
  | ContainerLifecycleEvent;

// ---------------------------------------------------------------------------
// Emitter class
// ---------------------------------------------------------------------------

type Listener = (event: WorkflowEmitterEvent) => void;

const WORKFLOW_EVENT = 'workflow_event';

class WorkflowEventEmitter {
  private emitter = new EventEmitter();
  private conversationMap = new Map<string, string>(); // runId -> conversationId

  constructor() {
    // Allow many subscribers (adapters, DB persistence, tests, etc.)
    this.emitter.setMaxListeners(50);
  }

  /**
   * Register a run-to-conversation mapping so subscribers can filter by conversation.
   */
  registerRun(runId: string, conversationId: string): void {
    this.conversationMap.set(runId, conversationId);
  }

  /**
   * Remove the run-to-conversation mapping (called at workflow end).
   */
  unregisterRun(runId: string): void {
    this.conversationMap.delete(runId);
  }

  /**
   * Get the conversation ID for a given run.
   */
  getConversationId(runId: string): string | undefined {
    return this.conversationMap.get(runId);
  }

  /**
   * Emit a workflow event. Fire-and-forget: listener errors are caught and logged.
   */
  emit(event: WorkflowEmitterEvent): void {
    try {
      this.emitter.emit(WORKFLOW_EVENT, event);
    } catch (error) {
      getLog().error({ err: error as Error, eventType: event.type }, 'event_emit_failed');
    }
  }

  /**
   * Subscribe to all workflow events. Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    // Wrap listener to catch errors - listener failures must not propagate
    const safeListener = (event: WorkflowEmitterEvent): void => {
      try {
        listener(event);
      } catch (error) {
        getLog().error({ err: error as Error, eventType: event.type }, 'event_listener_error');
      }
    };

    this.emitter.on(WORKFLOW_EVENT, safeListener);
    return (): void => {
      this.emitter.removeListener(WORKFLOW_EVENT, safeListener);
    };
  }

  /**
   * Subscribe to events for a specific conversation only. Returns unsubscribe function.
   */
  subscribeForConversation(conversationId: string, listener: Listener): () => void {
    return this.subscribe((event: WorkflowEmitterEvent) => {
      const eventConversationId = this.conversationMap.get(event.runId);
      if (eventConversationId === conversationId) {
        listener(event);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: WorkflowEventEmitter | null = null;

export function getWorkflowEventEmitter(): WorkflowEventEmitter {
  if (!instance) {
    instance = new WorkflowEventEmitter();
  }
  return instance;
}

/**
 * Reset singleton for testing.
 */
export function resetWorkflowEventEmitter(): void {
  instance = null;
}
