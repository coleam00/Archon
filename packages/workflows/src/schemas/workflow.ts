/**
 * Zod schemas for workflow definition types, plus result types for
 * workflow loading and execution (non-schema hand-written discriminated unions).
 */
import { z } from '@hono/zod-openapi';
import {
  dagNodeSchema,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
  betasSchema,
} from './dag-node';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const webSearchModeSchema = z.enum(['disabled', 'cached', 'live']);

/**
 * External capabilities a workflow declares it needs. Today only `github`
 * (the originating user must have connected their GitHub identity); the array
 * shape leaves room for `gitea`/`gitlab` etc. without a schema change.
 */
export const workflowRequirementSchema = z.enum(['github']);

export type WorkflowRequirement = z.infer<typeof workflowRequirementSchema>;

export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

// ---------------------------------------------------------------------------
// Workflow-level worktree policy
// ---------------------------------------------------------------------------

/**
 * Per-workflow worktree policy. Pins whether a run uses isolation regardless of
 * how it was invoked (CLI flags, web UI, chat). When the field is omitted the
 * caller's default applies — worktree for task/issue/pr, etc.
 *
 * Currently one field (`enabled`). Other worktree-shaped settings (copyFiles,
 * initSubmodules, path, baseBranch) live in repo-level `.archon/config.yaml`
 * because they are repo-wide, not per-workflow. This block is deliberately
 * narrow to avoid re-expressing the repo-level knobs here.
 */
export const workflowWorktreePolicySchema = z.object({
  /**
   * Pin worktree isolation on or off for this workflow.
   * - `true`  — always run inside a worktree; CLI `--no-worktree` hard-errors
   * - `false` — always run in the live checkout; CLI `--branch` / `--from`
   *             hard-error, orchestrator skips isolation resolution
   * - omitted — caller decides (current default = worktree for most types)
   */
  enabled: z.boolean().optional(),
});

export type WorkflowWorktreePolicy = z.infer<typeof workflowWorktreePolicySchema>;

/**
 * Per-workflow container-backend policy (FOLDER projects only). Mirrors the
 * worktree policy: a narrow per-workflow toggle; the runner image / caps live in
 * repo/global `.archon/config.yaml > container` because they are install-wide.
 *
 * Selection precedence: CLI `--container` flag > this `container.enabled` >
 * config `container.enabled` default (false). `container.write_back` chooses how
 * the finished run's overlay diff reaches the live root (gated vs auto).
 */
export const workflowContainerPolicySchema = z.object({
  /**
   * Pin the container backend on for this folder-project workflow without the
   * `--container` flag. Precedence is `--container flag ?? this ?? config ?? false`:
   * `true` enables it (unless already forced by the flag); OMITTED defers to the
   * config default; `false` HARD-disables it relative to config (the config
   * default is not consulted), though an explicit `--container` flag still wins.
   */
  enabled: z.boolean().optional(),
  /**
   * How a finished container run's overlay changes reach the live folder root:
   *  - `approve` (default) — pause at an engine-level write-back gate presenting
   *    the change summary; the run applies to the live root only on approval and
   *    discards on rejection.
   *  - `auto` — apply the overlay diff to the live root without pausing (logged).
   *    For unattended workflows that accept ungated write-back.
   * Only consulted for container runs; a no-op for in-place / worktree runs.
   */
  write_back: z.enum(['approve', 'auto']).optional(),
});

export type WorkflowContainerPolicy = z.infer<typeof workflowContainerPolicySchema>;

// ---------------------------------------------------------------------------
// Workflow-level evidence policy (#2230)
// ---------------------------------------------------------------------------

/**
 * Terminal-success evidence gate. When `required: true`, the DAG executor
 * refuses to flip the run to `completed` unless `$ARTIFACTS_DIR/evidence.json`
 * exists — a missing file marks the run `failed` with a structured note at
 * `metadata.evidence_validation`. The engine gates ONLY on file presence:
 * producing (and validating the content of) the evidence belongs to the
 * workflow's own bash/script nodes (constitution: code computes, YAML
 * coordinates). Deliberately narrow — no schema validation, no content checks,
 * no configurable path (deferred until the gate sees adoption; see #2230).
 */
export const workflowEvidencePolicySchema = z.object({
  /** Refuse terminal `completed` unless `$ARTIFACTS_DIR/evidence.json` exists. */
  required: z.boolean(),
});

export type WorkflowEvidencePolicy = z.infer<typeof workflowEvidencePolicySchema>;

