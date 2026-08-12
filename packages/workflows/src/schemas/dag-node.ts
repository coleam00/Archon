/**
 * Zod schemas for DAG node types.
 *
 * Design: a flat "raw" schema validates all fields (with mutual exclusivity enforced via
 * superRefine), then a transform produces one of the six concrete variant types
 * (CommandNode, PromptNode, BashNode, LoopNode, ApprovalNode, CancelNode) as the DagNode union.
 * Per-variant schemas (commandNodeSchema etc.) are exported for type derivation only —
 * use dagNodeSchema for validation.
 *
 * z.union() is NOT used here — YAML nodes lack an explicit `type` discriminant,
 * so a flat schema with superRefine is cleaner than a z.union() with implicit discriminants.
 */
import { z } from '@hono/zod-openapi';
import { stepRetryConfigSchema } from './retry';
import { loopNodeConfigSchema, loopControlSchema, type LoopControl } from './loop';
import { workflowNodeHooksSchema } from './hooks';
import { isValidCommandName } from '../command-validation';

// ---------------------------------------------------------------------------
// TriggerRule
// ---------------------------------------------------------------------------

export const triggerRuleSchema = z.enum([
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
]);

export type TriggerRule = z.infer<typeof triggerRuleSchema>;

/** Canonical list of trigger rules — derived from schema, do not duplicate. */
export const TRIGGER_RULES: readonly TriggerRule[] = triggerRuleSchema.options;

// ---------------------------------------------------------------------------
// Claude SDK option schemas
// ---------------------------------------------------------------------------

/** Claude Agent SDK effort level — controls reasoning depth. Different from Codex modelReasoningEffort. */
export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'max']);

export type EffortLevel = z.infer<typeof effortLevelSchema>;

/**
 * Claude Agent SDK beta header list. Non-empty array of non-empty strings —
 * the SDK expects either a populated beta header or none at all. `.nonempty()`
 * enforces the min-length-1 rule at runtime; it does not narrow the inferred
 * TypeScript type to a non-empty tuple (the type stays `string[]`).
 */
export const betasSchema = z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array");

/**
 * Claude Agent SDK ThinkingConfig — string shorthand or full object form.
 * Shorthand: 'adaptive' → { type: 'adaptive' }, 'enabled' → { type: 'enabled' }, 'disabled' → { type: 'disabled' }.
 */
export const thinkingConfigSchema = z.preprocess(
  val => {
    if (typeof val === 'string') {
      if (val === 'adaptive') return { type: 'adaptive' };
      if (val === 'enabled') return { type: 'enabled' };
      if (val === 'disabled') return { type: 'disabled' };
    }
    return val;
  },
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('adaptive') }),
    z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().positive().optional() }),
    z.object({ type: z.literal('disabled') }),
  ])
);

export type ThinkingConfig = z.infer<typeof thinkingConfigSchema>;

/**
 * Claude Agent SDK SandboxSettings — OS-level filesystem/network restrictions.
 * Uses passthrough() to match the SDK's loose schema (index signature allows extra fields).
 */
