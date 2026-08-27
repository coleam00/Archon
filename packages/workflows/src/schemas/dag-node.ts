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
import { EFFORT_LADDER } from '@archon/providers/effort';
import { stepRetryConfigSchema } from './retry';
// Runtime import, but cycle-free: output-ref's only edge back into schemas is a
// type-only `NodeOutput`, which is erased. Reused rather than reimplemented so
// `loop.until_field` and the strict `$node.output.field` access agree on what
// counts as a declared property — a second definition could drift into accepting
// a name that consumers then reject. `jsonValueSchema`/`parseWholeOutputRef`
// come from the same module for the same reason: one value type and one ref
// grammar, everywhere (#2637).
import {
  declaredFieldsFromSchema,
  jsonValueSchema,
  parseWholeOutputRef,
  parseWholeInputsRef,
  OUTPUT_REF_SOURCE,
  INPUT_NAME_SOURCE,
  type JsonValue,
} from '../output-ref';
import {
  BASE_COMPLETION_CHANNELS,
  addMissingChannelIssue,
  loopNodeConfigSchema,
  loopControlSchema,
  type LoopControl,
} from './loop';
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

/**
 * Reasoning depth — the one spelling, on every provider that has the control
 * (#2556). The vocabulary is the union of the effort-capable SDKs' enums, and
 * a provider clamps a rung it doesn't offer to the nearest one it does
 * (`clampEffort` in @archon/providers): Pi takes all six, while `max` → `xhigh`
 * on Codex/Copilot and `minimal` → `low` on Claude/Copilot. Derived from `EFFORT_LADDER` rather than
 * restated, so the YAML enum and the clamp cannot disagree.
 */
export const effortLevelSchema = z.enum(EFFORT_LADDER);

export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Canonical list of effort levels — derived from schema, do not duplicate. */
export const EFFORT_LEVELS: readonly EffortLevel[] = effortLevelSchema.options;

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
 * because that module is not reachable from here. The constraint is SDK-free,
 * not type-only: @archon/workflows may import runtime values from a leaf subpath
 * with no SDK dependencies (@archon/providers/types, @archon/providers/effort —
 * see EFFORT_LADDER at the top of this file), but `pi/config` pulls in the Pi
 * SDK, so this shape stays mirrored.
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

export const nodeContextResumeSchema = z.object({
  resume: z.string().trim().min(1, "'context.resume' must name a node"),
});

export const nodeContextSchema = z.union([z.enum(['fresh', 'shared']), nodeContextResumeSchema]);

export type NodeContext = z.infer<typeof nodeContextSchema>;

export function isNodeContextResume(
  context: NodeContext | undefined
): context is { resume: string } {
  return typeof context === 'object' && context !== null && 'resume' in context;
}

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
  context: nodeContextSchema.optional(),
  output_format: z.record(z.string(), z.unknown()).optional(),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
  idle_timeout: z.number().optional(),
  retry: stepRetryConfigSchema.optional(),
  hooks: workflowNodeHooksSchema.optional(),
  mcp: z.string().min(1, "'mcp' must be a non-empty string path").optional(),
  skills: z.array(z.string().min(1, 'each skill must be a non-empty string')).optional(),
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
  // Post-run tree-integrity assertion (#2771): when explicitly `false`, the engine
  // snapshots the git working tree before the node runs and fails the node with an
  // error naming it if the snapshot changed — outside the run's engine-owned
  // directories (artifacts/state/logs). Enforced for exec and agent nodes; warned
  // as ignored on wait and workflow (sub-run) nodes, whose execution is not a
  // single checkout-scoped payload. Absent means no enforcement.
  mutates_checkout: z.boolean().optional(),
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

/**
 * Node-local binding directive (#2637) — the explicit form of a `with:` value on a
 * `command:`/`script:` node that reads an upstream output across a possibly-skipped
 * branch. `from` must be exactly one whole `$node.output[.field]` reference; when the
 * producer was skipped, the binding takes `if_skipped` instead — and without one, the
 * consuming node fails loudly (never a silent `''`).
 *
 * On command/script `with:` maps, a plain OBJECT value is ALWAYS parsed as this
 * directive (any other object shape is a load error naming both accepted forms) —
 * reserving the object position removes the literal-vs-directive grammar ambiguity
 * without a `$literal` escape. Include/workflow `with:` maps have no directive, so
 * objects there stay ordinary JSON literals.
 */
export const bindingDirectiveSchema = z.strictObject({
  from: z.string().min(1, "'from' must be a non-empty $node.output reference"),
  if_skipped: jsonValueSchema.optional(),
});

export type BindingDirective = z.infer<typeof bindingDirectiveSchema>;

/**
 * Runtime guard for a command/script `with:` value: loader-validated maps only ever
 * hold a directive in object position, but programmatic definitions bypass the
 * loader, so the executor re-checks the discriminating shape before trusting it.
 */
export function isBindingDirective(value: unknown): value is BindingDirective {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).from === 'string'
  );
}

/**
 * Where an agent node's prompt text comes from — inline in the YAML, or a named
 * command file resolved at execution time (`loadCommandPrompt`, dag-executor.ts).
 * A real nested discriminated union rather than two optional sibling fields: it is
 * what makes `with:` on an inline-sourced node a TYPE ERROR instead of a value that
 * silently parses and is dropped (#2478) — `with:` only exists on the 'command'
 * variant, because only a command file has a `$INPUTS.<name>` surface for it to bind
 * into. Precedent for this shape: `nodeContextSchema` above.
 */
export const promptSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), prompt: z.string() }),
  z.object({
    kind: z.literal('command'),
    name: z.string(),
    // Node-local named bindings (#2637): values delivered to the command file's
    // `$INPUTS.<name>` surface. Strings may hold refs/templates; a whole
    // `$node.output[.field]` ref passes the logical value; objects are binding
    // directives ({ from, if_skipped }) — validated in dagNodeSchema's superRefine.
    with: z.record(z.string(), z.union([jsonValueSchema, bindingDirectiveSchema])).optional(),
  }),
]);

export type PromptSource = z.infer<typeof promptSourceSchema>;

/**
 * `command:` + `prompt:` collapsed into one body kind (#2486). Both land in the
 * same execution dispatch (`executeAgentNode`, formerly `executeNodeInternal`) —
 * the only divergence between them is where the prompt text comes from, which
 * `source` now expresses directly instead of via which top-level field is set.
 */