// ---------------------------------------------------------------------------
// WorkflowBase — common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  provider: z.string().trim().min(1).optional(),
  model: z.string().optional(),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  interactive: z.boolean().optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: betasSchema.optional(),
  sandbox: sandboxSettingsSchema.optional(),
  worktree: workflowWorktreePolicySchema.optional(),
  container: workflowContainerPolicySchema.optional(),
  evidence_policy: workflowEvidencePolicySchema.optional(),
  /**
   * When `false`, the engine skips the path-exclusive lock for this workflow,
   * allowing N concurrent runs on the same live checkout. The author asserts
   * that concurrent runs will not race (e.g. all writes are per-run-scoped).
   * Defaults to `true` (safe: serialize runs on the same path).
   */
  mutates_checkout: z.boolean().optional(),
  /**
   * Default for `persist_session` on every AI node in this workflow.
   * Individual nodes can override with `persist_session: false`.
   * Requires the resolved provider to declare `sessionResume: true`.
   */
  persist_sessions: z.boolean().optional(),
  tags: z.array(z.string().min(1)).optional(),
  /**
   * External capabilities this workflow needs. When it includes `github`, the
   * run is hard-blocked at invocation (before any worktree/clone/AI cost) if
   * the originating user has not connected their GitHub identity. Only enforced
   * when per-user GitHub is enabled; a no-op for solo PAT installs.
   */
  requires: z.array(workflowRequirementSchema).optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// Known workflow keys — used by the loader to detect unknown/misplaced keys
// ---------------------------------------------------------------------------

/**
 * All keys accepted at the workflow level (workflowBaseSchema + nodes).
 * Used by parseWorkflow to warn on unknown keys (#2213). Keep in sync with
 * workflowBaseSchema + workflowDefinitionSchema.
 */
export const KNOWN_WORKFLOW_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'provider',
  'model',
  'modelReasoningEffort',
  'webSearchMode',
  'interactive',
  'effort',
  'thinking',
  'fallbackModel',
  'betas',
  'sandbox',
  'worktree',
  'container',
  'evidence_policy',
  'mutates_checkout',
  'persist_sessions',
  'tags',
  'requires',
  'nodes',
]);

/**
 * Workflow-only keys that are not valid on individual nodes. Used to produce a
 * precise hint when a workflow-level key is misplaced on a node (#2213).
 */
export const WORKFLOW_ONLY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'interactive',
  'webSearchMode',
  'modelReasoningEffort',
  'worktree',
  'container',
  'evidence_policy',
  'mutates_checkout',
  'persist_sessions',
  'tags',
  'requires',
  'nodes',
]);

// ---------------------------------------------------------------------------
// WorkflowDefinition — DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML.
 * All workflows use DAG-based execution with `nodes`.
 */
export const workflowDefinitionSchema = workflowBaseSchema.extend({
  nodes: z.array(dagNodeSchema),
});

/** Workflow definition with fully typed nodes (DagNode[]) derived from the schema. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & { prompt?: never };

// ---------------------------------------------------------------------------
// LoadCommandResult — discriminated union for command load outcomes
// ---------------------------------------------------------------------------

/**
 * Result of loading a command prompt - discriminated union for specific error handling
 *
 * On success, `content` is non-empty (enforced at load time in executor-shared.ts, not by the type).
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason: 'invalid_name' | 'empty_file' | 'not_found' | 'permission_denied' | 'read_error';
      message: string;
    };

// ---------------------------------------------------------------------------
// WorkflowExecutionResult — discriminated union for execution outcomes
// ---------------------------------------------------------------------------

/**
 * Result of workflow execution - allows callers to detect success/failure
 */
export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string; summary?: string }
  | { success: false; workflowRunId?: string; error: string }
  | { success: true; paused: true; workflowRunId: string };

// ---------------------------------------------------------------------------
// WorkflowLoadError / WorkflowLoadResult — workflow discovery results
// ---------------------------------------------------------------------------

/**
 * Workflow origin:
 * - `bundled` — embedded in the Archon binary / bundled defaults
 * - `global`  — user-level, discovered at `~/.archon/workflows/` (applies to every repo)
 * - `project` — repo-local, discovered at `<repoRoot>/.archon/workflows/`
 *
 * Precedence for same-named files: `bundled` < `global` < `project`.
 */
export type WorkflowSource = 'bundled' | 'global' | 'project';

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: WorkflowDefinition;
  readonly source: WorkflowSource;
  /** Warnings from YAML parsing (e.g. unknown keys) — never hard-fails. */
  readonly parseWarnings?: readonly string[];
}

/**
 * Error encountered while loading a workflow file
 */
export interface WorkflowLoadError {
  readonly filename: string;
  readonly error: string;
  readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
}

/**
 * Result of workflow discovery - includes both successful loads and errors
 */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowWithSource[];
  readonly errors: readonly WorkflowLoadError[];
}
