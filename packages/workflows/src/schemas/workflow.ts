/**
 * Zod schemas for workflow definition types, plus result types for
 * workflow loading and execution (non-schema hand-written discriminated unions).
 */
import { z } from 'zod';
import { WORKFLOW_SOURCES } from '@archon/paths/workflow-source';
import type { deadlineWaitCursor } from '../store';
import type { WorkflowRunStatus } from './workflow-run';
import {
  dagNodeSchema,
  effortLevelSchema,
  sandboxSettingsSchema,
  betasSchema,
  KNOWN_DAG_NODE_KEYS,
} from './dag-node';
import type { DagNode, NestedKeySpec } from './dag-node';
import { jsonValueSchema } from '../output-ref';
import { rejectRetiredThinking, type EffortLevel } from './effort';
import { modelRefSchema, type WorkflowModelRef } from './model-binding';

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
 * It derives from the shared ladder while the deprecated field remains accepted.
 */
export const modelReasoningEffortSchema = effortLevelSchema;

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

// ---------------------------------------------------------------------------
// Workflow-level evidence policy (#2230)
// ---------------------------------------------------------------------------

/**
 * Terminal file-presence gate. When `required: true`, the DAG executor
 * refuses to flip the run to `completed` unless `$ARTIFACTS_DIR/evidence.json`
 * exists — a missing file marks the run `failed` with a structured note at
 * `metadata.evidence_validation`. The engine gates only on file presence; any
 * contents satisfy it, and their presence does not prove that a check ran or
 * author a workflow outcome. Deterministic checks remain ordinary bash/script
 * nodes. Deliberately narrow — no schema validation, no content checks, and no
 * configurable path (see #2230).
 */
export const workflowEvidencePolicySchema = z.object({
  /** Refuse terminal `completed` unless the conventional marker file exists. */
  required: z.boolean(),
});

export type WorkflowEvidencePolicy = z.infer<typeof workflowEvidencePolicySchema>;

// ---------------------------------------------------------------------------
// Workflow-level run budget (#2814)
// ---------------------------------------------------------------------------

/**
 * Ceilings on a run's total consumption. One work unit is one started attempt
 * of an AI or deterministic (bash/script) node, retries included; spend is the
 * provider-reported cost of AI attempts. The engine refuses to start a new
 * attempt once a ceiling is reached, and fails a spend-limited run whose spend
 * it cannot measure. Attempts already admitted may finish, so spend can
 * overshoot by the attempts in flight.
 *
 * Strict: a misspelt ceiling is a load error, never a silently absent one.
 */
export const workflowRunBudgetSchema = z
  .object({
    max_work_units: z.number().int().positive().optional(),
    max_spend_usd: z.number().positive().optional(),
  })
  .strict()
  .refine(b => b.max_work_units !== undefined || b.max_spend_usd !== undefined, {
    message: 'budget must declare max_work_units, max_spend_usd, or both',
  });

export type WorkflowRunBudget = z.infer<typeof workflowRunBudgetSchema>;

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

/**
 * Deprecation marker (#2781). A bundle declares this on a workflow that is being
 * replaced and kept only for a deprecation window; every run-start surface then
 * composes its standard notice around `message`.
 *
 * Declare-and-done: a future deprecation of any bundled workflow (or a replaced
 * pack revision) needs no engine change — set the field, get the notice. Pure
 * declarative coordination, so it stays admissible under the Workflow Language
 * Constitution (code computes, YAML coordinates).
 */
export const workflowDeprecationSchema = z.object({
  /** Per-item sentence carried inside the standard run-start deprecation notice. */
  message: z.string().min(1),
});

export type WorkflowDeprecation = z.infer<typeof workflowDeprecationSchema>;

// ---------------------------------------------------------------------------
// WorkflowBase — common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  provider: z.string().trim().min(1).optional(),
  model: modelRefSchema.optional(),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  effort: effortLevelSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: betasSchema.optional(),
  sandbox: sandboxSettingsSchema.optional(),
  worktree: workflowWorktreePolicySchema.optional(),
  container: workflowContainerPolicySchema.optional(),
  evidence_policy: workflowEvidencePolicySchema.optional(),
  /**
   * Run-wide ceiling on total work and spend (#2814). Bounds total consumption,
   * not concurrency (that is `fan_out.max_parallel`), and applies alongside a
   * node's own `maxBudgetUsd`. Loops, `workflow:` children and fan-out are
   * rejected at load time while a budget is declared.
   */
  budget: workflowRunBudgetSchema.optional(),
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
   * Requires the resolved provider to declare `sessionResume: true`; only a
   * provider that also declares `sessionFork: true` continues the session.
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
  /**
   * Marks the workflow deprecated (#2781): run-start surfaces announce removal
   * in an upcoming release with a switch/copy escape hatch, while it keeps
   * running normally. Metadata-only — never blocks or alters execution.
   * Bundled defaults carry it during a deprecation window.
   */
  deprecated: workflowDeprecationSchema.optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// WorkflowDefinition — DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML.
 * All workflows use DAG-based execution with `nodes`.
 */
const workflowDefinitionObjectSchema = workflowBaseSchema.extend({
  nodes: z.array(dagNodeSchema),
});
export const workflowDefinitionSchema = z.preprocess(
  rejectRetiredThinking,
  workflowDefinitionObjectSchema
);

/** Authored workflow definition parsed from YAML, before include expansion. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & { prompt?: never };

/** Static execution plan attached after include expansion and graph validation. */
export interface GraphPlan {
  readonly nodes: readonly DagNode[];
  readonly layers: readonly (readonly DagNode[])[];
  readonly sinks: readonly string[];
}

/** Nominal identity retained only by values produced through `resolveWorkflow`. */
declare class ResolvedWorkflowIdentity {
  private readonly identity: never;
}

/** Include-free workflow accepted by execution and simulation boundaries. */
export type ResolvedWorkflow = Omit<WorkflowDefinition, 'nodes'> &
  ResolvedWorkflowIdentity & {
    readonly nodes: readonly DagNode[];
    readonly plan: GraphPlan;
  };

// ---------------------------------------------------------------------------
// Known workflow keys — used by the loader to detect unknown/misplaced keys
// ---------------------------------------------------------------------------

/**
 * All keys accepted at the workflow level.
 * Derived from workflowDefinitionSchema shape — no hand-maintained list needed.
 * Used by parseWorkflow to warn on unknown keys (#2213).
 */
export const KNOWN_WORKFLOW_KEYS: ReadonlySet<string> = new Set(
  Object.keys(workflowDefinitionObjectSchema.shape)
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
 * `sandbox` (`.passthrough()`) is omitted because it preserves unknown fields.
 * `nodes` is handled by the per-node check, not here.
 *
 * Constructed with `keyof typeof workflowDefinitionObjectSchema.shape` as the key type
 * so a typo'd registration fails to compile rather than silently disabling the
 * check; the exported type widens back to `string` for lookup (same split as
 * KNOWN_NODE_NESTED_KEYS).
 */
export const KNOWN_WORKFLOW_NESTED_KEYS: ReadonlyMap<string, NestedKeySpec> = new Map<
  keyof typeof workflowDefinitionObjectSchema.shape,
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
  ['deprecated', { kind: 'object', keys: new Set(Object.keys(workflowDeprecationSchema.shape)) }],
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
 * On success, `content` is non-empty (enforced at load time in load-command-prompt.ts, not by the type).
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason: 'invalid_name' | 'empty_file' | 'not_found' | 'permission_denied' | 'read_error';
      message: string;
      cause?: unknown;
    };

// ---------------------------------------------------------------------------
// WorkflowExecutionResult — discriminated union for execution outcomes
// ---------------------------------------------------------------------------

/**
 * A handoff reports the observed run state without granting this caller authority to
 * finalize it or clean up its container. A successful handoff is not workflow completion.
 */
export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string; summary?: string }
  | { success: false; workflowRunId?: string; error: string }
  | {
      success: true;
      paused: true;
      workflowRunId: string;
      waitCursor?: ReturnType<typeof deadlineWaitCursor>;
    }
  | {
      success: true;
      handedOff: true;
      workflowRunId: string;
      observedStatus: Exclude<WorkflowRunStatus, 'failed' | 'cancelled'> | null;
    }
  | {
      success: false;
      handedOff: true;
      workflowRunId: string;
      observedStatus: Extract<WorkflowRunStatus, 'failed' | 'cancelled'>;
      error: string;
    };

// ---------------------------------------------------------------------------
// WorkflowLoadError / WorkflowLoadResult — workflow discovery results
// ---------------------------------------------------------------------------

/**
 * Workflow origin:
 * - `bundled`   — embedded in the Archon binary / bundled defaults
 * - `global`    — user-level, discovered at `~/.archon/workflows/` (applies to every repo)
 * - `project`   — repo-local, discovered at `<repoRoot>/.archon/workflows/`
 * - `installed` — a workflow pack installed with `archon plugin add`, named
 *                 `owner/plugin:entrypoint`
 *
 * Precedence for same-named files: `bundled` < `global` < `project`. Installed
 * workflows take no part in it: their qualified names cannot collide with a file.
 */
export const workflowSourceSchema = z.enum(WORKFLOW_SOURCES);

export type WorkflowSource = z.infer<typeof workflowSourceSchema>;

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
  readonly model?: WorkflowModelRef;
  readonly effort?: EffortLevel;
}

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: ResolvedWorkflow;
  readonly source: WorkflowSource;
  /**
   * Author-facing warnings for this workflow: unknown keys and deprecation notices from
   * parsing the file, plus the loop_group sink-shape verdicts discovery computes on the
   * expanded graph (#2756). Never hard-fails.
   */
  readonly parseWarnings?: readonly string[];
  /** What the author declared at workflow level, for display. @see DeclaredWorkflowConfig */
  readonly declared?: DeclaredWorkflowConfig;
}

/**
 * Error encountered while loading a workflow file
 */
export const workflowLoadErrorSchema = z.object({
  filename: z.string(),
  workflowName: z.string().optional(),
  error: z.string(),
  errorType: z.enum(['read_error', 'parse_error', 'validation_error']),
});

export type WorkflowLoadError = Readonly<z.infer<typeof workflowLoadErrorSchema>> & {
  readonly cause?: unknown;
};

/** Errors without a known workflow name keep their full path to avoid aliasing a bare target. */
export function workflowLoadErrorName(error: WorkflowLoadError): string {
  return error.workflowName ?? error.filename.replace(/\.ya?ml$/, '');
}

export function findWorkflowLoadError(
  errors: readonly WorkflowLoadError[],
  name: string
): WorkflowLoadError | undefined {
  return (
    errors.find(error => error.workflowName === name) ??
    errors.find(error => error.workflowName?.toLowerCase() === name.toLowerCase()) ??
    errors.find(error => workflowLoadErrorName(error) === name) ??
    errors.find(error => workflowLoadErrorName(error).toLowerCase() === name.toLowerCase())
  );
}

/** Errors after parsing retain the authored identity even when the filename differs. */
export interface ParsedWorkflowLoadError extends WorkflowLoadError {
  readonly workflowName: string;
}

/**
 * Result of workflow discovery - includes both successful loads and errors
 */
export interface WorkflowLoadResult {
  /** Every dispatchable workflow: the only list a run, route, or listing may resolve against. */
  readonly workflows: readonly WorkflowWithSource[];
  /**
   * Installed packs' support workflows, named `owner/plugin:<name>`. Not dispatchable:
   * only composition inside their own pack (a runtime `include:` fan-out) resolves them.
   * Discovery always sets it; a result built by hand without installed packs may omit it.
   */
  readonly support?: readonly WorkflowWithSource[];
  readonly errors: readonly WorkflowLoadError[];
}
