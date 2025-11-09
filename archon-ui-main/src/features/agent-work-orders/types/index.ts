/**
 * Agent Work Orders Type Definitions
 *
 * This module defines TypeScript interfaces and types for the Agent Work Orders feature.
 * These types mirror the backend models from python/src/agent_work_orders/models.py
 */

/**
 * Status of an agent work order
 * - pending: Work order created but not started
 * - running: Work order is currently executing
 * - completed: Work order finished successfully
 * - failed: Work order encountered an error
 */
export type AgentWorkOrderStatus = "pending" | "running" | "completed" | "failed";

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

  /** URL of the git repository to work on */
  repository_url: string;

  /** Unique identifier for the sandbox instance */
  sandbox_identifier: string;

  /** Name of the git branch created for this work order (null if not yet created) */
  git_branch_name: string | null;

  /** ID of the agent session executing this work order (null if not started) */
  agent_session_id: string | null;

  /** Type of sandbox being used */
  sandbox_type: SandboxType;

  /** GitHub issue number associated with this work order (optional) */
  github_issue_number: string | null;

  /** Current status of the work order */
  status: AgentWorkOrderStatus;

  /** Current workflow phase/step being executed (null if not started) */
  current_phase: string | null;

  /** Timestamp when work order was created */
  created_at: string;

  /** Timestamp when work order was last updated */
  updated_at: string;

  /** URL of the created pull request (null if not yet created) */
  github_pull_request_url: string | null;

  /** Number of commits made during execution */
  git_commit_count: number;

  /** Number of files changed during execution */
  git_files_changed: number;

  /** Error message if work order failed (null if successful or still running) */
  error_message: string | null;
}

/**
 * Request payload for creating a new agent work order
 */
export interface CreateAgentWorkOrderRequest {
  /** URL of the git repository to work on */
  repository_url: string;

  /** Type of sandbox to use for execution */
  sandbox_type: SandboxType;

  /** User's natural language request describing the work to be done */
  user_request: string;

  /** Optional array of specific commands to execute (defaults to all if not provided) */
  selected_commands?: WorkflowStep[];

  /** Optional GitHub issue number to associate with this work order */
  github_issue_number?: string | null;

  /** Optional configured repository ID for linking work order to repository */
  repository_id?: string;
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

/**
 * Response from GET /logs endpoint
 * Contains historical log entries with pagination
 */
export interface WorkOrderLogsResponse {
  /** Work order ID */
  agent_work_order_id: string;

  /** Array of log entries */
  log_entries: LogEntry[];

  /** Total number of logs available */
  total: number;

  /** Number of logs returned in this response */
  limit: number;

  /** Offset used for pagination */
  offset: number;
}

// Export repository types
export type { ConfiguredRepository, CreateRepositoryRequest, UpdateRepositoryRequest } from "./repository";
