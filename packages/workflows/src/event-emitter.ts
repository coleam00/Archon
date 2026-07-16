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
import type { ArtifactType } from './schemas';
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
  conversationId: string;
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
  type: 'node_started';
  runId: string;
  nodeId: string;
  nodeName: string; // command name or node.id for inline prompts
  provider?: string; // resolved AI provider (absent for bash/script nodes)
  model?: string; // resolved model string (absent for bash/script nodes)
  tier?: 'small' | 'medium' | 'large'; // only set when node.model was a tier keyword
}

interface NodeCompletedEvent {
  type: 'node_completed';
  runId: string;
  nodeId: string;
  nodeName: string;
  duration: number;
  costUsd?: number;
  stopReason?: string;
  numTurns?: number;
}

interface NodeFailedEvent {
  type: 'node_failed';
  runId: string;
  nodeId: string;
  nodeName: string;
  error: string;
}

interface NodeSkippedEvent {
  type: 'node_skipped';
  runId: string;
  nodeId: string;
  nodeName: string;
  reason: 'when_condition' | 'when_condition_parse_error' | 'trigger_rule' | 'prior_success';
}

interface ToolStartedEvent {
  type: 'tool_started';
  runId: string;
  toolName: string;
  stepName: string;
}

interface ToolCompletedEvent {
  type: 'tool_completed';
  runId: string;
  toolName: string;
  stepName: string;
  durationMs: number;
}

interface ApprovalPendingEvent {
  type: 'approval_pending';
  runId: string;
  nodeId: string;
  message: string;
}

interface WorkflowCancelledEvent {
  type: 'workflow_cancelled';
  runId: string;
  nodeId: string;
  reason: string;
}

// ─── Subagent Task Lifecycle (aggregated from Claude provider task_* chunks) ──
// Forwarded by the dag-executor whenever a `task_started` / `task_progress` /
// `task_notification` MessageChunk arrives from the provider. The bridge maps
// these to `workflow_task_activity` SSE events for the Web UI. `nodeId` ties
// the task to the parent workflow node (a single node can spawn many subagents).
interface TaskActivityEvent {
  type: 'task_activity';
  runId: string;
  nodeId: string;
  taskId: string;
  activity: 'started' | 'progress' | 'completed' | 'failed' | 'stopped';
  description?: string;
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  lastToolName?: string;
  taskType?: string;
  /** Transcript/output file the settled task points at (task_notification only)
   *  — the artifact trail for delegated work (#2083). */
  outputFile?: string;
  /** True when SDK signaled skip_transcript (housekeeping) — propagated so the
   *  UI / persistence layer can decide whether to surface. The provider
   *  filters these out today, but the field is here for forward-compat. */
  ambient?: boolean;
}

// ─── Hook Lifecycle (aggregated from Claude provider hook_* chunks) ─────
// Same aggregation pattern as TaskActivityEvent. Maps to `workflow_hook_activity`
// SSE events; the Web UI renders them as inline indicators under the parent
// node (e.g. `PreToolUse(Bash) → approved`).
interface HookActivityEvent {
  type: 'hook_activity';
  runId: string;
  nodeId: string;
  hookId: string;
  hookName: string;
  hookEvent: string;
  activity: 'started' | 'response';
  outcome?: 'success' | 'error' | 'cancelled';
  exitCode?: number;
}

/**
 * Container isolation backend lifecycle (folder-project container runs). Phase B
 * emits `created` (at run start) and `destroyed` (at teardown); `stopped`/
 * `resumed` are reserved for Phase C's suspend/resume.
 */
export interface ContainerLifecycleEvent {
  type: 'container_lifecycle';
  runId: string;
  phase: 'creating' | 'created' | 'stopped' | 'resumed' | 'destroyed';
  containerId?: string;
  image?: string;
}

export type WorkflowEmitterEvent =
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | LoopIterationStartedEvent
  | LoopIterationCompletedEvent
  | LoopIterationFailedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | WorkflowArtifactEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalPendingEvent
  | WorkflowCancelledEvent
  | TaskActivityEvent
  | HookActivityEvent
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