export const sandboxSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    network: z
      .object({
        allowedDomains: z.array(z.string()).optional(),
        allowManagedDomainsOnly: z.boolean().optional(),
        allowUnixSockets: z.array(z.string()).optional(),
        allowAllUnixSockets: z.boolean().optional(),
        allowLocalBinding: z.boolean().optional(),
        httpProxyPort: z.number().optional(),
        socksProxyPort: z.number().optional(),
      })
      .optional(),
    filesystem: z
      .object({
        allowWrite: z.array(z.string()).optional(),
        denyWrite: z.array(z.string()).optional(),
        denyRead: z.array(z.string()).optional(),
      })
      .optional(),
    ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
    enableWeakerNestedSandbox: z.boolean().optional(),
    enableWeakerNetworkIsolation: z.boolean().optional(),
    excludedCommands: z.array(z.string()).optional(),
    ripgrep: z
      .object({
        command: z.string(),
        args: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

/**
 * Claude Agent SDK AgentDefinition — inline sub-agent available via the Task tool.
 * Mirrors the SDK's AgentDefinition type (sdk.d.ts), minus mcpServers and the
 * experimental critical-reminder field.
 */
export const agentDefinitionSchema = z.object({
  description: z.string().min(1, "'description' is required"),
  prompt: z.string().min(1, "'prompt' is required"),
  model: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/**
 * Per-node Pi extension posture — the PORTABLE authoring surface for issue #2133.
 * Mirrors the install-level `assistants.pi.nodes.<nodeId>` override map (#2124),
 * but lives on the node itself so it travels with the workflow instead of a
 * machine's `config.yaml`. Highest-precedence layer: node YAML `pi:` > config
 * `nodes.<id>` > assistant-level `assistants.pi.*`. Structurally identical to the
 * providers-side `PiNodeOverride` (@archon/providers/pi/config) — hand-mirrored
 * because @archon/workflows cannot import runtime values from @archon/providers
 * (only the contract subpath @archon/providers/types).
 *
 * Pi-only, like Claude's `hooks`/`mcp`/`skills`/`agents`. Other providers ignore
 * it; non-AI node types warn it's ignored (see BASH_NODE_AI_FIELDS).
 */
export const piNodeConfigSchema = z.object({
  /** Override extension discovery for this node (`assistants.pi.enableExtensions`). */
  enableExtensions: z.boolean().optional(),
  /** Override the UIContext binding (`ctx.hasUI`) for this node. */
  interactive: z.boolean().optional(),
  /**
   * Per-node extension flags, shallow-merged over the assistant-level and
   * config `nodes.<id>` flags (node YAML wins). Set a flag to `false` to negate
   * an inherited `true` (extensions check `getFlag(name) === true`).
   */
  extensionFlags: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
});

export type PiNodeConfig = z.infer<typeof piNodeConfigSchema>;

// Kebab-case: no leading/trailing/double hyphens (e.g. `brief-gen`, not `-brief`, `brief-`, `brief--gen`).
const AGENT_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// DagNodeBase — common fields shared by all node types
// ---------------------------------------------------------------------------

export const dagNodeBaseSchema = z.object({
  id: z.string(),
  // Optional human-readable documentation for the node. Purely informational —
  // the executor never reads it. Declared so workflow authors can self-document
  // nodes inline in the YAML instead of Zod silently stripping the field (#2012).
  description: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  when: z.string().optional(),
  trigger_rule: triggerRuleSchema.optional(),
  model: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
  context: z.enum(['fresh', 'shared']).optional(),
  output_format: z.record(z.string(), z.unknown()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
  idle_timeout: z.number().optional(),
  retry: stepRetryConfigSchema.optional(),
  hooks: workflowNodeHooksSchema.optional(),
  mcp: z.string().min(1, "'mcp' must be a non-empty string path").optional(),
  skills: z
    .array(z.string().min(1, 'each skill must be a non-empty string'))
    .nonempty("'skills' must be a non-empty array")
    .optional(),
  agents: z
    .record(z.string(), agentDefinitionSchema)
    // Validate agent-id keys in a superRefine rather than via a regex on the
    // record key schema: zod v4 collapses a failing key-schema into a generic
    // "Invalid key in record" message and drops the custom text, so the
    // kebab-case guidance is emitted here (with the offending key in the path).
    .superRefine((map, ctx) => {
      for (const key of Object.keys(map)) {
        if (!AGENT_ID_REGEX.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `agent IDs must be kebab-case (a-z, 0-9, hyphen): '${key}'`,
            path: [key],
          });
        }
      }
    })
    .refine(map => Object.keys(map).length > 0, "'agents' must have at least one entry")
    .optional(),
  // Portable per-node Pi extension posture (#2133). Highest-precedence layer
  // over the install-level `assistants.pi.nodes.<id>` map. Pi-only; ignored
  // (with a warning) on other providers and on non-AI node types.
  pi: piNodeConfigSchema.optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  maxBudgetUsd: z.number().positive().optional(),
  // YAML workflows: string-only. The wider SystemPromptInput (preset object) is used
  // programmatically by the orchestrator for prompt caching; Zod intentionally stays narrow.
  systemPrompt: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  // Per-node override for which filesystem setting sources Claude loads
  // (CLAUDE.md, skills, commands, agents). Omitting it inherits the
  // assistant-level default (['project', 'user'] when unset). Claude-only;
  // other providers warn and ignore it. Lets a lean node (e.g. a reviewer)
  // skip project/user context loading for faster startup.
  settingSources: z.array(z.enum(['project', 'user'])).optional(),
  betas: betasSchema.optional(),
  sandbox: sandboxSettingsSchema.optional(),
  // Opt out of resume caching: when true, this node re-runs on resume even if a
  // prior run completed it successfully. Use for producers whose exit code does
  // not capture output validity (e.g. bash that writes a file the consumer parses).
  always_run: z.boolean().optional(),
  // Persist this node's provider session ID across workflow re-runs in the same
  // scope (typically the conversation). On the next run with the same scope, the
  // executor loads the stored session and passes it as resumeSessionId. Requires
  // a provider with sessionResume capability. Distinct from the Claude SDK's
  // AgentRequestOptions.persistSession (on-disk transcript persistence).
  persist_session: z.boolean().optional(),
  // Declares the semantic type of this node's output (e.g. 'plan', 'findings',
  // 'code', 'summary' — an open set). When set, the executor writes a typed
  // sidecar artifact (`nodes/<id>.md` + `<id>.meta.json`) after the node
  // completes, so other nodes and later runs can locate output by type instead
  // of guessing filenames. Valid on every node type (bash/script produce typed
  // outputs too) — not an AI-only field.
  output_type: z.string().min(1).optional(),
});

export type DagNodeBase = z.infer<typeof dagNodeBaseSchema>;

// ---------------------------------------------------------------------------
// Per-variant schemas — exported for type derivation only (use dagNodeSchema for validation)
// ---------------------------------------------------------------------------

export const commandNodeSchema = dagNodeBaseSchema.extend({
  command: z.string(),
});

/** DAG node that runs a named command from .archon/commands/ */
export type CommandNode = z.infer<typeof commandNodeSchema> & {
  prompt?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

export const promptNodeSchema = dagNodeBaseSchema.extend({
  prompt: z.string(),
});

/** DAG node with an inline prompt (no command file) */
export type PromptNode = z.infer<typeof promptNodeSchema> & {
  command?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/**
 * Bash node schema — extends base with `bash` (shell script) and `timeout` (ms).
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 */
export const bashNodeSchema = dagNodeBaseSchema.extend({
  bash: z.string(),
  timeout: z.number().optional(),
});

/** DAG node that runs a shell script without AI */
export type BashNode = z.infer<typeof bashNodeSchema> & {
  command?: never;
  prompt?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/**
 * Script node schema — extends base with `script` (inline code or named script),
 * `runtime` ('bun' or 'uv'), `deps` (dependency list), and `timeout` (ms).
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 */
export const scriptNodeSchema = dagNodeBaseSchema.extend({
  script: z.string().min(1, 'script cannot be empty'),
  runtime: z.enum(['bun', 'uv']),
  deps: z.array(z.string().min(1, 'each dep must be a non-empty string')).optional(),
  timeout: z.number().optional(),
});

/** DAG node that runs a TypeScript or Python script via bun or uv */
export type ScriptNode = z.infer<typeof scriptNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
};

/**
 * Loop node schema — extends base with `loop` config.
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 * retry is not supported on loop nodes (enforced at parse time).
 */
export const loopNodeSchema = dagNodeBaseSchema.extend({
  loop: loopNodeConfigSchema,
});

/** DAG node that runs an AI prompt in a loop until a completion condition is met */
export type LoopNode = z.infer<typeof loopNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/**
 * Loop-group node config — iteration control (`loopControlSchema`) plus a `nodes:` sub-DAG
 * body that is re-executed in full each iteration. The body nodes are themselves
 * `dagNodeSchema` instances, so a `loop_group` body may contain any node type — including
 * another `loop_group` (nested loops).
 *
 * The body is recursive (`loopGroupNodeConfigSchema` ← `dagNodeSchema` ←
 * `loopGroupNodeConfigSchema`). zod v4 infers recursive types cleanly via getter
 * properties plus an explicit `z.ZodType<T>` annotation on the recursive schema
 * (https://zod.dev/v4?id=refinements-live-inside-schemas) — the annotation breaks the
 * type-inference cycle (TS7022) that a plain `z.lazy(() => dagNodeSchema)` trips over.
 * At runtime the getter returns a full `z.array(dagNodeSchema)`, so the body is validated
 * as real DagNodes — including nested loop_groups.
 */
export type LoopGroupNodeConfig = LoopControl & {
  /** Sub-DAG body re-executed in full each iteration. At least one node required. */
  nodes: DagNode[];
};
export const loopGroupNodeConfigSchema: z.ZodType<LoopGroupNodeConfig> = loopControlSchema.extend({
  /** Sub-DAG body re-executed in full each iteration. At least one node required. */
  get nodes(): z.ZodArray<typeof dagNodeSchema> {
    return z.array(dagNodeSchema).min(1, "'loop_group.nodes' must have at least one node");
  },
});

/**
 * Loop-group node schema — extends base with `loop_group` config (iteration control + body).
 * Like `loop:`, AI-specific base fields are ignored at runtime with a warning, and `retry`
 * is not supported (the loop manages its own iteration). `model`/`provider` are forwarded
 * to body AI nodes unless overridden per-node (same forwarding `loop:` uses).
 */
export const loopGroupNodeSchema = dagNodeBaseSchema.extend({
  loop_group: loopGroupNodeConfigSchema,
});

/** DAG node that runs a multi-node sub-DAG in a loop until a completion condition is met */
export type LoopGroupNode = z.infer<typeof loopGroupNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/** Schema for the `on_reject` sub-object on approval nodes. */
export const approvalOnRejectSchema = z.object({
  prompt: z.string().min(1, "'on_reject.prompt' must be a non-empty string"),
  max_attempts: z.number().int().min(1).max(10).optional(),
});

export type ApprovalOnReject = z.infer<typeof approvalOnRejectSchema>;

/**
 * Schema for the `approval:` config object. Named (rather than inlined at both
 * use sites) so its shape is reachable for the unknown-key check in the loader.
 */
export const approvalConfigSchema = z.object({
  message: z.string().min(1, "'approval.message' must not be empty"),
  capture_response: z.boolean().optional(),
  on_reject: approvalOnRejectSchema.optional(),
});

/**
 * Approval node schema — pauses the workflow for human review.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 */
export const approvalNodeSchema = dagNodeBaseSchema.extend({
  approval: approvalConfigSchema,
});

/** DAG node that pauses workflow execution for human approval */
export type ApprovalNode = z.infer<typeof approvalNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  cancel?: never;
  script?: never;
};

/**
 * Cancel node schema — terminates the workflow run with a reason string.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 */
export const cancelNodeSchema = dagNodeBaseSchema.extend({
  cancel: z.string().min(1, "'cancel' reason must not be empty"),
});

/** DAG node that cancels the workflow run with a reason string */
export type CancelNode = z.infer<typeof cancelNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  script?: never;
};

/**
 * Identifier grammar for an include input name.
 *
 * Shared deliberately with the `$INPUTS.<name>` reference pattern in include-expander.ts,
 * which builds its regex from this source. The two encode the identical concept and the
 * drift between them is one-directional and silent: loosening this validator alone would
 * let `with: {my.key: v}` pass while `$INPUTS.my.key` matches only `$INPUTS.my`, leaving
 * `.key` as trailing literal text in the prompt. (The reverse drift fails loudly at load,
 * because the matching `with:` key would be rejected here.) Sharing one source removes the
 * dangerous direction. This is scoped to that pair only — the similar-looking node-id
 * grammar elsewhere in the tree encodes a different concept and stays separate.
 */
export const INPUT_NAME_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_-]*`;
export const INPUT_NAME_PATTERN = new RegExp(`^${INPUT_NAME_SOURCE}$`);

/**
 * Env-var key an input name is delivered under to bash/script sub-run nodes (#2470):
 * `INPUTS_` + UPPER_SNAKE(name) (hyphens → underscores, uppercased). Because `-` and
 * `_` both fold to `_`, two distinct names (`foo-bar`, `foo_bar`) can collide on one
 * env key — the loader rejects that at load time (all names for one workflow are
 * visible there). Bash/script bodies read `$INPUTS_<UPPER_SNAKE>`; `$INPUTS.<name>`
 * text is only substituted into non-shell (AI/prompt) surfaces.
 */
export function inputEnvKey(name: string): string {
  return `INPUTS_${name.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * Include node schema — a load-time directive that inlines another workflow's
 * nodes into this DAG at discovery time (see include-expander.ts). It carries no
 * execution surface of its own: `include` is the target workflow name, `with` is
 * its load-time input mapping, and the structural graph fields (id / depends_on /
 * when / trigger_rule) attach the expanded sub-DAG. By the time a
 * WorkflowDefinition reaches the executor, every include node has been replaced
 * by its flattened, namespaced sub-DAG — the executor never sees one.
 */
export const includeNodeSchema = dagNodeBaseSchema.extend({
  include: z.string().min(1, "'include' must be a non-empty workflow name"),
  with: z.record(z.string(), z.string()).optional(),
});

/** DAG node that inlines another workflow's nodes at discovery time (load-time expansion) */
export type IncludeNode = z.infer<typeof includeNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/**
 * Dynamic fan-out config for a `workflow:` node (#2121 slice 2, PR-C). Expands the
 * node into N governed child runs — one per element of a runtime-length item list —
 * joined into a single node outcome. `items` is a `$node.output[.field]` ref that
 * MUST resolve to a JSON array at run time (DATA, per the constitution's
 * §load-time-composition — the child target stays a static name; only the item
 * COUNT is runtime). Each item becomes a child's `input`/`$ARGUMENTS`. `max_parallel`
 * bounds a sliding-window concurrency pool (default 5 — documented + defeatable, so
 * an author can't trivially create a runaway N-wide layer, #1961). It is also the serial
 * escape from the shared-checkout collision: `max_parallel: 1` runs the children one at a
 * time, so no two of them contend for the parent checkout's path lock. `max_parallel` caps
 * *concurrency*, NOT the total child count — `items.length` is unbounded here, so a very
 * large list (≳ the abandon-time cascade bound `MAX_CASCADE_RUNS`, currently 500) can
 * leave some children uncancelled when the parent is abandoned; a run-tree-wide count/
 * budget ceiling is deferred to #1961. `join` reduces the
 * N child outcomes into the node's single outcome + `$<id>.output` aggregate:
 *   - `all_done` (DEFAULT): the node succeeds once every child is terminal; failed and
 *      cancelled entries are represented as `{ error, status }` objects in the array.
 *      Default because fan-out children are independent by default (see the constitution's
 *      independence rule) — two researchers with different scopes, or ten triage children
 *      over ten issues, do not depend on each other, so one failing must not discard the
 *      others' output. Failure is DATA here; deciding how many successes are enough is
 *      judgement and belongs in a downstream node reading the aggregate, never in this enum.
 *   - `all_success`: all must complete; `$<id>.output` = JSON array of child outputs in
 *      item order; any child failing/cancelled fails the node. For the genuinely dependent
 *      case, where the author says so.
 *   - `first_success`: racing — REJECTED, not deferred. A winner aborting and cancelling
 *      the losers couples children's fates, which the constitution's independence rule
 *      forbids, and racing cannot be reshaped without it. The enum value is retained only
 *      so existing YAML gets a message explaining the rejection.
 *
 * `as` names the per-item value as `$INPUTS.<as>` inside each child (#2470 lifted the
 * PR-B/#2214 placeholder now that #2224 merged). It is generally accepted; the superRefine
 * rejects it only when it collides with a `with:` key of the same name (both would populate
 * the same `$INPUTS.<name>` slot). When `as` is unset the item still travels as `$ARGUMENTS`.
 */
export const fanOutConfigSchema = z.object({
  items: z
    .string()
    .min(1, "'fan_out.items' must reference a node output that produces a JSON array"),
  as: z.string().optional(),
  max_parallel: z.number().int().min(1, "'fan_out.max_parallel' must be >= 1").default(5),
  join: z.enum(['all_success', 'all_done', 'first_success']).default('all_done'),
});

/** Dynamic fan-out configuration for a `workflow:` sub-run node (#2121 slice 2, PR-C). */
export type FanOutConfig = z.infer<typeof fanOutConfigSchema>;

/**
 * Workflow (sub-run) node schema — starts another workflow as a CHILD RUN of the
 * current run at execution time (see executeWorkflowNode in dag-executor.ts). Unlike
 * `include:` (which flattens another workflow's nodes into ONE run at load time), a
 * `workflow:` node spawns a genuinely separate `workflow_runs` row with its own
 * artifacts, gates, cost line, and audit trail (#2121 Phase 2). `workflow` is the
 * static target name; `input` is a data string (workflow-vars + `$node.output`
 * substituted) forwarded as the child's user message. `isolation` selects the
 * child's checkout: `'inherit'` (default) shares the parent's checkout; `'worktree'`
 * (slice 2, PR-A) runs the child in its own git worktree via an injected
 * child-isolation resolver — never inferred, including from `fan_out`. `fan_out` (slice 2,
 * PR-C) expands the node into N child runs over a data-driven item list; concurrent
 * children sharing the parent checkout are the author's call to make, declared by
 * `mutates_checkout: false` on the child workflow. `output_format`/`output_type` from the base stay
 * meaningful (the child's terminal output threads back as `$<id>.output`,
 * field-accessible when a schema is declared and the child emits JSON).
 */
export const workflowNodeSchema = dagNodeBaseSchema.extend({
  workflow: z.string().min(1, "'workflow' must be a non-empty workflow name"),
  input: z.string().optional(),
  // Named inputs passed to the child sub-run as `$INPUTS.<name>` (#2470). Mutually
  // exclusive with `input:`. Same identifier-keyed string-map shape as `include.with`.
  with: z.record(z.string(), z.string()).optional(),
  isolation: z.enum(['inherit', 'worktree']).optional(),
  fan_out: fanOutConfigSchema.optional(),
});

/** DAG node that runs another workflow as a governed child sub-run at execution time */
export type WorkflowNode = z.infer<typeof workflowNodeSchema> & {
  command?: never;
  prompt?: never;
  bash?: never;
  loop?: never;
  loop_group?: never;
  approval?: never;
  cancel?: never;
  script?: never;
};

/** A single node in a DAG workflow. command, prompt, bash, loop, loop_group, approval, cancel, script, include, and workflow are mutually exclusive. */
export type DagNode =
  | CommandNode
  | PromptNode
  | BashNode
  | LoopNode
  | LoopGroupNode
  | ApprovalNode
  | CancelNode
  | ScriptNode
  | IncludeNode
  | WorkflowNode;

// ---------------------------------------------------------------------------
// AI-specific fields that are meaningless on non-AI nodes
// ---------------------------------------------------------------------------

/** AI-specific fields that are meaningless on bash nodes — exported for loader warnings */
export const BASH_NODE_AI_FIELDS: readonly string[] = [
  'provider',
  'model',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
  'hooks',
  'mcp',
  'skills',
  'agents',
  'pi',
  'effort',
  'thinking',
  'maxBudgetUsd',
  'systemPrompt',
  'fallbackModel',
  'settingSources',
  'betas',
  'sandbox',
  'persist_session',
];

/** AI-specific fields that are meaningless on script nodes — same as bash nodes */
export const SCRIPT_NODE_AI_FIELDS: readonly string[] = BASH_NODE_AI_FIELDS;

/**
 * AI-specific fields that are unsupported on loop nodes.
 * `model` and `provider` are excluded because loop iterations inherit them from
 * the workflow level. `pi` is excluded because the portable per-node Pi posture
 * (#2133) IS threaded into each iteration's sendQuery — the loop is the very
 * node whose extension posture users need to scope (plannotator planning-mode
 * leak, #2073).
 */
export const LOOP_NODE_AI_FIELDS: readonly string[] = BASH_NODE_AI_FIELDS.filter(
  f => f !== 'model' && f !== 'provider' && f !== 'pi'
);

/**
 * AI-specific fields that are unsupported on loop_group nodes. `model`/`provider`
 * are forwarded to each body AI node (overridable per-node), so they remain
 * meaningful at the group level. `pi` is NOT forwarded — the group never calls
 * sendQuery, and body nodes carry their own `pi:` block — so it's warned as
 * ignored here (unlike on a plain `loop:` node, which does sendQuery itself).
 */
export const LOOP_GROUP_NODE_AI_FIELDS: readonly string[] = BASH_NODE_AI_FIELDS.filter(
  f => f !== 'model' && f !== 'provider'
);

/**
 * Fields that are meaningless on an include node — it inlines another workflow's
 * nodes at load time and executes nothing itself, so every AI/exec field is
 * ignored (the inlined child nodes carry their own). A superset of
 * `BASH_NODE_AI_FIELDS` plus the remaining execution-only fields. The structural
 * graph fields the include node DOES use (id / depends_on / when / trigger_rule /
 * description) are deliberately absent.
 */
export const INCLUDE_NODE_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS,
  'retry',
  'output_type',
  'always_run',
  'idle_timeout',
  'timeout',
];

/**
 * Fields that are meaningless on a workflow (sub-run) node — it starts a child
 * run and makes no direct provider call, so every AI-turn field is ignored (the
 * child's own nodes carry theirs). `output_format` is deliberately EXCLUDED from
 * this list (unlike bash/include): it stays meaningful so `$<id>.output.field`
 * works against a child that emits JSON. `output_type` (typed sidecar) and the
 * structural graph fields (id / depends_on / when / trigger_rule / description /
 * input / isolation) are likewise meaningful and absent here.
 */
export const WORKFLOW_NODE_IGNORED_FIELDS: readonly string[] = BASH_NODE_AI_FIELDS.filter(
  f => f !== 'output_format'
);

/**
 * Flat schema with all DAG node fields (base + mode + mode-specific) before
 * superRefine/transform. Exported so KNOWN_DAG_NODE_KEYS can be derived from
 * its shape, and for any future use that needs the pre-validation object type.
 */
export const dagNodeFlatSchema = dagNodeBaseSchema.extend({
  // Mode fields (exactly one required)
  command: z.string().optional(),
  prompt: z.string().optional(),
  bash: z.string().optional(),
  loop: loopNodeConfigSchema.optional(),
  loop_group: loopGroupNodeConfigSchema.optional(),
  approval: approvalConfigSchema.optional(),
  cancel: z.string().optional(),
  // Load-time inlining directive — the target workflow name.
  include: z.string().min(1, "'include' must be a non-empty workflow name").optional(),
  // Runtime sub-run directive (#2121 Phase 2) — the child workflow name.
  workflow: z.string().min(1, "'workflow' must be a non-empty workflow name").optional(),
  // Sub-run input data string (workflow-var + $node.output substituted) forwarded
  // as the child's user_message.
  input: z.string().optional(),
  // Per-child isolation. `'inherit'` (shared parent checkout) is the default;
  // `'worktree'` (slice 2, PR-A) runs the child in its own git worktree via an
  // injected child-isolation resolver.
  isolation: z.enum(['inherit', 'worktree']).optional(),
  // Dynamic fan-out (slice 2, PR-C) — expand the workflow node into N child runs
  // over a data-driven item list. Only meaningful on a `workflow:` node (guarded in
  // superRefine).
  fan_out: fanOutConfigSchema.optional(),
  // Raw (not `z.record(z.string(), z.string())`) so each relevant node mode validates it
  // contextually. Include and workflow nodes both accept the same identifier-keyed string
  // map, validate it in superRefine, and retain it in their transform. Other node modes
  // strip it with the rest of their unsupported surface.
  with: z.unknown().optional(),
  // Script-only
  script: z.string().optional(),
  runtime: z.enum(['bun', 'uv']).optional(),
  deps: z.array(z.string().min(1, 'each dep must be a non-empty string')).optional(),
  // Bash/Script shared
  timeout: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Known node keys — used by the loader to detect unknown/misplaced keys
// ---------------------------------------------------------------------------

/**
 * All keys accepted by the flat dagNodeSchema (base + mode-specific + mode-only).
 * Derived from the dagNodeFlatSchema shape — no hand-maintained list needed.
 * Used by parseDagNode to warn on unknown keys that Zod's default strip would
 * silently drop (#2213).
 */
export const KNOWN_DAG_NODE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(dagNodeFlatSchema.shape)
);

// ---------------------------------------------------------------------------
// dagNodeSchema — flat validation schema with transform to DagNode
// ---------------------------------------------------------------------------

/**
 * Validates a raw YAML object as a DAG node and transforms it to a typed DagNode.
 *
 * Enforces:
 * - Non-empty id
 * - Exactly one of command/prompt/bash/loop/loop_group/approval/cancel/script (mutual exclusivity)
 * - command name validity (via isValidCommandName)
 * - idle_timeout must be a finite positive number
 * - retry not allowed on loop or loop_group nodes
 * - timeout on bash must be positive
 *
 * Note: provider identity is validated in loader.ts (workflow-level) and
 * dag-executor.ts (node-level). Model strings are passed through to the SDK
 * unchanged — the SDK is the source of truth for what model names exist.
 */
export const dagNodeSchema = dagNodeFlatSchema
  .superRefine((data, ctx) => {
    const id = data.id.trim();

    // id must be non-empty
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "missing required field 'id'",
        path: ['id'],
      });
      return z.NEVER;
    }
    if (id === 'INPUTS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "node id 'INPUTS' is reserved for the $INPUTS.<name> parameter surface",
        path: ['id'],
      });
    }

    const hasCommand = typeof data.command === 'string' && data.command.trim().length > 0;
    const hasPrompt = typeof data.prompt === 'string' && data.prompt.trim().length > 0;
    const hasBash = typeof data.bash === 'string' && data.bash.trim().length > 0;
    const hasLoop = data.loop !== undefined;
    const hasLoopGroup = data.loop_group !== undefined;
    const hasApproval = data.approval !== undefined;
    const hasCancel = typeof data.cancel === 'string' && data.cancel.trim().length > 0;
    const hasScript = typeof data.script === 'string' && data.script.trim().length > 0;
    const hasInclude = typeof data.include === 'string' && data.include.trim().length > 0;
    const hasWorkflow = typeof data.workflow === 'string' && data.workflow.trim().length > 0;

    const modeCount = [
      hasCommand,
      hasPrompt,
      hasBash,
      hasLoop,
      hasLoopGroup,
      hasApproval,
      hasCancel,
      hasScript,
      hasInclude,
      hasWorkflow,
    ].filter(Boolean).length;

    if (modeCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'command', 'prompt', 'bash', 'loop', 'loop_group', 'approval', 'cancel', 'script', 'include', and 'workflow' are mutually exclusive",
      });
      return z.NEVER;
    }

    // `with:` is an identifier-keyed string map on BOTH include and workflow nodes
    // (#2470). For includes it inlines at load time (applyInputsMacro); for sub-runs it
    // becomes `$INPUTS.<name>` runtime variables on the child. Same shape validation for
    // both; the flat field stays `z.unknown()` so other node variants strip it contextually.
    const validateWithShape = (kind: 'include' | 'workflow'): void => {
      const prototype =
        typeof data.with === 'object' && data.with !== null
          ? Object.getPrototypeOf(data.with)
          : undefined;
      if (
        typeof data.with !== 'object' ||
        data.with === null ||
        Array.isArray(data.with) ||
        (prototype !== Object.prototype && prototype !== null)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'with' on ${kind} nodes must be an object mapping input names to strings`,
          path: ['with'],
        });
        return;
      }
      for (const [key, value] of Object.entries(data.with)) {
        if (!INPUT_NAME_PATTERN.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `invalid ${kind} input name '${key}'; use letters, numbers, underscores, or hyphens and start with a letter or underscore`,
            path: ['with'],
          });
        }
        if (typeof value !== 'string') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind} input '${key}' must be a string`,
            path: ['with'],
          });
        }
      }
    };
    if (hasInclude && data.with !== undefined) validateWithShape('include');
    if (hasWorkflow && data.with !== undefined) validateWithShape('workflow');
    // A `workflow:` node has ONE input channel per invocation: either the untyped
    // `input:` string ($ARGUMENTS) or the named `with:` map ($INPUTS.<name>). Accepting
    // both would require a precedence rule between two overlapping channels — the exact
    // ambiguity the constitution's smell #5 warns against — so reject them together.
    if (hasWorkflow && data.with !== undefined && data.input !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'with:' and 'input:' cannot both be set on a workflow node — 'with:' supplies named $INPUTS, 'input:' supplies the child's $ARGUMENTS. Use one.",
        path: ['with'],
      });
    }
    // 'retry:' on a workflow node would spawn a NEW child run and orphan the first —
    // recovery is resume-through-parent, not retry (#1764). Reject fail-fast.
    if (hasWorkflow && data.retry !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'retry' is not supported on workflow nodes (a retry would orphan the first child run — resume through the parent instead)",
        path: ['retry'],
      });
    }
    // Per-child worktree isolation (slice 2, PR-A) is accepted on workflow nodes.
    // The engine fails the node fast at runtime if no child-isolation resolver is
    // injected — never a silent shared-checkout fallback. On every OTHER node type
    // `isolation:` is meaningless (only a `workflow:` node spawns a child run) and
    // would be silently dropped — reject it fail-fast, mirroring the `with:` guard.
    if (!hasWorkflow && data.isolation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'isolation' is only supported on workflow (sub-run) nodes.",
        path: ['isolation'],
      });
    }
    // Dynamic fan-out (slice 2, PR-C) is meaningful ONLY on a `workflow:` node — it
    // multiplies a child sub-run. On any other node type it would be silently dropped,
    // so reject it fail-fast (mirrors the `isolation` guard above).
    if (!hasWorkflow && data.fan_out !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'fan_out' is only supported on workflow (sub-run) nodes.",
        path: ['fan_out'],
      });
    }
    // `first_success` racing is REJECTED, not deferred — the earlier deferral is dead. A
    // winner aborting and cancelling its losers is one child's outcome ending its siblings',
    // which the independence rule forbids, and racing without terminating the losers is not
    // racing. So there is no PR to wait for and the message must not imply one.
    //
    // The enum value stays even though its original "so the eventual PR only lifts a guard"
    // justification is gone. A better one replaces it: an author whose YAML already says
    // `first_success` gets a message naming the rejection and the shape that serves the want,
    // instead of an opaque unrecognised-enum-value error. Do not remove it as dead weight.
    if (hasWorkflow && data.fan_out?.join === 'first_success') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'fan_out.join: first_success' (racing) is rejected, not deferred: a winner cancels " +
          "the losers, which couples children that are meant to be independent. Use 'all_done' " +
          '(the default). For several genuinely different attempts, write them as separate ' +
          'nodes with their own models feeding one collector node — every attempt is kept and ' +
          'nothing is cancelled.',
        path: ['fan_out', 'join'],
      });
    }
    // `fan_out.as` names the per-item value as `$INPUTS.<as>` inside each child (#2470
    // lifts the PR-B/#2214 placeholder — #2224 merged). It is now generally accepted; the
    // only rejection is a COLLISION with a `with:` key, since both would populate the same
    // `$INPUTS.<name>` slot on the child with a precedence rule between them — the same
    // two-channels-one-name ambiguity the `with:`+`input:` guard rejects above.
    if (
      hasWorkflow &&
      data.fan_out?.as !== undefined &&
      typeof data.with === 'object' &&
      data.with !== null &&
      !Array.isArray(data.with) &&
      Object.prototype.hasOwnProperty.call(data.with, data.fan_out.as)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'fan_out.as: ${data.fan_out.as}' collides with a 'with:' key of the same name — both would populate $INPUTS.${data.fan_out.as}. Rename one.`,
        path: ['fan_out', 'as'],
      });
    }

    if (modeCount === 0) {
      if (typeof data.bash === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'bash script cannot be empty',
          path: ['bash'],
        });
        return z.NEVER;
      }
      if (typeof data.prompt === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'prompt cannot be empty',
          path: ['prompt'],
        });
        return z.NEVER;
      }
      if (typeof data.script === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'script cannot be empty',
          path: ['script'],
        });
        return z.NEVER;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "must have either 'command', 'prompt', 'bash', 'loop', 'loop_group', 'approval', 'cancel', 'script', 'include', or 'workflow'",
      });
      return z.NEVER;
    }

    // Command name validation
    if (hasCommand && !isValidCommandName((data.command ?? '').trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid command name "${(data.command ?? '').trim()}"`,
        path: ['command'],
      });
    }

    // Bash node validations
    if (hasBash) {
      if (data.timeout !== undefined && (data.timeout <= 0 || !isFinite(data.timeout))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'timeout' must be a positive number (ms)",
          path: ['timeout'],
        });
      }
    }

    // Script node validations
    if (hasScript) {
      if (data.runtime === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'runtime' is required for script nodes ('bun' or 'uv')",
          path: ['runtime'],
        });
      }
      if (data.timeout !== undefined && (data.timeout <= 0 || !isFinite(data.timeout))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'timeout' must be a positive number (ms)",
          path: ['timeout'],
        });
      }
    }

    // Loop node: retry not supported
    if (hasLoop && data.retry !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'retry' is not supported on loop nodes (loop manages its own iteration)",
        path: ['retry'],
      });
    }

    // Loop-group node: retry not supported (the loop_group manages its own iteration)
    if (hasLoopGroup && data.retry !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'retry' is not supported on loop_group nodes (loop_group manages its own iteration)",
        path: ['retry'],
      });
    }

    // idle_timeout must be finite and positive
    if (
      data.idle_timeout !== undefined &&
      (data.idle_timeout <= 0 || !isFinite(data.idle_timeout))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'idle_timeout' must be a finite positive number (ms)",
        path: ['idle_timeout'],
      });
    }
  })
  .transform((data): DagNode => {
    const id = data.id.trim();

    // Structural graph fields present on every node — including the execution-less
    // include node, which carries ONLY these (see the include branch below). Sparse:
    // only defined values are included.
    const structuralBase = {
      id,
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.depends_on !== undefined && data.depends_on.length > 0
        ? { depends_on: data.depends_on }
        : {}),
      ...(data.when !== undefined ? { when: data.when } : {}),
      ...(data.trigger_rule !== undefined ? { trigger_rule: data.trigger_rule } : {}),
    };

    // Common base fields for executable nodes — structural fields plus the exec-only
    // scheduling fields (sparse — only include defined values).
    const base = {
      ...structuralBase,
      ...(data.idle_timeout !== undefined ? { idle_timeout: data.idle_timeout } : {}),
      ...(data.always_run !== undefined ? { always_run: data.always_run } : {}),
      ...(data.output_type !== undefined ? { output_type: data.output_type } : {}),
    };

    // Shared optional fields (valid on AI and bash nodes)
    const shared = {
      ...(data.retry !== undefined ? { retry: data.retry } : {}),
    };

    // AI-only fields (not applicable to bash/loop nodes)
    const aiOnly = {
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.context !== undefined ? { context: data.context } : {}),
      ...(data.output_format !== undefined ? { output_format: data.output_format } : {}),
      ...(data.allowed_tools !== undefined ? { allowed_tools: data.allowed_tools } : {}),
      ...(data.denied_tools !== undefined ? { denied_tools: data.denied_tools } : {}),
      ...(data.hooks !== undefined ? { hooks: data.hooks } : {}),
      ...(data.mcp !== undefined ? { mcp: data.mcp.trim() } : {}),
      ...(data.skills !== undefined ? { skills: data.skills.map(s => s.trim()) } : {}),
      ...(data.agents !== undefined ? { agents: data.agents } : {}),
      ...(data.pi !== undefined ? { pi: data.pi } : {}),
      ...(data.effort !== undefined ? { effort: data.effort } : {}),
      ...(data.thinking !== undefined ? { thinking: data.thinking } : {}),
      ...(data.maxBudgetUsd !== undefined ? { maxBudgetUsd: data.maxBudgetUsd } : {}),
      ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
      ...(data.fallbackModel !== undefined ? { fallbackModel: data.fallbackModel } : {}),
      ...(data.settingSources !== undefined ? { settingSources: data.settingSources } : {}),
      ...(data.betas !== undefined ? { betas: data.betas } : {}),
      ...(data.sandbox !== undefined ? { sandbox: data.sandbox } : {}),
      ...(data.persist_session !== undefined ? { persist_session: data.persist_session } : {}),
    };

    if (data.command !== undefined && data.command.trim().length > 0) {
      return { ...base, ...shared, ...aiOnly, command: data.command.trim() } as CommandNode;
    }
    if (data.prompt !== undefined && data.prompt.trim().length > 0) {
      return { ...base, ...shared, ...aiOnly, prompt: data.prompt.trim() } as PromptNode;
    }
    if (data.bash !== undefined && data.bash.trim().length > 0) {
      return {
        ...base,
        ...shared,
        bash: data.bash.trim(),
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      } as BashNode;
    }
    if (data.script !== undefined && data.script.trim().length > 0) {
      // runtime is guaranteed by superRefine to be defined at this point
      if (!data.runtime) throw new Error('unreachable: runtime must be defined for script nodes');
      return {
        ...base,
        ...shared,
        script: data.script.trim(),
        runtime: data.runtime,
        ...(data.deps !== undefined ? { deps: data.deps } : {}),
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      } as ScriptNode;
    }
    if (data.approval !== undefined) {
      return { ...base, ...shared, approval: data.approval } as ApprovalNode;
    }
    if (data.cancel !== undefined && data.cancel.trim().length > 0) {
      return { ...base, ...shared, cancel: data.cancel.trim() } as CancelNode;
    }
    if (data.include !== undefined && data.include.trim().length > 0) {
      // An include node is a load-time directive, not an executable node. It carries the
      // structural graph fields, target name, and optional load-time input mapping. The
      // expander reads those fields to attach and parameterize the sub-DAG (description just
      // rides along). aiOnly / shared (retry) and the exec-only base fields (always_run /
      // output_type / idle_timeout) are intentionally dropped; the loader warns about them
      // via INCLUDE_NODE_IGNORED_FIELDS.
      return {
        ...structuralBase,
        include: data.include.trim(),
        ...(data.with !== undefined ? { with: data.with as Record<string, string> } : {}),
      } as IncludeNode;
    }
    if (data.workflow !== undefined && data.workflow.trim().length > 0) {
      // A workflow (sub-run) node makes no direct provider call, so it carries only
      // the structural graph fields plus the sub-run surface: the target name, the
      // input data string, the reserved isolation mode, and the output typing fields
      // (output_type → typed sidecar; output_format → `$id.output.field` on a JSON
      // child). aiOnly / shared(retry) / exec-only base fields are dropped; the loader
      // warns about them via WORKFLOW_NODE_IGNORED_FIELDS.
      return {
        ...structuralBase,
        ...(data.output_type !== undefined ? { output_type: data.output_type } : {}),
        ...(data.output_format !== undefined ? { output_format: data.output_format } : {}),
        workflow: data.workflow.trim(),
        ...(data.input !== undefined ? { input: data.input } : {}),
        // `with:` supplies named $INPUTS to the child sub-run (#2470), validated in shape
        // by the superRefine above and mutually exclusive with `input:`. Mirrors the
        // include transform's `with` assembly.
        ...(data.with !== undefined ? { with: data.with as Record<string, string> } : {}),
        // Isolation is EXPLICIT-ONLY — never inferred, including from `fan_out`. How many
        // children a node spawns says nothing about whether they write; N review or
        // research children over the shared checkout is the common case. A shared-checkout
        // fan-out whose children would collide is caught at spawn time instead
        // (executeFanOutWorkflowNode), where the child's `mutates_checkout` is knowable.
        ...(data.isolation !== undefined ? { isolation: data.isolation } : {}),
        ...(data.fan_out !== undefined ? { fan_out: data.fan_out } : {}),
      } as WorkflowNode;
    }
    // loop_group — guaranteed by superRefine to be defined at this point.
    // Spread aiOnly so group-level model/provider survive parsing — the executor forwards
    // them to body AI nodes unless overridden per-node ('loop:' historically drops them at
    // parse; loop_group keeps them to support group-level overrides). The REMAINING aiOnly
    // fields are the ones LOOP_GROUP_NODE_AI_FIELDS declares unsupported: they ride along
    // here but the loader warns about and ignores them at runtime.
    if (data.loop_group !== undefined) {
      return { ...base, ...aiOnly, loop_group: data.loop_group } as LoopGroupNode;
    }
    // loop — guaranteed by superRefine to be defined at this point.
    // Unlike the rest of aiOnly (dropped for loops — model/provider inherit from
    // the workflow level), `pi` posture IS kept: the loop's per-iteration Pi
    // sendQuery is exactly where plannotator planning mode leaks (#2073/#2133),
    // so the portable `pi:` block must reach it. Excluded from LOOP_NODE_AI_FIELDS
    // so the loader doesn't warn it's ignored.
    if (!data.loop) throw new Error('unreachable: loop must be defined after superRefine');
    return {
      ...base,
      ...(data.pi !== undefined ? { pi: data.pi } : {}),
      loop: data.loop,
    } as LoopNode;
  })
  .openapi('DagNode');

// ---------------------------------------------------------------------------
// Type guards (preserved from original types.ts)
// ---------------------------------------------------------------------------

/** Type guard: check if a DAG node is a command (named command file) node */
export function isCommandNode(node: DagNode): node is CommandNode {
  return 'command' in node && typeof node.command === 'string';
}

/** Type guard: check if a DAG node is a bash (shell script) node */
export function isBashNode(node: DagNode): node is BashNode {
  return 'bash' in node && typeof node.bash === 'string';
}

/** Type guard: check if a DAG node is a loop (iterative) node */
export function isLoopNode(node: DagNode): node is LoopNode {
  return 'loop' in node && typeof node.loop === 'object' && node.loop !== null;
}

/** Type guard: check if a DAG node is a loop_group (cross-node iterative subgraph) node */
export function isLoopGroupNode(node: DagNode): node is LoopGroupNode {
  return 'loop_group' in node && typeof node.loop_group === 'object' && node.loop_group !== null;
}

/** Type guard: check if a DAG node is an approval (human-in-the-loop) node */
export function isApprovalNode(node: DagNode): node is ApprovalNode {
  return 'approval' in node && typeof node.approval === 'object' && node.approval !== null;
}

/** Type guard: check if a DAG node is a cancel (workflow termination) node */
export function isCancelNode(node: DagNode): node is CancelNode {
  return 'cancel' in node && typeof node.cancel === 'string';
}

/** Type guard: check if a DAG node is a script node */
export function isScriptNode(node: DagNode): node is ScriptNode {
  return 'script' in node && typeof node.script === 'string';
}

/** Type guard: check if a DAG node is an include (load-time inlining) node */
export function isIncludeNode(node: DagNode): node is IncludeNode {
  return 'include' in node && typeof node.include === 'string';
}

/** Type guard: check if a DAG node is a workflow (runtime sub-run) node */
export function isWorkflowNode(node: DagNode): node is WorkflowNode {
  return 'workflow' in node && typeof node.workflow === 'string';
}

/** Type guard: validates a value is a known TriggerRule */
export function isTriggerRule(value: unknown): value is TriggerRule {
  return typeof value === 'string' && (TRIGGER_RULES as readonly string[]).includes(value);
}

/**
 * True for node types that invoke a provider and therefore participate in cross-run
 * session persistence (`persist_session`). bash, script, approval, cancel, loop,
 * loop_group, and include nodes are excluded — they either make no provider call, manage
 * their own per-iteration sessions, or (include) are expanded away before execution.
 * Shared by the loader's load-time capability gate and any other caller that needs to
 * reason about persistence eligibility, so the exclusion list lives in one place.
 */
export function isPersistableNode(node: DagNode): boolean {
  return (
    !isLoopNode(node) &&
    !isLoopGroupNode(node) &&
    !isApprovalNode(node) &&
    !isCancelNode(node) &&
    !isScriptNode(node) &&
    !isBashNode(node) &&
    !isIncludeNode(node) &&
    !isWorkflowNode(node)
  );
}

// ---------------------------------------------------------------------------
// Nested known-key registry — declared AFTER dagNodeSchema on purpose
// ---------------------------------------------------------------------------
//
// Reading `loopGroupNodeConfigSchema.shape` fires its `nodes` getter, which
// builds `z.array(dagNodeSchema)`. Placed above `dagNodeSchema` this throws
// `ReferenceError: Cannot access 'dagNodeSchema' before initialization` at
// import time — a temporal dead zone tsc does not catch. Keep this block below
// `dagNodeSchema`; see the note on `loopGroupShape` for the full mechanism.
/**
 * Known-key description for a nested config object, one level at a time.
 *
 * `object` — a fixed shape; `keys` are the accepted keys and `children`
 *            describes object-valued keys inside it (e.g. `approval.on_reject`).
 * `record` — author-chosen keys (e.g. `agents`, whose keys are agent ids); only
 *            the VALUES have a fixed shape, described by `entry`.
 */
export type NestedKeySpec =
  | {
      readonly kind: 'object';
      readonly keys: ReadonlySet<string>;
      readonly children?: ReadonlyMap<string, NestedKeySpec>;
    }
  | { readonly kind: 'record'; readonly entry: NestedKeySpec };

/**
 * `loopGroupNodeConfigSchema` carries a `z.ZodType<…>` annotation to break the
 * recursion cycle, which hides `.shape` at the TYPE level only — the runtime
 * value is still the `ZodObject` that `loopControlSchema.extend()` produced.
 * Casting back recovers the real shape, so the key set stays derived instead of
 * being a hand-written `[...loopControl, 'nodes']` that a future body field
 * would silently fall out of.
 *
 * DO NOT MOVE THIS ABOVE `dagNodeSchema`. This line is evaluated at module load,
 * and reading that `.shape` fires the schema's `nodes` getter, which builds
 * `z.array(dagNodeSchema)`. Above `dagNodeSchema`'s declaration that is a
 * temporal dead zone: the module throws
 * `ReferenceError: Cannot access 'dagNodeSchema' before initialization` on
 * import, so every test that imports this file dies at load rather than failing
 * an assertion.
 *
 * tsc does NOT catch it — the cast type-checks cleanly either way, which is why
 * moving this registry up beside the `NestedKeySpec` type it belongs with (the
 * natural tidy) is a silent break. The constraint is ordering, not position:
 * this block and `KNOWN_NODE_NESTED_KEYS` below it must be declared AFTER
 * `dagNodeSchema`. They sit at the end of the file only because nothing else
 * needs to follow them — new code may be appended below without moving them.
 */
const loopGroupShape = (loopGroupNodeConfigSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;

/**
 * Known keys for the nested config objects a node can carry, keyed by the node
 * field that holds them. Derived from each sub-schema's shape so a new field
 * cannot drift out of the set.
 *
 * Absent on purpose — these node fields do not silently strip, so there is
 * nothing to warn about:
 *   `output_format` — free-form JSON Schema (`z.record`); every key is accepted
 *   `sandbox`       — `.passthrough()`; unknown keys are preserved, not dropped
 *   `hooks`         — `.strict()`; unknown keys already hard-error at parse time
 *   `thinking`      — `z.preprocess` over a union; no object shape to compare
 *
 * `loop_group.nodes` is deliberately not modelled here: its entries are full DAG
 * nodes, so the loader recurses into them with KNOWN_DAG_NODE_KEYS instead.
 *
 * Constructed with `keyof typeof dagNodeFlatSchema.shape` as the key type, not
 * `string`: a typo'd registration (`'aproval'`) would otherwise compile and
 * silently disable that nested check forever, indistinguishable from "this
 * field needs no spec". The exported type widens the key back to `string` so
 * callers can look up an arbitrary YAML key without a cast — the constraint is
 * on what can be REGISTERED, which is where drift would come from.
 */
export const KNOWN_NODE_NESTED_KEYS: ReadonlyMap<string, NestedKeySpec> = new Map<
  keyof typeof dagNodeFlatSchema.shape,
  NestedKeySpec
>([
  [
    'approval',
    {
      kind: 'object',
      keys: new Set(Object.keys(approvalConfigSchema.shape)),
      // Same typo protection one level down: keyed by the parent's shape, so
      // `'on_rejct'` is a compile error rather than a silently disabled check.
      children: new Map<keyof typeof approvalConfigSchema.shape, NestedKeySpec>([
        ['on_reject', { kind: 'object', keys: new Set(Object.keys(approvalOnRejectSchema.shape)) }],
      ]),
    },
  ],
  ['retry', { kind: 'object', keys: new Set(Object.keys(stepRetryConfigSchema.shape)) }],
  ['loop', { kind: 'object', keys: new Set(Object.keys(loopNodeConfigSchema.shape)) }],
  ['loop_group', { kind: 'object', keys: new Set(Object.keys(loopGroupShape)) }],
  ['pi', { kind: 'object', keys: new Set(Object.keys(piNodeConfigSchema.shape)) }],
  ['fan_out', { kind: 'object', keys: new Set(Object.keys(fanOutConfigSchema.shape)) }],
  // `agents` keys are author-chosen agent ids; each VALUE is an agentDefinition,
  // where a camelCase slip (`disallowed_tools`) silently drops a tool restriction.
  [
    'agents',
    {
      kind: 'record',
      entry: { kind: 'object', keys: new Set(Object.keys(agentDefinitionSchema.shape)) },
    },
  ],
]);
