/**
 * Frontend-specific types for the Archon Web UI.
 * SSE event types match what the Web adapter emits.
 */

import type { components } from '@/lib/api.generated';

export type WorkflowRunStatus = components['schemas']['WorkflowRunStatus'];
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ArtifactType = 'pr' | 'commit' | 'file_created' | 'file_modified' | 'branch';

// Base SSE event
interface BaseSSEEvent {
  type: string;
  timestamp: number;
}

// Text streaming
export interface TextEvent extends BaseSSEEvent {
  type: 'text';
  content: string;
  isComplete: boolean;
}

// Tool call started
export interface ToolCallEvent extends BaseSSEEvent {
  type: 'tool_call';
  toolCallId?: string;
  name: string;
  input: Record<string, unknown>;
}

// Tool call completed
export interface ToolResultEvent extends BaseSSEEvent {
  type: 'tool_result';
  toolCallId?: string;
  name: string;
  output: string;
  duration: number;
}

// Session metadata
export interface SessionInfoEvent extends BaseSSEEvent {
  type: 'session_info';
  sessionId: string;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
}

// Conversation lock status
export interface ConversationLockEvent extends BaseSSEEvent {
  type: 'conversation_lock';
  conversationId: string;
  locked: boolean;
  queuePosition?: number;
}

// Error with classification
export interface ErrorEvent extends BaseSSEEvent {
  type: 'error';
  message: string;
  classification?: 'transient' | 'fatal';
  suggestedActions?: string[];
}

// Warning (non-fatal, informational)
export interface WarningEvent extends BaseSSEEvent {
  type: 'warning';
  message: string;
}

// Keep-alive
export interface HeartbeatEvent extends BaseSSEEvent {
  type: 'heartbeat';
}

/** SSE events only carry active run statuses — 'pending' is excluded because
 *  the server never emits a status event for a run that hasn't started yet. */
export type ActiveWorkflowRunStatus = Exclude<WorkflowRunStatus, 'pending'>;

// Workflow run status
export interface WorkflowStatusEvent extends BaseSSEEvent {
  type: 'workflow_status';
  runId: string;
  workflowName: string;
  status: ActiveWorkflowRunStatus;
  error?: string;
  approval?: { nodeId: string; message: string };
}

// Loop iteration info (per-iteration state stored in DagNodeState)
export interface LoopIterationInfo {
  iteration: number;
  status: 'running' | 'completed' | 'failed';
  duration?: number;
}

// Loop iteration SSE event (emitted as 'workflow_step' by the bridge)
export interface LoopIterationEvent extends BaseSSEEvent {
  type: 'workflow_step';
  runId: string;
  nodeId?: string;
  step: number;
  total: number;
  name: string;
  status: 'running' | 'completed' | 'failed';
  iteration: number;
  duration?: number;
}

// DAG node status (emitted during DAG workflow execution)
export interface DagNodeEvent extends BaseSSEEvent {
  type: 'dag_node';
  runId: string;
  nodeId: string;
  name: string;
  status: WorkflowStepStatus;
  duration?: number;
  error?: string;
  reason?: 'when_condition' | 'trigger_rule';
}

// Workflow tool activity (tool_started / tool_completed from executor)
export interface WorkflowToolActivityEvent extends BaseSSEEvent {
  type: 'workflow_tool_activity';
  runId: string;
  toolName: string;
  stepName: string;
  status: 'started' | 'completed';
  durationMs?: number;
}

// Workflow artifact
export interface WorkflowArtifactEvent extends BaseSSEEvent {
  type: 'workflow_artifact';
  runId: string;
  artifactType: ArtifactType;
  label: string;
  url?: string;
  path?: string;
}

// Background workflow dispatch
export interface WorkflowDispatchEvent extends BaseSSEEvent {
  type: 'workflow_dispatch';
  workerConversationId: string;
  workflowName: string;
}

// Background workflow output preview
export interface WorkflowOutputPreviewEvent extends BaseSSEEvent {
  type: 'workflow_output_preview';
  runId: string;
  lines: string[];
}

// Retract previously streamed text (workflow routing detected)
export interface RetractEvent extends BaseSSEEvent {
  type: 'retract';
}

// System status (e.g., workspace sync result)
export interface SystemStatusEvent extends BaseSSEEvent {
  type: 'system_status';
  content: string;
}

/**
 * Discriminated union of all SSE event types emitted by the Web adapter.
 * Parsed from JSON with no runtime validation — the server is trusted.
 */
export type SSEEvent =
  | TextEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionInfoEvent
  | ConversationLockEvent
  | ErrorEvent
  | WarningEvent
  | HeartbeatEvent
  | WorkflowStatusEvent
  | DagNodeEvent
  | LoopIterationEvent
  | WorkflowToolActivityEvent
  | WorkflowArtifactEvent
  | WorkflowDispatchEvent
  | WorkflowOutputPreviewEvent
  | RetractEvent
  | SystemStatusEvent;

// UI State types

/**
 * UI state for a single chat message. Mixes display state (isStreaming, isExpanded)
 * with persisted data (content, toolCalls). When loading from the API, display
 * fields default to their inactive states.
 */
export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCallDisplay[];
  error?: ErrorDisplay;
  timestamp: number;
  isStreaming?: boolean;
  files?: FileAttachment[];
  workflowDispatch?: {
    workerConversationId: string;
    workflowName: string;
  };
  workflowResult?: {
    workflowName: string;
    runId: string;
  };
}

export interface ToolCallDisplay {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  duration?: number;
  startedAt: number;
  isExpanded: boolean;
}

export interface ErrorDisplay {
  message: string;
  classification: 'transient' | 'fatal';
  suggestedActions: string[];
}

// Workflow UI State types

export interface DagNodeState {
  nodeId: string;
  name: string;
  status: WorkflowStepStatus;
  duration?: number;
  error?: string;
  reason?: 'when_condition' | 'trigger_rule';
  currentIteration?: number;
  maxIterations?: number;
  iterations?: LoopIterationInfo[];
}

export interface WorkflowArtifact {
  type: ArtifactType;
  label: string;
  url?: string;
  path?: string;
}

export interface WorkflowState {
  runId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  dagNodes: DagNodeState[];
  artifacts: WorkflowArtifact[];
  currentIteration?: number;
  maxIterations?: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
  stale?: boolean;
  approval?: { nodeId: string; message: string };
  currentTool?: {
    name: string;
    status: 'running' | 'completed';
    durationMs?: number;
  } | null;
}
