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
  KNOWN_DAG_NODE_KEYS,
} from './dag-node';
import type { NestedKeySpec } from './dag-node';
import { jsonValueSchema } from '../output-ref';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

/**
 * DEPRECATED (#2556). The Codex-only spelling of reasoning depth.
 *
 * This is an ACCEPTED-INPUT alias only: the loader translates
 * `modelReasoningEffort:` into `effort:` and never emits it, so a
 * `WorkflowDefinition` produced by `parseWorkflow` never carries the field.
 * It stays on the schema so `KNOWN_WORKFLOW_KEYS` still recognises it — dropping
 * it would turn an author's deprecated-but-valid line into an "unknown key"
 * warning and silently discard the value instead of honouring it.
 *
 * The last provider-specific effort vocabulary left inside @archon/workflows;
 * it goes away with the field. `effortLevelSchema` in ./dag-node is the live one.
 */
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
// Workflow-level run budget (#1961)
// ---------------------------------------------------------------------------

/**
 * Run-wide consumption ceilings (#1961), independent of `max_parallel` (which
 * bounds burn RATE, not total). Both fields are optional and independent;
 * whichever ceiling is hit first fails the run explicitly — never silently
 * truncates remaining work. Enforcement is pre-dispatch: nodes already running
 * when a ceiling is crossed are allowed to finish, so overshoot is bounded by
 * the work already admitted in the current layer or fan-out window.
 *
 * Child sub-runs (`workflow:`/`fan_out:`) keep separate ledgers. A parent's spend
 * ceiling requires each child to make cost availability explicit, while the
 * child's own declared ceiling remains authoritative for its internal work. The
 * parent adds settled child spend and charges every child spawn as one work unit.
 */
export const workflowBudgetPolicySchema = z
  .object({
    /**
     * Run-wide ceiling on summed recorded provider cost (USD), including rolled-up
     * child cost. A cost-bearing provider that omits finite cost fails explicitly;
     * absence is never treated as zero while this ceiling is active.
     */
    max_spend_usd: z.number().positive().optional(),
    /**
     * Run-wide ceiling on deterministic work units. One required
     * `work_unit_charged` row records each node attempt or governed child spawn,
     * so retries count and the ceiling is reconstructible across cold resume.
     */
    max_work_units: z.number().int().positive().optional(),
  })
  .strict();

export type WorkflowBudgetPolicy = z.infer<typeof workflowBudgetPolicySchema>;

// ---------------------------------------------------------------------------
// Workflow signature — declared inputs (#2470, Signature Phase 2)
// ---------------------------------------------------------------------------

/**
 * Declaration of a single input a workflow accepts. All fields optional:
 *  - `required` — a caller MUST supply this via `with:`; a bare top-level run
 *    of a workflow with an unsatisfied required input fails before any cost.
 *  - `default`  — value used when a caller omits the input (mutually exclusive
 *    with `required: true`; the loader drops any key that declares both).
 *  - `description` — human documentation only, unused by the engine.
 *
 * This is declarative metadata the engine needs to wire and validate `with:`
 * against — it coordinates, it does not compute (Workflow Language Constitution).
 */
export const workflowInputSpecSchema = z.object({
  required: z.boolean().optional(),
  // Any JSON-compatible value (#2637): a boolean/number/array default keeps its
  // logical type through the input contract instead of arriving as text.
  default: jsonValueSchema.optional(),
  description: z.string().optional(),
});

export type WorkflowInputSpec = z.infer<typeof workflowInputSpecSchema>;

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
  /**
   * The workflow's CLASS declaration (#2707 step 2): `true` means this
   * workflow's tree may pause. Every background-dispatch entry point
   * independently refuses to background an `interactive: true` workflow —
   * CLI `--detach`, the `manage_run` native tool, and web's default
   * background dispatch — so a pause always has a foreground driver watching
   * for it. Absent/`false` means the workflow is unattended-class; it is
   * also the class a `fan_out:` target must resolve to.
   *
   * See `validateWorkflowClassPlacement`'s doc comment in `loader.ts` for the
   * precise load-time enforcement scope — it is narrower than "no pause node
   * anywhere": a NATIVE gate/interactive-loop authored directly in this
   * workflow's own DAG without `interactive: true` is inferred as
   * `interactive: true` with a one-time WARN during a grace period (#2736/
   * #2738), not a load error. A gate that arrives via `include:` composition
   * is deliberately NOT covered here (`assertComposedGateDriveable` remains
   * the invocation-time check for that case — the same reusable block can be
   * legitimately composed by different parents, so load time cannot always
   * tell which workflow will own a given run).
   */
  interactive: z.boolean().optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: betasSchema.optional(),
  sandbox: sandboxSettingsSchema.optional(),
  worktree: workflowWorktreePolicySchema.optional(),
  container: workflowContainerPolicySchema.optional(),
  evidence_policy: workflowEvidencePolicySchema.optional(),
  /** Run-wide work/spend ceilings (#1961). Omitted = ungoverned (today's behavior). */
  budget: workflowBudgetPolicySchema.optional(),
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
  /**
   * Declared inputs this workflow accepts (#2470). A caller supplies values via
   * `with:` on the `include:`/`workflow:` node that references this workflow;
   * for sub-runs the values become `$INPUTS.<name>` runtime variables on the
   * child. When a workflow declares `inputs:`, callers are validated against it
   * (missing required / undeclared key = load error); a workflow with no
   * `inputs:` keeps Phase-1 behaviour untouched.
   */
  inputs: z.record(z.string(), workflowInputSpecSchema).optional(),
  /**
   * The node id whose output IS this workflow's result (#2470). Drives
   * `$blk.output` for include blocks (the block's `primarySink`, overriding the
   * positional first-sink default) and the terminal output of a `workflow:`
   * sub-run child. Selecting by id (not text) works for every node type,
   * including a non-sink node.
   */
  returns: z.string().min(1).optional(),
  /**
   * Required boolean property on the declared `returns:` node that records the
   * workflow author's verdict independently from the run lifecycle (#2618).
   * The loader validates the selected node's `output_format` contract; the
   * engine maps exact true/false values to succeeded/failed without inference.
   */
  outcome_field: z.string().trim().min(1).optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

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

/**
 * Workflow definition with fully typed nodes derived from the schema. `nodes`'
 * element type is `DagNode | IncludeDirective` (not `DagNode[]` alone) because
 * `dagNodeSchema` still parses `include:` entries at this pre-expansion stage
 * (#2486) — `expandWorkflowIncludes` consumes every `IncludeDirective` before
 * the executor ever sees a `WorkflowDefinition`.
 */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & { prompt?: never };

// ---------------------------------------------------------------------------
// Known workflow keys — used by the loader to detect unknown/misplaced keys
// ---------------------------------------------------------------------------

/**
 * All keys accepted at the workflow level.
 * Derived from workflowDefinitionSchema shape — no hand-maintained list needed.
 * Used by parseWorkflow to warn on unknown keys (#2213).
 */
export const KNOWN_WORKFLOW_KEYS: ReadonlySet<string> = new Set(
  Object.keys(workflowDefinitionSchema.shape)
);

/**
 * Workflow-only keys that are not valid on individual nodes. Used to produce a
 * precise hint when a workflow-level key is misplaced on a node (#2213).
 * Computed as the difference between workflow keys and node keys.
 */
export const WORKFLOW_ONLY_KEYS: ReadonlySet<string> = new Set(
  [...KNOWN_WORKFLOW_KEYS].filter(k => !KNOWN_DAG_NODE_KEYS.has(k))
);

/**
 * Known keys for the nested config objects a workflow can carry, keyed by the
 * workflow-level field that holds them. Same purpose and same derivation as
 * KNOWN_NODE_NESTED_KEYS — an unknown key one level down is stripped just as
 * silently as one at the top (#2213).
 *
 * `sandbox` (`.passthrough()`) and `thinking` (`z.preprocess`) are omitted for
 * the same reasons they are omitted at node level. `nodes` is handled by the
 * per-node check, not here.
 *
 * Constructed with `keyof typeof workflowDefinitionSchema.shape` as the key type
 * so a typo'd registration fails to compile rather than silently disabling the
 * check; the exported type widens back to `string` for lookup (same split as
 * KNOWN_NODE_NESTED_KEYS).
 */
export const KNOWN_WORKFLOW_NESTED_KEYS: ReadonlyMap<string, NestedKeySpec> = new Map<
  keyof typeof workflowDefinitionSchema.shape,
  NestedKeySpec
>([
  ['worktree', { kind: 'object', keys: new Set(Object.keys(workflowWorktreePolicySchema.shape)) }],
  [
    'container',
    { kind: 'object', keys: new Set(Object.keys(workflowContainerPolicySchema.shape)) },
  ],
  [
    'evidence_policy',
    { kind: 'object', keys: new Set(Object.keys(workflowEvidencePolicySchema.shape)) },
  ],
  ['budget', { kind: 'object', keys: new Set(Object.keys(workflowBudgetPolicySchema.shape)) }],
  // First `record` entry in this map: `inputs` is a record of input-name → spec,
  // so unknown keys under an individual spec (e.g. `inputs.diff.typo`) warn.
  // `returns` and `outcome_field` are plain strings and need no nested registration.
  [
    'inputs',
    {
      kind: 'record',
      entry: { kind: 'object', keys: new Set(Object.keys(workflowInputSpecSchema.shape)) },
    },
  ],
]);

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
  | {
      success: false;
      workflowRunId?: string;
      error: string;
      /** Explicit proof that the DAG admission boundary was never crossed. */
      workStarted?: false;
    }
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

/**
 * The workflow-level configuration an author WROTE, captured before composition
 * collapsed it onto the workflow's own nodes and removed the workflow-level layer
 * (#1764). This is not a second representation of a live value — the collapsed
 * definition no longer holds these fields at all.
 *
 * Read it for display and for labelling a run; never for execution. Execution reads
 * `WorkflowWithSource.workflow`, whose nodes each carry their own resolved values.
 * Deliberately narrow: the fields a person is shown, not the whole travelling set.
 */
export interface DeclaredWorkflowConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: WorkflowDefinition;
  readonly source: WorkflowSource;
  /** Warnings from YAML parsing (e.g. unknown keys) — never hard-fails. */
  readonly parseWarnings?: readonly string[];
  /** What the author declared at workflow level, for display. @see DeclaredWorkflowConfig */
  readonly declared?: DeclaredWorkflowConfig;
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