export const agentNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('agent'),
  source: promptSourceSchema,
});

/** DAG node that runs an AI prompt — inline, or loaded from a named command file */
export type AgentNode = z.infer<typeof agentNodeSchema>;

/**
 * `bash:` + `script:` collapsed into one body kind (#2486) at the TYPE level —
 * one `ExecNode` shape, discriminated by `runtime`. `bash:` becomes
 * `runtime: 'sh'`; `deps`/`with` are only ever populated by the transform for a
 * `script:` input (a `bash:` input never sets them, matching today's `BashNode`
 * behavior — see `dagNodeSchema`'s transform).
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 *
 * The EXECUTOR deliberately did not follow this collapse: `executeBashNode`/
 * `executeScriptNode` in dag-executor.ts stay two separate functions rather than
 * one `executeExecNode` branching on `runtime` (#2718, decided after a full
 * side-by-side read of both, 222 + 323 = 545 lines). The two are not thin
 * wrappers around one shell-out — real, non-superficial differences: output-ref
 * substitution (shell-escaped + artifacts-dir-aware for bash vs. raw splice for
 * script), `deps:`/named-script-file resolution (script-only), and per-runtime
 * error diagnostics. `$LOOP_USER_INPUT` delivery is NOT a script-only concept —
 * both runtimes deliver it via env (#2725); bash additionally gets the literal
 * `$LOOP_USER_INPUT` token pre-spliced (shell-quoted) into its source by
 * `applyLoopPrevToBodyNode`, a channel script has no equivalent of. A "merge but
 * keep behavior byte-identical" refactor would relocate rather than remove that
 * complexity, while unifying the ~230 lines of near-identical scaffolding (event
 * emission/persistence, retry wiring, error formatting) into one function risks
 * a regression that touches every deterministic node in every workflow at once —
 * today a bug in one runtime's path can't touch the other. Two bugs the read
 * surfaced along the way (`executeBashNode`'s own env channel for
 * `$LOOP_USER_INPUT` was unwired, so a `bash:` loop_group body node reading it
 * indirectly — `${LOOP_USER_INPUT}`, `printenv`, `env` — always saw an empty
 * value even though the literal-token splice worked; and `script:` node output
 * never getting the truncation cap `bash:` gets) are real independently-evolved
 * drift, not evidence for merging — they're filed as their own fixes, #2725 and
 * #2726, rather than folded into this call.
 */
export const execNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('exec'),
  script: z.string().min(1, 'script cannot be empty'),
  runtime: z.enum(['sh', 'bun', 'uv']),
  deps: z.array(z.string().min(1, 'each dep must be a non-empty string')).optional(),
  timeout: z.number().optional(),
  // Node-local named bindings (#2637): delivered as INPUTS_<UPPER_SNAKE> env vars.
  // Same value grammar as an agent node's command-sourced `with:`. Only meaningful
  // (and only ever populated) when `runtime !== 'sh'`.
  with: z.record(z.string(), z.union([jsonValueSchema, bindingDirectiveSchema])).optional(),
});

/** DAG node that runs a shell script, or a TypeScript/Python script via bun or uv, without AI */
export type ExecNode = z.infer<typeof execNodeSchema>;

/**
 * Loop node schema — extends base with `loop` config.
 * AI-specific fields from the base are present in the type but ignored at runtime with a warning.
 * retry is not supported on loop nodes (enforced at parse time).
 */
export const loopNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('loop'),
  loop: loopNodeConfigSchema,
});

/** DAG node that runs an AI prompt in a loop until a completion condition is met */
export type LoopNode = z.infer<typeof loopNodeSchema>;

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
  /**
   * Sub-DAG body re-executed in full each iteration. At least one node required.
   * Widened to admit `IncludeDirective` because `dagNodeSchema` (below) parses to
   * `DagNode | IncludeDirective` at this pre-expansion stage — a loop_group body
   * may itself contain an `include:` directive, expanded away by the same
   * `expandWorkflowIncludes` pass that handles top-level nodes (#2486).
   */
  nodes: (DagNode | IncludeDirective)[];
};
export const loopGroupNodeConfigSchema: z.ZodType<LoopGroupNodeConfig> = loopControlSchema
  .extend({
    /** Sub-DAG body re-executed in full each iteration. At least one node required. */
    get nodes(): z.ZodArray<typeof dagNodeSchema> {
      return z.array(dagNodeSchema).min(1, "'loop_group.nodes' must have at least one node");
    },
  })
  // A group has TWO completion channels; `loop:` has three (`until_field` is
  // loop-only — see its field docs). The rule therefore lives on each variant
  // rather than on the shared control schema. Adding `.superRefine` keeps `.shape`
  // readable in zod v4, which `loopGroupShape` below depends on.
  .superRefine((data, ctx) => {
    addMissingChannelIssue(
      ctx,
      [data.until, data.until_bash].filter(v => v !== undefined),
      BASE_COMPLETION_CHANNELS
    );
  });

/**
 * Loop-group node schema — extends base with `loop_group` config (iteration control + body).
 * Like `loop:`, AI-specific base fields are ignored at runtime with a warning, and `retry`
 * is not supported (the loop manages its own iteration). `model`/`provider` are forwarded
 * to body AI nodes unless overridden per-node (same forwarding `loop:` uses).
 */
export const loopGroupNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('loop_group'),
  loop_group: loopGroupNodeConfigSchema,
});

/** DAG node that runs a multi-node sub-DAG in a loop until a completion condition is met */
export type LoopGroupNode = z.infer<typeof loopGroupNodeSchema>;

/** Schema for the `on_reject` sub-object on approval nodes. */
export const approvalOnRejectSchema = z.object({
  prompt: z.string().min(1, "'on_reject.prompt' must be a non-empty string"),
  max_attempts: z.number().int().min(1).max(10).optional(),
});

export type ApprovalOnReject = z.infer<typeof approvalOnRejectSchema>;

/**
 * An author-declared decision on the `approval.decisions:` surface (#2707
 * step 1). `id` is an author-chosen identifier — reachable from every drive
 * surface via `workflow respond <run-id> <decision> [text]` (#2707 step 2);
 * `approve`/`reject` remain the default-vocabulary sugar every surface's
 * dedicated approve/reject path still speaks. `decisions` must still include
 * an `approve` entry (enforced in `dagNodeSchema`'s `superRefine`). `label` is
 * purely cosmetic display text; the wire value the gate outputs as
 * `$<id>.output.decision` is always the `id`, never the label.
 *
 * `id` is constrained to `AGENT_ID_REGEX`'s kebab-case grammar (no embedded
 * whitespace) rather than an open string: the CLI's `respond` command takes
 * `decision` as one whitespace-delimited positional token, so an id like
 * `'needs revision'` would parse as `decision='needs'`, `text='revision'` —
 * not the declared id — on every unquoted invocation. `label` already exists
 * to carry a spaced, human-readable form for display.
 */
export const approvalDecisionConfigSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "'approval.decisions[].id' must not be empty")
    .regex(
      AGENT_ID_REGEX,
      "'approval.decisions[].id' must be kebab-case (lowercase letters, digits, single hyphens — e.g. 'approve', 'needs-revision')"
    ),
  label: z.string().min(1).optional(),
});

/**
 * Schema for the `approval:` config object. Named (rather than inlined at both
 * use sites) so its shape is reachable for the unknown-key check in the loader.
 *
 * `decisions` and `on_reject` are mutually exclusive: `on_reject` is the
 * deprecated legacy mechanism (a stored rework template with a private
 * attempt counter, kept working byte-for-byte for backward compatibility —
 * see `decisionOptionSchema`'s doc); `decisions` is its replacement (ordinary
 * structured `{decision,text}` output, with any rework/revise flow wired by
 * the author as an explicit `when:` edge to their own node). Declaring both
 * would leave it ambiguous which mechanism resolves the gate — validated in
 * `dagNodeSchema`'s top-level `superRefine` (alongside `hasApproval`), not
 * here, so this stays a plain `z.object` and keeps its precise `.shape` for
 * `KNOWN_NODE_NESTED_KEYS`'s compile-time-checked child-key map (a
 * `.superRefine()`-wrapped schema would erase that precision — see
 * `loopGroupShape`'s cast at the bottom of this file for what that costs).
 */
export const approvalConfigSchema = z.object({
  message: z.string().min(1, "'approval.message' must not be empty"),
  decisions: z
    .array(approvalDecisionConfigSchema)
    .min(1, "'approval.decisions' must declare at least one decision")
    .optional(),
  capture_response: z.boolean().optional(),
  on_reject: approvalOnRejectSchema.optional(),
});

/**
 * A decision a resolved gate node can produce. `rework` carries the legacy
 * `on_reject` behavior (a rework prompt with a max-attempts counter) as a
 * per-decision continuation — it is populated EXCLUSIVELY by `dagNodeSchema`'s
 * transform when translating a deprecated `on_reject:` config, and is never
 * part of the new `approval.decisions:` authoring surface
 * (`approvalDecisionConfigSchema` has no `rework` field, so an author cannot
 * write one directly).
 */
export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  rework: z
    .object({
      prompt: z.string().min(1),
      maxAttempts: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;

/**
 * Gate node schema (formerly `approval:`) — pauses the workflow for human review.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 *
 * `decisionsAuthored` is the ONE signal that switches a gate into the new
 * structured-output mechanism (#2707 step 1): true only when the author wrote
 * `approval.decisions:` explicitly in YAML. `decisions` itself is always
 * populated (synthesized default pair, `on_reject`-translated pair, or the
 * authored array), so it stays uniform for message-building/preflight/
 * substitution code that doesn't care which mode produced it — only
 * approve/reject resolution branches on `decisionsAuthored`.
 *
 * This is deliberately narrower than "no `on_reject` configured": before this
 * PR, `approval.decisions:` did not exist, so no already-authored workflow —
 * bundled or custom — can have written it. Keying the new output shape and
 * reject's non-terminal resolution on this exact field is what guarantees
 * every pre-existing gate (the omitted-decisions default, with or without
 * `capture_response`) keeps its EXACT pre-PR behavior: plain/empty output,
 * reject always cancels. Only a gate an author positively rewrites to declare
 * `decisions:` gets the new mechanism.
 */
export const gateNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('gate'),
  message: z.string(),
  decisions: z.array(decisionOptionSchema),
  decisionsAuthored: z.boolean(),
  captureResponse: z.boolean(),
});

/** DAG node that pauses workflow execution for human approval */
export type GateNode = z.infer<typeof gateNodeSchema>;

/**
 * Halt node schema (formerly `cancel:`) — terminates the workflow run with a reason string.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 */
export const haltNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('halt'),
  reason: z.string().min(1, "'cancel' reason must not be empty"),
});

/** DAG node that cancels the workflow run with a reason string */
export type HaltNode = z.infer<typeof haltNodeSchema>;

/** Engine-visible condition that may suspend a run without occupying a worker slot. */
export const MAX_DURABLE_WAIT_MS = 1_000 * 365 * 24 * 60 * 60 * 1_000;

export const waitConfigFlatSchema = z.object({
  duration_ms: z.number().int().positive().max(MAX_DURABLE_WAIT_MS).optional(),
  until: z.string().min(1, "'wait.until' must not be empty").optional(),
  event: z.string().trim().min(1, "'wait.event' must not be empty").optional(),
  deadline_ms: z.number().int().positive().max(MAX_DURABLE_WAIT_MS).optional(),
});
export const waitUntilTimestampSchema = z.string().datetime();
const waitUntilValueSchema = z
  .string()
  .min(1, "'wait.until' must not be empty")
  .refine(
    value =>
      new RegExp(OUTPUT_REF_SOURCE).test(value) ||
      parseWholeInputsRef(value) !== undefined ||
      waitUntilTimestampSchema.safeParse(value).success,
    "'wait.until' must be an ISO-8601 timestamp or contain a runtime reference"
  );

// The transforms preserve the validated wire shape while making sibling fields
// `never` in the inferred type, so widened programmatic objects cannot combine variants.
export const waitConfigSchema = z.union([
  z
    .strictObject({ duration_ms: z.number().int().positive().max(MAX_DURABLE_WAIT_MS) })
    .transform(
      value => value as typeof value & { until?: never; event?: never; deadline_ms?: never }
    ),
  z
    .strictObject({ until: waitUntilValueSchema })
    .transform(
      value => value as typeof value & { duration_ms?: never; event?: never; deadline_ms?: never }
    ),
  z
    .strictObject({
      event: z.string().trim().min(1, "'wait.event' must not be empty"),
      deadline_ms: z.number().int().positive().max(MAX_DURABLE_WAIT_MS),
    })
    .transform(value => value as typeof value & { duration_ms?: never; until?: never }),
]);
export type WaitConfig = z.infer<typeof waitConfigSchema>;

