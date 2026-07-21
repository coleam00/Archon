/**
 * Zod schemas for workflow run state types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// WorkflowRunStatus
// ---------------------------------------------------------------------------

export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

/** Statuses that indicate a run has finished and cannot transition further. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

/** Statuses that allow a user to resume execution. */
export const RESUMABLE_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'failed',
  'paused',
] as const;

// ---------------------------------------------------------------------------
// WorkflowStepStatus
// ---------------------------------------------------------------------------

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

// ---------------------------------------------------------------------------
// NodeState
// ---------------------------------------------------------------------------

export const nodeStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export type NodeState = z.infer<typeof nodeStateSchema>;

// ---------------------------------------------------------------------------
// NodeOutput
// ---------------------------------------------------------------------------

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for failed/skipped nodes.
 * `error` is required when state is 'failed', absent on all other states.
 * `structuredOutput` carries the provider's parsed structured payload (set by Pi/Codex/Claude
 * when the result chunk includes one). Downstream `$nodeId.output.field` substitution and
 * `when:` conditions prefer this object over re-parsing `output`, so providers that emit
 * fence-wrapped or preamble-prefixed JSON (Pi/Minimax) survive the round-trip.
 * `declaredFields` is the property-name set of a producer's `output_format` schema
 * (`Object.keys(output_format.properties)`), captured when the node completes. The
 * consumer uses it to tell a declared-but-optional-absent field (resolves to `''`) from a
 * field not in the contract at all (a typo → throws). Undefined for non-schema producers
 * (bash/script/prose) and schemas without a `properties` map.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    declaredFields: z.array(z.string()).optional(),
    /** Session-resume outcome from the provider: false ⇒ a requested resume came
     *  back cold (fresh session). Drives the executor's cold-resume warning.
     *  Absent on 'failed' nodes — the retry path, not this signal, handles those. */
    resumed: z.boolean().optional(),
  }),
  z.object({
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
    structuredOutput: z.unknown().optional(),
    declaredFields: z.array(z.string()).optional(),
  }),
  z.object({
    state: z.enum(['pending', 'skipped']),
    output: z.string(),
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

/**
 * Runtime workflow run state stored in database.
 */
export const workflowRunSchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string(),
  parent_conversation_id: z.string().nullable(),
  codebase_id: z.string().nullable(),
  status: workflowRunStatusSchema,
  user_message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
  working_path: z.string().nullable(),
  user_id: z.string().nullable(),
  /**
   * Run-tree parent (#2121 Phase 2). Set when this run is a `workflow:` sub-run
   * spawned as one node of a parent run; null for top-level runs. Self-referential
   * FK with ON DELETE SET NULL (a deleted parent orphans, never cascades). Paired
   * with `metadata.parent_node_id` so the parent can re-find WHICH node's child on
   * resume.
   */
  parent_run_id: z.string().nullable(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** Approval context stored in workflow run metadata when paused for human review. */
export interface ApprovalContext {
  nodeId: string;
  message: string;
  /**
   * Distinguishes the pause kind:
   *  - `approval`         — a DAG approval node awaiting a human decision.
   *  - `interactive_loop` — an interactive loop gate.
   *  - `writeback`        — the ENGINE-level container write-back gate (Phase C):
   *    no DAG node behind it (`nodeId` is the synthetic `__writeback__`), the
   *    overlay diff of a finished container run awaiting approve→apply / reject→
   *    discard. Reuses the approve/reject CAS machinery; the executor's resume
   *    path branches on the persisted `pending_writeback` marker, not this node.
   *  - `child_workflow`   — a `workflow:` sub-run node (#2121 Phase 2) whose CHILD
   *    run paused at its own gate. The parent pauses "blocked on child"; `nodeId`
   *    is the parent's workflow node, `childRunId` the paused child. The reviewer
   *    approves the CHILD by run id; when the child terminates, the parent_run_id
   *    auto-resume hook re-enters the parent (executor.ts), which re-runs the
   *    workflow node, finds the child terminal, and threads its output. NO
   *    node_completed is written for the parent's node on this pause.
   */
  type?: 'approval' | 'interactive_loop' | 'writeback' | 'child_workflow';
  /**
   * Child run id when `type === 'child_workflow'` — the specific paused sub-run
   * the parent is blocked on. Read by the parent auto-resume guard so a DIFFERENT
   * child of the same parent can't trigger the wrong re-entry.
   */
  childRunId?: string;
  /** Current loop iteration when paused (interactive loops only). */
  iteration?: number;
  /**
   * Session ID to restore on resume (interactive loops only). Gate pauses write an
   * EXPLICIT null (never omit the key) when there is no session to restore — same
   * json_patch rationale as `resolved` below: on SQLite an omitted key would let a
   * stale session id from a previous pause of the same run survive the deep-merge.
   */
  sessionId?: string | null;
  /**
   * Provider that created `sessionId` (#1992). Persisted by loop_group gates and
   * restored together with the session id so a resumed loop never threads the
   * session into a node that resolves to a different provider (cross-provider
   * resume is impossible). Same explicit-null-on-pause convention as `sessionId`.
   * Absent on single-node loop gates — those restore the session into the same
   * node, so the provider is the same by construction.
   */
  sessionProvider?: string | null;
  /** When true, the user's approval comment is stored as `$nodeId.output`. */
  captureResponse?: boolean;
  /** The on_reject prompt template (stored at pause time so reject handlers don't need the workflow def). */
  onRejectPrompt?: string;
  /** Max rejection attempts before cancellation (default 3). */
  onRejectMaxAttempts?: number;
  /**
   * Gate resolution marker. Set by approve/reject handlers while the run STAYS
   * 'paused' awaiting auto-resume (#2075): 'approved' = approval recorded,
   * 'rejected' = rejection recorded with an on_reject rework staged.
   * null/undefined = gate unresolved (awaiting the human).
   *
   * Lifecycle: pauseWorkflowRun writes `resolved: null` on every fresh pause —
   * an EXPLICIT null rather than key omission because SQLite's json_patch
   * deep-merges the fresh context into the stored one (an omitted key would let
   * a stale 'approved' from the previous gate survive and falsely block the
   * next gate), while RFC 7396 null removes the key; Postgres `||` replaces the
   * approval object wholesale. Never cleared on resume — matches the
   * never-clear convention for approval_response/rejection_reason/
   * loop_user_input (consumed in place; the next pause resets it).
   */
  resolved?: 'approved' | 'rejected' | null;
  /**
   * Interactive-loop only. True when the iteration this gate paused on emitted the
   * completion signal (detectCompletionSignal / until_bash exit 0). Read at resume by
   * executeLoopNode/executeLoopGroupNode: a signal-bearing gate approved WITHOUT feedback
   * finalizes the node from `signaledOutput` instead of re-running. Reset to null on every
   * fresh pause (see pauseWorkflowRun) for the same SQLite json_patch reason as `resolved`.
   */
  completionSignaled?: boolean | null;
  /**
   * Interactive-loop only. The (stripped) output of the signal-bearing paused iteration,
   * persisted so the finalize path can write node_completed with the real output for
   * downstream `$nodeId.output` refs. Only set when completionSignaled is true; null otherwise.
   */
  signaledOutput?: string | null;
  /**
   * Interactive-loop only. Read-once snapshot of a command-backed loop's
   * (`loop.command`) loaded prompt body, persisted at gate pause so the resumed
   * invocation reuses the exact text the run started with — a command file
   * edited or deleted while the run sat paused cannot change or break the
   * running loop's prompt. Null for prompt-based loops (explicit-null pause
   * convention, same as `sessionId`). Absent on runs paused by builds that
   * predate this field — the resume path then falls back to re-reading the file.
   */
  commandSnapshot?: string | null;
}

/**
 * Top-level (non-`approval`) run-metadata keys of the interactive-loop gate
 * protocol, written by approveWorkflow and read at resume by
 * executeLoopNode/executeLoopGroupNode (#2074). Deliberately NOT a Zod schema —
 * run metadata stays schemaless JSON; this alias exists solely so the write and
 * read sites share one key spelling (a typo is a compile error), nothing broader.
 */
export interface LoopGateRunMetadata {
  /** $LOOP_USER_INPUT for the resumed iteration (approve comment; defaults to 'Approved'). */
  loop_user_input?: string;
  /**
   * True iff the approve carried real (non-whitespace) feedback. False/absent =
   * bare approve — finalize-eligible when the gate's completionSignaled is true.
   */
  loop_feedback_given?: boolean;
}

/**
 * True when the run's current approval gate has already been resolved
 * (approved, or rejected with a staged on_reject rework) and the run is
 * paused only while awaiting resume. Guards double-approve/reject and the
 * natural-language approval routing.
 */
export function isGateResolved(approval: ApprovalContext): boolean {
  return approval.resolved === 'approved' || approval.resolved === 'rejected';
}

/**
 * Type guard for ApprovalContext.
 * Validates that the value is an object with the required nodeId and message fields.
 * Use before accessing `workflowRun.metadata.approval` to prevent runtime throws on
 * malformed metadata (e.g., stale data from older runs where metadata shape differs).
 */
export function isApprovalContext(val: unknown): val is ApprovalContext {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>).nodeId === 'string' &&
    typeof (val as Record<string, unknown>).message === 'string'
  );
}

/**
 * True when `run` is currently paused blocked on the child sub-run `childRunId`
 * (#2121 Phase 2) — i.e. a `paused` run whose `metadata.approval` is a
 * `child_workflow` gate pointing at that child. This is the single source of the
 * "parent blocked on this child" invariant, shared by the abandon-strand detector
 * (`findParentBlockedOn`, @archon/core) and the auto-resume hook
 * (`maybeResumeParentRun`, @archon/workflows) so the two cannot drift if the gate
 * shape changes. Reads defensively from possibly-malformed metadata.
 */
export function isRunBlockedOnChild(
  run: { status: WorkflowRunStatus; metadata?: Record<string, unknown> },
  childRunId: string
): boolean {
  if (run.status !== 'paused') return false;
  const approval = run.metadata?.approval;
  return (
    isApprovalContext(approval) &&
    approval.type === 'child_workflow' &&
    approval.childRunId === childRunId
  );
}

// ---------------------------------------------------------------------------
// ArtifactType
// ---------------------------------------------------------------------------

export const artifactTypeSchema = z.enum([
  'pr',
  'commit',
  'file_created',
  'file_modified',
  'branch',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// ---------------------------------------------------------------------------
// Compile-time assertion: NodeOutput must cover all NodeState values.
// If NodeState gains a new value, this line becomes a type error as a reminder
// to update NodeOutput.
// ---------------------------------------------------------------------------

type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning
