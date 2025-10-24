/**
 * Agent Work Orders Type Definitions
 *
 * This module defines TypeScript interfaces and types for the Agent Work Orders feature.
 * These types mirror the backend models from python/src/agent_work_orders/models.py
 */

/**
 * Status of an agent work order (Kanban column status)
 * - todo: Work order created but not started
 * - in_progress: Work order is currently executing
 * - review: Paused for human-in-loop review
 * - done: Work order finished (completed or failed)
 */
export type AgentWorkOrderStatus = "todo" | "in_progress" | "review" | "done";

/**
 * Available workflow steps for agent work orders
 * Each step represents a command that can be executed
 */
export type WorkflowStep = "create-branch" | "planning" | "execute" | "commit" | "create-pr" | "prp-review";

/**
 * Type of git sandbox for work order execution
 * - git_branch: Uses standard git branches
 * - git_worktree: Uses git worktree for isolation
 */
export type SandboxType = "git_branch" | "git_worktree";

/**
 * Agent Work Order entity
 * Represents a complete AI-driven development workflow
 */
export interface AgentWorkOrder {
  /** Unique identifier for the work order */
  agent_work_order_id: string;

  /** Reference to the repository this work order belongs to */
  repository_id: string;

  /** User's natural language request describing the work */
  user_request: string;

  /** Selected workflow commands/steps */
  selected_commands: WorkflowStep[];

  /** Type of sandbox being used */
  sandbox_type: SandboxType;

  /** GitHub issue number associated with this work order (optional) */
  github_issue_number: string | null;

  /** Current status of the work order (Kanban column) */
  status: AgentWorkOrderStatus;

  /** Current workflow phase/step being executed (null if not started) */
  current_phase: string | null;

  /** Name of the git branch created for this work order (null if not yet created) */
  git_branch_name: string | null;

  /** URL of the created pull request (null if not yet created) */
  github_pull_request_url: string | null;

  /** Error message if work order failed (null if successful or still running) */
  error_message: string | null;

  /** Timestamp when work order was created */
  created_at: string;

  /** Timestamp when work order was last updated */
  updated_at: string;

  /** Timestamp when work order was completed (null if not done) */
  completed_at: string | null;
}

/**
 * Request payload for creating a new agent work order
 */
export interface CreateAgentWorkOrderRequest {
  /** Repository ID this work order belongs to */
  repository_id: string;

  /** User's natural language request describing the work to be done */
  user_request: string;

  /** Type of sandbox to use for execution */
  sandbox_type?: SandboxType;

  /** Optional array of specific commands to execute (defaults to all if not provided) */
  selected_commands?: WorkflowStep[];

  /** Optional GitHub issue number to associate with this work order */
  github_issue_number?: string | null;
}

/**
 * Result of a single step execution within a workflow
 */
export interface StepExecutionResult {
  /** The workflow step that was executed */
  step: WorkflowStep;

  /** Name of the agent that executed this step */
  agent_name: string;

  /** Whether the step completed successfully */
  success: boolean;

  /** Output/result from the step execution (null if no output) */
  output: string | null;

  /** Error message if step failed (null if successful) */
  error_message: string | null;

  /** How long the step took to execute (in seconds) */
  duration_seconds: number;

  /** Agent session ID for this step execution (null if not tracked) */
  session_id: string | null;

  /** Timestamp when step was executed */
  timestamp: string;
}

/**
 * Complete history of all steps executed for a work order
 */
export interface StepHistory {
  /** The work order ID this history belongs to */
  agent_work_order_id: string;

  /** Array of all executed steps in chronological order */
  steps: StepExecutionResult[];
}

/**
 * Log entry from SSE stream
 * Structured log event from work order execution
 */
export interface LogEntry {
  /** Work order ID this log belongs to */
  work_order_id: string;

  /** Log level (info, warning, error, debug) */
  level: "info" | "warning" | "error" | "debug";

  /** Event name describing what happened */
  event: string;

  /** ISO timestamp when log was created */
  timestamp: string;

  /** Optional step name if log is associated with a step */
  step?: WorkflowStep;

  /** Optional step number (e.g., 2 for "2/5") */
  step_number?: number;

  /** Optional total steps (e.g., 5 for "2/5") */
  total_steps?: number;

  /** Optional progress string (e.g., "2/5") */
  progress?: string;

  /** Optional progress percentage (e.g., 40) */
  progress_pct?: number;

  /** Optional elapsed seconds */
  elapsed_seconds?: number;

  /** Optional error message */
  error?: string;

  /** Optional output/result */
  output?: string;

  /** Optional duration */
  duration_seconds?: number;

  /** Any additional structured fields from backend */
  [key: string]: unknown;
}

/**
 * Connection state for SSE stream
 */
export type SSEConnectionState = "connecting" | "connected" | "disconnected" | "error";