/** Validated engine condition used for exhaustive wait execution. */
export type WaitCondition =
  | { kind: 'duration'; durationMs: number }
  | { kind: 'until'; timestamp: string }
  | { kind: 'event'; event: string; deadlineMs: number };

export function waitCondition(config: WaitConfig): WaitCondition {
  if (config.duration_ms !== undefined) {
    return { kind: 'duration', durationMs: config.duration_ms };
  }
  if (config.until !== undefined) {
    return { kind: 'until', timestamp: config.until };
  }
  return { kind: 'event', event: config.event, deadlineMs: config.deadline_ms };
}

export const workflowWaitResultSchema = z.object({
  status: z.enum(['satisfied', 'expired']),
  waited_ms: z.number().nonnegative(),
  event: z.string().optional(),
  payload: z.unknown().optional(),
});
export type WorkflowWaitResult = z.infer<typeof workflowWaitResultSchema>;

export const WAIT_NODE_OUTPUT_FORMAT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['satisfied', 'expired'] },
    waited_ms: { type: 'number' },
    event: { type: 'string' },
    payload: {},
  },
  required: ['status', 'waited_ms'],
  additionalProperties: false,
} as const;

export const waitNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('wait'),
  wait: waitConfigSchema,
});
export type WaitNode = z.infer<typeof waitNodeSchema>;

/**
 * Identifier grammar for an include input name.
 *
 * Shared deliberately with every `$INPUTS.<name>` reference pattern (include-expander,
 * executor-shared, and the whole-ref parser in output-ref), which all build from this
 * source. They encode the identical concept and the drift between them is
 * one-directional and silent: loosening this validator alone would
 * let `with: {my.key: v}` pass while `$INPUTS.my.key` matches only `$INPUTS.my`, leaving
 * `.key` as trailing literal text in the prompt. (The reverse drift fails loudly at load,
 * because the matching `with:` key would be rejected here.) Sharing one source removes the
 * dangerous direction. This is scoped to that family only — the similar-looking node-id
 * grammar elsewhere in the tree encodes a different concept and stays separate.
 *
 * The source itself lives in output-ref.ts beside OUTPUT_REF_SOURCE (one home for
 * every ref grammar); re-exported here so schema-side validators keep their import.
 */
export { INPUT_NAME_SOURCE };
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
/**
 * Include directive schema — a load-time-only graph-construction directive, not a
 * `DagNode` (#2486). It carries no execution surface of its own: `include` is the
 * target workflow name, `with` is its load-time input mapping, and the structural
 * graph fields (id / depends_on / when / trigger_rule) attach the expanded sub-DAG.
 * `expandWorkflowIncludes` (include-expander.ts) consumes every `IncludeDirective`
 * at discovery time; by the time a `WorkflowDefinition` reaches the executor, none
 * survive — `dag-executor.ts` asserts this defensively rather than dispatching on it,
 * since `IncludeDirective` is not a member of the `DagNode` union it type-checks against.
 */
export const includeDirectiveSchema = dagNodeBaseSchema
  .pick({
    id: true,
    description: true,
    depends_on: true,
    when: true,
    trigger_rule: true,
  })
  .extend({
    kind: z.literal('include'),
    include: z.string().min(1, "'include' must be a non-empty workflow name"),
    // JSON-compatible input values (#2637): strings splice into text surfaces via
    // the load-time macro; non-string values keep their logical type through the
    // declared-input contract and canonicalize to JSON text where spliced.
    with: z.record(z.string(), jsonValueSchema).optional(),
  });

/** Load-time-only graph-construction directive — inlines another workflow's nodes at discovery time */
export type IncludeDirective = z.infer<typeof includeDirectiveSchema>;

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
 *      cancelled entries are represented as `{ archon_failed: true, error, status }`
 *      marker objects in the array (`archon_failed` is the reserved discriminator —
 *      a structured child's own payload may legitimately carry `error`/`status`).
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

/** Composed fan-out always names the item binding; it has no `$ARGUMENTS` fallback. */
export const composeFanOutConfigSchema = fanOutConfigSchema.extend({
  as: z
    .string()
    .min(1, "'fan_out.as' is required on an include node and must be a non-empty input name"),
});

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
  kind: z.literal('workflow'),
  workflow: z.string().min(1, "'workflow' must be a non-empty workflow name"),
  input: z.string().optional(),
  // Named inputs passed to the child sub-run as `$INPUTS.<name>` (#2470). Mutually
  // exclusive with `input:`. Same identifier-keyed JSON-value map as `include.with`
  // (#2637): non-string values reach the child with their logical type.
  with: z.record(z.string(), jsonValueSchema).optional(),
  isolation: z.enum(['inherit', 'worktree']).optional(),
  fan_out: fanOutConfigSchema.optional(),
});

/** DAG node that runs another workflow as a governed child sub-run at execution time */
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

/**
 * Deferred composition fan-out (#2512) — an `include:` node that also declares
 * `fan_out:`. Unlike a plain `IncludeDirective` it is NOT expanded away at load time:
 * the item list is runtime data, so the width of the expansion is unknowable until
 * execution. `expandWorkflowIncludes` leaves the node in place (validating the target
 * name resolves) and the executor expands the target once per item at run time through
 * the same expander, under a per-instance `<nodeId>__<identity>` namespace — one parent
 * run row, events under the parent's id, no child runs.
 *
 * Deliberately NOT spelled `workflow:` + `fan_out:` (the issue's illustrative YAML is
 * declared non-final): that spelling already means governed per-item child runs, and
 * re-purposing it would silently reinterpret live workflows the issue requires be
 * "continued safely ... not silently converted".
 */
export const composeFanOutNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('compose_fan_out'),
  include: z.string().min(1, "'include' must be a non-empty workflow name"),
  with: z.record(z.string(), jsonValueSchema).optional(),
  fan_out: composeFanOutConfigSchema,
});

export type ComposeFanOutNode = z.infer<typeof composeFanOutNodeSchema>;

/** Type guard: check if a node is a runtime-width composed fan-out (include + fan_out) */
export function isComposeFanOutNode(node: DagNode | IncludeDirective): node is ComposeFanOutNode {
  return node.kind === 'compose_fan_out';
}

