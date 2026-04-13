/**
 * IWorkflowStore - trait interface for workflow database operations.
 *
 * Mirrors the IIsolationStore pattern from @archon/isolation.
 * Implementations live in @archon/core (backed by the real DB);
 * the workflow engine depends only on this narrow interface.
 */
import type { WorkflowRun, WorkflowRunStatus, ApprovalContext } from './schemas';

export const WORKFLOW_EVENT_TYPES = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'node_started',
  'node_completed',
  'node_failed',
  'node_skipped',
  'node_skipped_prior_success',
  'loop_iteration_started',
  'loop_iteration_completed',
  'loop_iteration_failed',
  'tool_called',
  'tool_completed',
  'ralph_story_started',
  'ralph_story_completed',
  'approval_requested',
  'approval_received',
  'workflow_cancelled',
  'workflow_artifact',
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export interface IWorkflowStore {
  // Run lifecycle
  createWorkflowRun(data: {
    workflow_name: string;
    conversation_id: string;
    codebase_id?: string;
    user_message: string;
    metadata?: Record<string, unknown>;
    working_path?: string;
    parent_conversation_id?: string;
  }): Promise<WorkflowRun>;
  getWorkflowRun(id: string): Promise<WorkflowRun | null>;
  getActiveWorkflowRunByPath(workingPath: string): Promise<WorkflowRun | null>;
  findResumableRun(workflowName: string, workingPath: string): Promise<WorkflowRun | null>;
  failOrphanedRuns(): Promise<{ count: number }>;
  resumeWorkflowRun(id: string): Promise<WorkflowRun>;
  updateWorkflowRun(
    id: string,
    updates: Partial<Pick<WorkflowRun, 'status' | 'metadata'>>
  ): Promise<void>;
  updateWorkflowActivity(id: string): Promise<void>;
  getWorkflowRunStatus(id: string): Promise<WorkflowRunStatus | null>;
  completeWorkflowRun(id: string, metadata?: Record<string, unknown>): Promise<void>;
  failWorkflowRun(id: string, error: string): Promise<void>;
  pauseWorkflowRun(id: string, approvalContext: ApprovalContext): Promise<void>;
  cancelWorkflowRun(id: string): Promise<void>;

  /**
   * Create a workflow event. Implementations MUST NOT throw — catch all errors
   * internally and log them. Callers treat this as observable-only: workflow
   * execution continues regardless of whether event persistence succeeds.
   */
  createWorkflowEvent(data: {
    workflow_run_id: string;
    event_type: WorkflowEventType;
    step_index?: number;
    step_name?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Return a map of nodeId → output for all node_completed events
   * from a prior DAG workflow run. Used for DAG resume: the executor
   * pre-populates nodeOutputs so completed nodes are skipped on re-run.
   *
   * Returns an empty map when no completed nodes exist.
   * Throws on DB error — caller (executor.ts) owns the degradation policy.
   */
  getCompletedDagNodeOutputs(workflowRunId: string): Promise<Map<string, string>>;

  // Per-codebase env vars for workflow node injection
  getCodebaseEnvVars(codebaseId: string): Promise<Record<string, string>>;

  // Codebase lookup (for path resolution)
  getCodebase(id: string): Promise<{
    id: string;
    name: string;
    repository_url: string | null;
    default_cwd: string;
  } | null>;
}