/**
 * A single executable node in a DAG workflow, discriminated on `kind` (#2486).
 * `command:`/`prompt:` collapse into `'agent'`; `bash:`/`script:` collapse into
 * `'exec'`. `include:` is NOT a member — it has no execution surface and is fully
 * expanded away by `expandWorkflowIncludes` before a `DagNode[]` reaches the
 * executor (see `IncludeDirective`).
 */
export type DagNode =
  | AgentNode
  | ExecNode
  | GateNode
  | HaltNode
  | WaitNode
  | LoopNode
  | LoopGroupNode
  | WorkflowNode
  | ComposeFanOutNode;

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
 * leak, #2073). `output_format` is excluded for the same class of reason (#2563):
 * a `loop:` node makes its own sendQuery, so the schema reaches the provider, each
 * iteration's payload is validated against it, and `loop.until_field` can terminate
 * on a declared boolean. It stays listed for `loop_group`, which never calls
 * sendQuery — its body nodes carry their own.
 */
export const LOOP_NODE_AI_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS.filter(
    f => f !== 'model' && f !== 'provider' && f !== 'pi' && f !== 'output_format'
  ),
  // The tree-integrity assertion (#2771) is enforced only on exec/agent nodes; on a
  // loop it would have to cover every iteration's body, which no execution path does.
  'mutates_checkout',
];

/**
 * AI-specific fields that are unsupported on loop_group nodes. `model`/`provider`
 * are forwarded to each body AI node (overridable per-node), so they remain
 * meaningful at the group level. `pi` is NOT forwarded — the group never calls
 * sendQuery, and body nodes carry their own `pi:` block — so it's warned as
 * ignored here (unlike on a plain `loop:` node, which does sendQuery itself).
 */
export const LOOP_GROUP_NODE_AI_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS.filter(f => f !== 'model' && f !== 'provider'),
  // Same as `loop:` above — body-node enforcement is the only real coverage.
  'mutates_checkout',
];

/**
 * Fields ignored on gate (approval) and halt (cancel) nodes — they make no provider
 * call and execute nothing, so every AI-turn field is inert, and
 * `mutates_checkout` (#2771) has no enforcement site for them either.
 */
export const GATE_AND_HALT_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS,
  'mutates_checkout',
];

/** Fields a wait cannot consume; its output contract and lifecycle are engine-owned. */
export const WAIT_NODE_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS.filter(field => field !== 'output_format'),
  'idle_timeout',
  // The tree-integrity assertion is enforced only on exec/agent nodes (#2771); a
  // wait's lifecycle is engine-owned and touches no checkout-scoped payload.
  'mutates_checkout',
];

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
// `mutates_checkout` is appended rather than filtered out: enforcement (#2771) is
// per-node over the parent checkout, which a sub-run child does not own — its own
// workflow-level declaration governs instead.
export const WORKFLOW_NODE_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS.filter(f => f !== 'output_format'),
  'mutates_checkout',
];

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
  wait: waitConfigSchema.optional(),
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
  // Dynamic fan-out (slice 2, PR-C) — expand a node over a data-driven item list. On a
  // `workflow:` node it multiplies child runs (#2121 slice 2); on an `include:` node it
  // multiplies the composed body inside this run (#2512). Guarded in superRefine.
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
    const hasWait = data.wait !== undefined;
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
      hasWait,
      hasCancel,
      hasScript,
      hasInclude,
      hasWorkflow,
    ].filter(Boolean).length;

    if (modeCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'command', 'prompt', 'bash', 'loop', 'loop_group', 'approval', 'wait', 'cancel', 'script', 'include', and 'workflow' are mutually exclusive",
      });
      return z.NEVER;
    }

    // 'decisions' (#2707 step 1, the new authoring surface) and 'on_reject' (the
    // deprecated legacy mechanism) are mutually exclusive: mixing them would
    // leave it ambiguous which mechanism resolves the gate. Validated here
    // rather than via a superRefine on approvalConfigSchema itself, which would
    // wrap it in a ZodEffects and erase the precise `.shape` KNOWN_NODE_NESTED_KEYS
    // relies on for compile-time-checked child keys (see approvalConfigSchema's doc).
    if (hasApproval && data.approval) {
      if (data.approval.decisions !== undefined && data.approval.on_reject !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "'approval.decisions' and 'approval.on_reject' are mutually exclusive. " +
            "'on_reject' is deprecated — wire a rework node with a " +
            "\"when: \\\"$<this gate's id>.output.decision == 'reject'\\\"\" edge and declare 'decisions' instead.",
          path: ['approval', 'decisions'],
        });
      } else if (data.approval.decisions !== undefined) {
        const ids = data.approval.decisions.map(d => d.id);
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "'approval.decisions' ids must be unique",
            path: ['approval', 'decisions'],
          });
        }
        // 'reject' is optional (an approve-only "acknowledge" gate is valid —
        // rejectWorkflow falls back to cancelling when no 'reject' id is
        // declared), but 'approve' must always be reachable: without it,
        // `workflow approve <id>` would still "succeed" and write a permanent
        // approval_decision:'approved' audit event for an outcome the gate's
        // own declared vocabulary says can never occur. Fail at load time
        // instead of leaving that as a silent runtime footgun.
        if (!ids.includes('approve')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "'approval.decisions' must include an 'approve' entry",
            path: ['approval', 'decisions'],
          });
        }
      }
    }

    if (isNodeContextResume(data.context) && !hasCommand && !hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'context.resume' is only supported on command and prompt nodes",
        path: ['context'],
      });
    }

    // `with:` is an identifier-keyed JSON-value map on include and workflow nodes
    // (#2470, values widened from string-only in #2637). For includes it inlines at
    // load time (applyInputsMacro); for sub-runs it becomes `$INPUTS.<name>` runtime
    // variables on the child. The flat field stays `z.unknown()` so other node
    // variants validate it contextually. Returns the validated plain-object map, or
    // undefined when the surrounding shape is wrong (issues already added).
    const validateWithShape = (
      kind: 'include' | 'workflow' | 'command' | 'script'
    ): Record<string, unknown> | undefined => {
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
          message: `'with' on ${kind} nodes must be an object mapping input names to values`,
          path: ['with'],
        });
        return undefined;
      }
      const map = data.with as Record<string, unknown>;
      for (const [key, value] of Object.entries(map)) {
        if (!INPUT_NAME_PATTERN.test(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `invalid ${kind} input name '${key}'; use letters, numbers, underscores, or hyphens and start with a letter or underscore`,
            path: ['with'],
          });
        }
        if (!jsonValueSchema.safeParse(value).success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind} input '${key}' must be a JSON-compatible value (string, number, boolean, null, array, or object)`,
            path: ['with'],
          });
        }
      }
      return map;
    };
    // Node-local bindings on command/script nodes (#2637): same key/value grammar as
    // include/workflow `with:`, plus the object position is RESERVED for the binding
    // directive — any other object shape is rejected naming both accepted forms.
    const validateNodeBindings = (kind: 'command' | 'script'): void => {
      const map = validateWithShape(kind);
      if (map === undefined) return;
      // Two names folding to one INPUTS_<UPPER_SNAKE> env key would silently clobber
      // each other on script env delivery — same rule the loader enforces for a
      // workflow's declared `inputs:` block, applied here where the map is visible.
      // Scoped to this NEW surface only: include/workflow `with:` maps predate the
      // check and must keep loading (their callee's own `inputs:` block carries it).
      const envKeyOwners = new Map<string, string>();
      for (const key of Object.keys(map)) {
        const envKey = inputEnvKey(key);
        const existing = envKeyOwners.get(envKey);
        if (existing !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind} bindings '${existing}' and '${key}' both map to env var '${envKey}' — rename one so each binding has a unique env key`,
            path: ['with'],
          });
        }
        envKeyOwners.set(envKey, key);
      }
      for (const [key, value] of Object.entries(map)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        const parsed = bindingDirectiveSchema.safeParse(value);
        if (!parsed.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `${kind} binding '${key}': an object value must be a binding directive ` +
              "{ from: '$node.output[.field]', if_skipped?: <value> } — " +
              `${parsed.error.issues[0]?.message ?? 'invalid shape'}. ` +
              'Use a string, number, boolean, null, or array for a literal value.',
            path: ['with', key],
          });
          continue;
        }
        if (parseWholeOutputRef(parsed.data.from) === undefined) {
          // $LOOP_PREV is a per-iteration TEXT substitution, not a node ref — a
          // directive's `from` must stay a ref so `if_skipped` has a producer to
          // check. Name the supported spelling instead of the generic grammar error.
          const message = parsed.data.from.trim().startsWith('$LOOP_PREV')
            ? `${kind} binding '${key}': 'from' cannot read '$LOOP_PREV' — it is not a node reference. Use the string form (e.g. '${key}: ${parsed.data.from.trim()}'), which substitutes the previous iteration's text each pass.`
            : `${kind} binding '${key}': 'from' must be exactly one whole '$node.output' or '$node.output.field' reference, got '${parsed.data.from}'`;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message,
            path: ['with', key],
          });
        }
      }
    };
    if (hasInclude && data.with !== undefined) validateWithShape('include');
    if (hasWorkflow && data.with !== undefined) validateWithShape('workflow');
    if (hasCommand && data.with !== undefined) validateNodeBindings('command');
    if (hasScript && data.with !== undefined) validateNodeBindings('script');
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
    //
    // On an `include:` node specifically these options are not merely meaningless, they
    // express a LAUNCH intent composition cannot honour (#1764): an author who writes
    // `isolation: worktree` on an include believes the block got its own checkout, and it
    // did not. So the message names the option, why composition cannot honour it, and the
    // keyword that can — rather than the generic "only on workflow nodes" line.
    const LAUNCH_ONLY_ON_INCLUDE: readonly (readonly [keyof typeof data, string])[] = [
      [
        'isolation',
        'a composed block runs inside the run that composed it, so it has no checkout of its own to isolate',
      ],
      [
        'input',
        "a composed block reads named values as $INPUTS.<name>, supplied through 'with:' — there is no separate $ARGUMENTS for it",
      ],
    ];
    if (hasInclude) {
      for (const [field, why] of LAUNCH_ONLY_ON_INCLUDE) {
        if (data[field] === undefined) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'${field}' is not supported on an include node: ${why}. Use a 'workflow:' node instead when you want a separate governed run.`,
          path: [field],
        });
      }
    } else if (!hasWorkflow && !hasInclude) {
      if (data.isolation !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'isolation' is only supported on workflow (sub-run) nodes.",
          path: ['isolation'],
        });
      }
      // Dynamic fan-out is meaningful only where it multiplies something: a `workflow:`
      // node multiplies child runs (#2121 slice 2), an `include:` node multiplies the
      // composed body inside this run (#2512). On any other node type it would be
      // silently dropped, so reject it fail-fast (mirrors the `isolation` guard above).
      if (data.fan_out !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'fan_out' is only supported on workflow (sub-run) and include nodes.",
          path: ['fan_out'],
        });
      }
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
    if ((hasWorkflow || hasInclude) && data.fan_out?.join === 'first_success') {
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
    if (hasInclude && data.fan_out !== undefined && data.fan_out.as === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'fan_out.as' is required on an include node so each runtime item has an explicit $INPUTS.<name> binding",
        path: ['fan_out', 'as'],
      });
    }
    if (
      (hasWorkflow || hasInclude) &&
      data.fan_out?.as !== undefined &&
      !INPUT_NAME_PATTERN.test(data.fan_out.as)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid fan-out input name '${data.fan_out.as}'; use letters, numbers, underscores, or hyphens and start with a letter or underscore`,
        path: ['fan_out', 'as'],
      });
    }
    // `fan_out.as` names the per-item value as `$INPUTS.<as>` inside each child (#2470
    // lifts the PR-B/#2214 placeholder — #2224 merged). It is now generally accepted; the
    // only rejection is a COLLISION with a `with:` key, since both would populate the same
    // `$INPUTS.<name>` slot on the child with a precedence rule between them — the same
    // two-channels-one-name ambiguity the `with:`+`input:` guard rejects above.
    if (
      (hasWorkflow || hasInclude) &&
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
          "must have either 'command', 'prompt', 'bash', 'loop', 'loop_group', 'approval', 'wait', 'cancel', 'script', 'include', or 'workflow'",
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

    // `loop.until_field` <-> `output_format` (#2563). These live here rather than on
    // loopNodeConfigSchema because only this level can see BOTH the loop config and
    // the node's `output_format`.
    //
    // All four rules are load-time reads of data the author already wrote, and each
    // converts a silent non-termination into a load error. Without `required`, a
    // schema-valid payload may omit the property, and "absent" would mean "not
    // complete" — a model that never emits it would burn max_iterations and then
    // fail reporting the wrong cause. Without the boolean constraint,
    // `until_field: status` over a string invites truthiness semantics the engine
    // deliberately does not have (it terminates on `=== true`, nothing else).
    const untilField = data.loop?.until_field;
    if (hasLoop && untilField !== undefined) {
      const schema = data.output_format;
      if (schema === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'loop.until_field' names '${untilField}' but this node declares no 'output_format' — the field must be a declared property of the node's schema`,
          path: ['loop', 'until_field'],
        });
      } else {
        const declared = declaredFieldsFromSchema(schema);
        if (!declared?.includes(untilField)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `'loop.until_field' names '${untilField}', which is not declared in this node's output_format properties${declared && declared.length > 0 ? ` (declared: ${declared.join(', ')})` : ''}`,
            path: ['loop', 'until_field'],
          });
        } else {
          const required = schema.required;
          if (!Array.isArray(required) || !required.includes(untilField)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `'loop.until_field' names '${untilField}', which must also be listed in output_format.required — an optional field the model omits would silently read as "not complete" and burn max_iterations`,
              path: ['loop', 'until_field'],
            });
          }
          // `output_format` is free-form JSON Schema (`z.record`), so `type` is
          // genuinely unknown here — it may be a string, an array of strings
          // (`type: [boolean, 'null']`), or absent. Only a declared STRING type
          // other than 'boolean' is a violation; anything else is left to ajv.
          const properties = schema.properties as Record<string, unknown> | undefined;
          const property = properties?.[untilField];
          const rawType =
            property !== null && typeof property === 'object'
              ? (property as { type?: unknown }).type
              : undefined;
          const declaredType = typeof rawType === 'string' ? rawType : undefined;
          if (declaredType !== undefined && declaredType !== 'boolean') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `'loop.until_field' names '${untilField}', declared as type '${declaredType}' — it must be 'boolean'; the loop terminates on the value being exactly true`,
              path: ['loop', 'until_field'],
            });
          }
        }
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

    if (hasWait && data.output_format !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'output_format' is fixed by wait nodes and cannot be overridden",
        path: ['output_format'],
      });
    }
    if (hasWait && data.retry !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'retry' is not supported on wait nodes; the persisted condition governs continuation",
        path: ['retry'],
      });
    }
    if (hasWait && data.always_run !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'always_run' is not supported on wait nodes",
        path: ['always_run'],
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
  .transform((data): DagNode | IncludeDirective => {
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
      ...(data.mutates_checkout !== undefined ? { mutates_checkout: data.mutates_checkout } : {}),
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

    // Node-local bindings (#2637) — validated by validateNodeBindings above; carried
    // only by the command/script variants (other modes keep stripping the field).
    const nodeBindings =
      data.with !== undefined
        ? { with: data.with as Record<string, JsonValue | BindingDirective> }
        : {};

    if (data.command !== undefined && data.command.trim().length > 0) {
      return {
        ...base,
        ...shared,
        ...aiOnly,
        kind: 'agent',
        source: {
          kind: 'command',
          name: data.command.trim(),
          ...nodeBindings,
        },
      } as AgentNode;
    }
    if (data.prompt !== undefined && data.prompt.trim().length > 0) {
      return {
        ...base,
        ...shared,
        ...aiOnly,
        kind: 'agent',
        source: { kind: 'inline', prompt: data.prompt.trim() },
      } as AgentNode;
    }
    if (data.bash !== undefined && data.bash.trim().length > 0) {
      return {
        ...base,
        ...shared,
        kind: 'exec',
        script: data.bash.trim(),
        runtime: 'sh',
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      } as ExecNode;
    }
    if (data.script !== undefined && data.script.trim().length > 0) {
      // runtime is guaranteed by superRefine to be defined at this point
      if (!data.runtime) throw new Error('unreachable: runtime must be defined for script nodes');
      return {
        ...base,
        ...shared,
        kind: 'exec',
        script: data.script.trim(),
        runtime: data.runtime,
        ...(data.deps !== undefined ? { deps: data.deps } : {}),
        ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
        ...nodeBindings,
      } as ExecNode;
    }
    if (data.approval !== undefined) {
      // Two mechanisms, mutually exclusive (enforced by the superRefine below):
      // legacy 'on_reject' synthesizes a 'reject' decision carrying a 'rework'
      // continuation — dag-executor's existing reject-resume path (a synthetic
      // AI re-prompt with a max-attempts counter) stays byte-identical, reading
      // from this same synthesized shape (#2707 step 1's "grow-then-deprecate":
      // nothing breaks by rename). A gate with no 'on_reject' AND an explicitly
      // authored 'approval.decisions:' uses the new mechanism — see
      // GateNode.decisionsAuthored's doc for why THAT exact field (not merely
      // "no on_reject") is the mode signal: no pre-PR workflow can have
      // authored 'decisions:', so every already-authored gate — including a
      // bare one, or one only setting capture_response — is unaffected by this
      // PR regardless of on_reject.
      const decisions: DecisionOption[] =
        data.approval.on_reject !== undefined
          ? [
              { id: 'approve' },
              {
                id: 'reject',
                rework: {
                  prompt: data.approval.on_reject.prompt,
                  ...(data.approval.on_reject.max_attempts !== undefined
                    ? { maxAttempts: data.approval.on_reject.max_attempts }
                    : {}),
                },
              },
            ]
          : (data.approval.decisions ?? [{ id: 'approve' }, { id: 'reject' }]);
      return {
        ...base,
        ...shared,
        kind: 'gate',
        message: data.approval.message,
        decisions,
        decisionsAuthored: data.approval.decisions !== undefined,
        captureResponse: data.approval.capture_response ?? false,
      } as GateNode;
    }
    if (data.wait !== undefined) {
      return {
        ...base,
        kind: 'wait',
        wait: data.wait,
        output_format: WAIT_NODE_OUTPUT_FORMAT,
      } as WaitNode;
    }
    if (data.cancel !== undefined && data.cancel.trim().length > 0) {
      return { ...base, ...shared, kind: 'halt', reason: data.cancel.trim() } as HaltNode;
    }
    if (data.include !== undefined && data.include.trim().length > 0) {
      // `include:` + `fan_out:` (#2512) is the runtime-width composed fan-out: the item
      // list resolves at run time, so this node is NOT expanded away — it survives as a
      // ComposeFanOutNode and the executor expands one instance per item through the
      // same expander. Carries only structural fields + include target + with map + the
      // fan-out config, like the static directive below it.
      if (data.fan_out !== undefined) {
        return {
          ...structuralBase,
          kind: 'compose_fan_out',
          include: data.include.trim(),
          ...(data.with !== undefined ? { with: data.with as Record<string, JsonValue> } : {}),
          fan_out: data.fan_out,
        } as ComposeFanOutNode;
      }
      // An include is a load-time directive, not an executable node. It carries the
      // structural graph fields, target name, and optional load-time input mapping. The
      // expander reads those fields to attach and parameterize the sub-DAG (description just
      // rides along). aiOnly / shared (retry) and the exec-only base fields (always_run /
      // output_type / idle_timeout) are intentionally dropped; the loader warns about them
      // via INCLUDE_NODE_IGNORED_FIELDS.
      return {
        ...structuralBase,
        kind: 'include',
        include: data.include.trim(),
        ...(data.with !== undefined ? { with: data.with as Record<string, JsonValue> } : {}),
      } as IncludeDirective;
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
        kind: 'workflow',
        ...(data.output_type !== undefined ? { output_type: data.output_type } : {}),
        ...(data.output_format !== undefined ? { output_format: data.output_format } : {}),
        workflow: data.workflow.trim(),
        ...(data.input !== undefined ? { input: data.input } : {}),
        // `with:` supplies named $INPUTS to the child sub-run (#2470), validated in shape
        // by the superRefine above and mutually exclusive with `input:`. Mirrors the
        // include transform's `with` assembly.
        ...(data.with !== undefined ? { with: data.with as Record<string, JsonValue> } : {}),
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
      return {
        ...base,
        ...aiOnly,
        kind: 'loop_group',
        loop_group: data.loop_group,
      } as LoopGroupNode;
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
      kind: 'loop',
      ...(data.pi !== undefined ? { pi: data.pi } : {}),
      // Kept for the same reason as `pi`: a loop: node runs its own sendQuery, so
      // the schema reaches the provider and each iteration's payload is validated
      // against it (#2563). `loop.until_field` then terminates on a declared
      // boolean, and the node's output becomes the validated JSON.
      ...(data.output_format !== undefined ? { output_format: data.output_format } : {}),
      loop: data.loop,
    } as LoopNode;
  })
  .openapi('DagNode');

// ---------------------------------------------------------------------------
// Type guards (preserved from original types.ts)
// ---------------------------------------------------------------------------

/** Type guard: check if a DAG node is an agent (command-file or inline-prompt) node */
export function isAgentNode(node: DagNode): node is AgentNode {
  return node.kind === 'agent';
}

/** Type guard: check if a DAG node is an exec (bash or script) node */
export function isExecNode(node: DagNode): node is ExecNode {
  return node.kind === 'exec';
}

/** Type guard: check if a DAG node is a gate (human-in-the-loop) node */
export function isGateNode(node: DagNode): node is GateNode {
  return node.kind === 'gate';
}

/** Type guard: check if a DAG node is a durable world-wait node. */
export function isWaitNode(node: DagNode): node is WaitNode {
  return node.kind === 'wait';
}

/** Type guard: check if a DAG node is a halt (workflow termination) node */
export function isHaltNode(node: DagNode): node is HaltNode {
  return node.kind === 'halt';
}

/** Type guard: check if a DAG node is a loop (iterative) node */
export function isLoopNode(node: DagNode): node is LoopNode {
  return node.kind === 'loop';
}

/** Type guard: check if a DAG node is a loop_group (cross-node iterative subgraph) node */
export function isLoopGroupNode(node: DagNode): node is LoopGroupNode {
  return node.kind === 'loop_group';
}

/** Type guard: check if a DAG node is a workflow (runtime sub-run) node */
export function isWorkflowNode(node: DagNode): node is WorkflowNode {
  return node.kind === 'workflow';
}

/**
 * Type guard: check if a pre-expansion graph entry is an include directive rather
 * than an executable `DagNode`. Normalized includes have their own discriminant even
 * though they are not executable `DagNode`s (#2486).
 */
export function isIncludeDirective(node: DagNode | IncludeDirective): node is IncludeDirective {
  const candidate = node as { kind?: unknown; include?: unknown };
  return (
    candidate.kind === 'include' ||
    (candidate.kind === undefined && typeof candidate.include === 'string')
  );
}

/** Type guard: validates a value is a known TriggerRule */
export function isTriggerRule(value: unknown): value is TriggerRule {
  return typeof value === 'string' && (TRIGGER_RULES as readonly string[]).includes(value);
}

/**
 * True for node types that invoke a provider and therefore participate in cross-run
 * session persistence (`persist_session`). exec, gate, halt, loop, and loop_group
 * nodes are excluded — they either make no provider call or manage their own
 * per-iteration sessions. Shared by the loader's load-time capability gate and any
 * other caller that needs to reason about persistence eligibility, so the
 * exclusion list lives in one place.
 */
export function isPersistableNode(node: DagNode): boolean {
  return node.kind === 'agent';
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
 * `array`  — a list whose ENTRIES share one fixed shape, described by `entry`
 *            (e.g. `approval.decisions`, a list of `{id, label?}` objects).
 */
export type NestedKeySpec =
  | {
      readonly kind: 'object';
      readonly keys: ReadonlySet<string>;
      readonly children?: ReadonlyMap<string, NestedKeySpec>;
    }
  | { readonly kind: 'record'; readonly entry: NestedKeySpec }
  | { readonly kind: 'array'; readonly entry: NestedKeySpec };

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
        [
          'decisions',
          {
            kind: 'array',
            entry: {
              kind: 'object',
              keys: new Set(Object.keys(approvalDecisionConfigSchema.shape)),
            },
          },
        ],
      ]),
    },
  ],
  ['retry', { kind: 'object', keys: new Set(Object.keys(stepRetryConfigSchema.shape)) }],
  ['context', { kind: 'object', keys: new Set(Object.keys(nodeContextResumeSchema.shape)) }],
  ['loop', { kind: 'object', keys: new Set(Object.keys(loopNodeConfigSchema.shape)) }],
  ['loop_group', { kind: 'object', keys: new Set(Object.keys(loopGroupShape)) }],
  ['wait', { kind: 'object', keys: new Set(Object.keys(waitConfigFlatSchema.shape)) }],
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
