/**
 * Zod schema for a DAG node: `dagNodeSchema` validates one authored node and turns it
 * into a `DagNode` (or a load-time `IncludeDirective`).
 *
 * Design: a flat schema accepts every field of every node mode (`NODE_MODE_SHAPES`),
 * a superRefine validates the one selected mode (`validateDagNode`, then
 * node-validation.ts), and a transform builds that mode's node kind (node-normalize.ts).
 * Each kind's own schema lives in its own module (agent-node.ts, exec-node.ts, …) and
 * is exported for type derivation only — use dagNodeSchema for validation.
 *
 * z.union() is NOT used here — YAML nodes lack an explicit `type` discriminant,
 * so a flat schema with superRefine is cleaner than a z.union() with implicit discriminants.
 *
 * The loop_group kind stays in this module: its body is a list of `dagNodeSchema`
 * nodes, and a module that imported `dagNodeSchema` back from here would make the
 * import order decide whether the mode table below can read it.
 */
import { z } from 'zod';
import { agentDefinitionSchema } from '@archon/provider-contract';
export { agentDefinitionSchema, type AgentDefinition } from '@archon/provider-contract';
import { loopRetryConfigSchema, stepRetryConfigSchema } from './retry';
import { rejectRetiredThinking } from './effort';
import { piNodeConfigSchema } from './provider-options';
export * from './provider-options';
export { MAX_DURABLE_WAIT_MS } from './durable-wait';
export { effortLevelSchema, EFFORT_LEVELS } from './effort';
export type { EffortLevel } from './effort';
import { declaredOutputPathsFromSchema, type DeclaredOutputPaths } from '../output-ref';
import {
  BASE_COMPLETION_CHANNELS,
  addMissingChannelIssue,
  loopNodeConfigSchema,
  loopControlSchema,
  type LoopControl,
} from './loop';
import { validateNodeHooks } from './hooks';
import type { AgentNode } from './agent-node';
import { dagNodeBaseSchema, isNodeContextResume, nodeContextResumeSchema } from './dag-node-base';
import {
  bashExecAuthoringSchema,
  bashExecFlatSchema,
  execNodeSchema,
  execTimeoutInputSchema,
  scriptExecAuthoringSchema,
  scriptExecFlatSchema,
  type ExecNode,
} from './exec-node';
import {
  approvalConfigSchema,
  approvalDecisionConfigSchema,
  approvalOnRejectSchema,
  type GateNode,
} from './gate-node';
import type { HaltNode } from './halt-node';
import {
  composeFanOutConfigSchema,
  type ComposeFanOutNode,
  type IncludeDirective,
} from './include-node';
import type { LoopNode } from './loop-node';
import { isLoopGroupNode } from './node-guards';
import { normalizeDagNode } from './node-normalize';
import { addIssue, addIssues, validateSelectedMode } from './node-validation';
import { waitConfigKeys, waitConfigSchema, type WaitNode } from './wait-node';
import { fanOutConfigSchema, type WorkflowNode } from './workflow-node';
// Importers outside this package read these through this module.
export {
  ATTENTION_OUTPUT_FORMATS,
  attentionFormSchema,
  type AttentionLabels,
  attentionLabelKeySchema,
  attentionLabelsSchema,
} from './wait-node';
export { getApprovalDecisions } from './gate-node';

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
      BASE_COMPLETION_CHANNELS.filter(({ field }) => data[field] !== undefined).map(c => c.field),
      BASE_COMPLETION_CHANNELS
    );
  });

/**
 * Loop-group node schema — extends base with `loop_group` config (iteration control + body).
 * AI-specific base fields are ignored at runtime with a warning, and `retry`
 * is not supported (the group manages its own iteration). `model`/`provider` are forwarded
 * to body AI nodes unless overridden per-node (same forwarding `loop:` uses).
 */
export const loopGroupNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('loop_group'),
  loop_group: loopGroupNodeConfigSchema,
  timeout: execNodeSchema.shape.timeout,
});

/** DAG node that runs a multi-node sub-DAG in a loop until a completion condition is met */
export type LoopGroupNode = z.infer<typeof loopGroupNodeSchema>;

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

/**
 * The keys each node mode owns: its selector key plus the keys only that mode
 * reads. The single source for which mode a key belongs to — the flat schema is
 * assembled from it, mode detection iterates it, and a key set on a node whose
 * mode does not own it is a load error (#2478). Insertion order is the order the
 * modes are named in error messages.
 *
 * Values are the loose flat types: a selected bash/script/loop node is checked
 * against its strict projection in `dagNodeSchema`'s superRefine. A key shared by
 * several modes must use one schema in every entry, because the flat schema keeps
 * only the last spread.
 */
const NODE_MODE_SHAPES = {
  command: { command: z.string(), with: z.unknown() },
  prompt: { prompt: z.string() },
  bash: bashExecFlatSchema.shape,
  loop: { loop: loopNodeConfigSchema, timeout: execTimeoutInputSchema },
  loop_group: { loop_group: loopGroupNodeConfigSchema, timeout: execTimeoutInputSchema },
  approval: { approval: approvalConfigSchema },
  wait: { wait: waitConfigSchema },
  cancel: { cancel: z.string() },
  script: scriptExecFlatSchema.shape,
  // Load-time inlining directive — the target workflow name. On an include node
  // `fan_out` multiplies the composed body inside this run (#2512).
  include: {
    include: z.string().min(1, "'include' must be a non-empty workflow name"),
    with: z.unknown(),
    fan_out: fanOutConfigSchema,
  },
  // Runtime sub-run directive (#2121) — the child workflow name. `input` is the
  // child's user_message; `isolation: worktree` gives the child its own worktree;
  // `fan_out` multiplies child runs.
  workflow: {
    workflow: z.string().min(1, "'workflow' must be a non-empty workflow name"),
    input: z.string(),
    isolation: z.enum(['inherit', 'worktree']),
    fan_out: fanOutConfigSchema,
    with: z.unknown(),
  },
} as const satisfies Record<string, z.ZodRawShape>;

export type NodeMode = keyof typeof NODE_MODE_SHAPES;
type ModeOwnedKey = { [M in NodeMode]: keyof (typeof NODE_MODE_SHAPES)[M] }[NodeMode];

const NODE_MODES = Object.keys(NODE_MODE_SHAPES) as NodeMode[];

/** The modes a node selects. A string selector needs non-blank text; an object selector only presence. */
function selectedModes(node: Readonly<Record<string, unknown>>): NodeMode[] {
  return NODE_MODES.filter(mode => {
    const value = node[mode];
    return typeof value === 'string' ? value.trim().length > 0 : value !== undefined;
  });
}

/** Each mode's owned keys, derived from `NODE_MODE_SHAPES`. */
export const NODE_MODE_KEYS: ReadonlyMap<NodeMode, ReadonlySet<string>> = new Map(
  NODE_MODES.map(mode => [mode, new Set(Object.keys(NODE_MODE_SHAPES[mode]))])
);

/** Every mode-owned key, each mapped to the modes that own it, in mode order. */
const MODE_KEY_OWNERS: ReadonlyMap<string, readonly NodeMode[]> = new Map(
  [...new Set(NODE_MODES.flatMap(mode => [...(NODE_MODE_KEYS.get(mode) ?? [])]))].map(key => [
    key,
    NODE_MODES.filter(mode => NODE_MODE_KEYS.get(mode)?.has(key)),
  ])
);

/** Every mode quoted, in record order: `'command', 'prompt', …, and 'workflow'`. */
function listModes(conjunction: 'and' | 'or'): string {
  const quoted = NODE_MODES.map(mode => `'${mode}'`);
  return `${quoted.slice(0, -1).join(', ')}, ${conjunction} ${quoted[quoted.length - 1]}`;
}

/**
 * `isolation:` and `input:` on an include node express a LAUNCH intent composition
 * cannot honour (#1764): an author who writes `isolation: worktree` on an include
 * believes the block got its own checkout, and it did not. So the error names why,
 * and the keyword that can, instead of the generic foreign-key line.
 */
const LAUNCH_ONLY_ON_INCLUDE: ReadonlyMap<string, string> = new Map([
  [
    'isolation',
    'a composed block runs inside the run that composed it, so it has no checkout of its own to isolate',
  ],
  [
    'input',
    "a composed block reads named values as $INPUTS.<name>, supplied through 'with:' — there is no separate $ARGUMENTS for it",
  ],
]);

/** `a`, `a or b`, `a, b or c`. */
function joinOr(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * Flat schema with all DAG node fields (base + every mode's keys) before
 * superRefine/transform. Exported so KNOWN_DAG_NODE_KEYS can be derived from
 * its shape, and for any future use that needs the pre-validation object type.
 */
export const dagNodeFlatSchema = dagNodeBaseSchema.extend({
  retry: stepRetryConfigSchema
    .extend({ delay_ms: loopRetryConfigSchema.shape.delay_ms })
    .optional(),
  ...z.object(NODE_MODE_SHAPES.command).partial().shape,
  ...z.object(NODE_MODE_SHAPES.prompt).partial().shape,
  ...z.object(NODE_MODE_SHAPES.bash).partial().shape,
  ...z.object(NODE_MODE_SHAPES.loop).partial().shape,
  ...z.object(NODE_MODE_SHAPES.loop_group).partial().shape,
  ...z.object(NODE_MODE_SHAPES.approval).partial().shape,
  ...z.object(NODE_MODE_SHAPES.wait).partial().shape,
  ...z.object(NODE_MODE_SHAPES.cancel).partial().shape,
  ...z.object(NODE_MODE_SHAPES.script).partial().shape,
  ...z.object(NODE_MODE_SHAPES.include).partial().shape,
  ...z.object(NODE_MODE_SHAPES.workflow).partial().shape,
});

// ---------------------------------------------------------------------------
// Known node keys — used by the loader to detect unknown/misplaced keys
// ---------------------------------------------------------------------------

/**
 * All keys accepted by the flat dagNodeSchema (base + every mode's keys).
 * Derived from the dagNodeFlatSchema shape — no hand-maintained list needed;
 * the `satisfies` makes a mode left out of the flat schema a compile error.
 * Used by parseDagNode to warn on unknown keys that Zod's default strip would
 * silently drop (#2213).
 */
export const KNOWN_DAG_NODE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(dagNodeFlatSchema.shape satisfies Record<ModeOwnedKey, z.ZodType>)
);

// ---------------------------------------------------------------------------
// Node validation — the superRefine half of dagNodeSchema
// ---------------------------------------------------------------------------

export type DagNodeFields = z.output<typeof dagNodeFlatSchema>;

function validateDagNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  const id = data.id.trim();
  if (!id) {
    addIssue(ctx, "missing required field 'id'", ['id']);
    return;
  }
  if (id === 'INPUTS') {
    addIssue(ctx, "node id 'INPUTS' is reserved for the $INPUTS.<name> parameter surface", ['id']);
  }

  const modes = selectedModes(data);
  if (modes.length > 1) {
    addIssue(ctx, `${listModes('and')} are mutually exclusive`);
    return;
  }
  const mode = modes[0];
  if (isNodeContextResume(data.context) && mode !== 'command' && mode !== 'prompt') {
    addIssue(ctx, "'context.resume' is only supported on command and prompt nodes", ['context']);
  }
  if (mode === undefined) {
    validateModelessNode(data, ctx);
    return;
  }
  validateSelectedMode(data, mode, ctx);
}

/** A node with no selected mode: a blank selector names its own error, otherwise the mode is missing. */
function validateModelessNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  if (typeof data.bash === 'string') {
    const result = bashExecAuthoringSchema.pick({ bash: true }).safeParse(data);
    if (!result.success) addIssues(ctx, result.error.issues);
    return;
  }
  if (typeof data.prompt === 'string') {
    addIssue(ctx, 'prompt cannot be empty', ['prompt']);
    return;
  }
  if (typeof data.script === 'string') {
    const result = scriptExecAuthoringSchema.pick({ script: true }).safeParse(data);
    if (!result.success) addIssues(ctx, result.error.issues);
    return;
  }
  addIssue(ctx, `must have either ${listModes('or')}`);
}

// ---------------------------------------------------------------------------
// dagNodeSchema — flat validation schema with transform to DagNode
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a selected mode after `dagNodeSchema` rejects misplaced keys.
 * Provider identity is validated in loader/provider-checks.ts; model strings pass
 * through unchanged to the SDK, which owns that vocabulary.
 */
const dagNodeVariantSchema = z
  .preprocess(rejectRetiredThinking, dagNodeFlatSchema)
  .superRefine((data, ctx) => validateDagNode(data, ctx))
  .transform((data): DagNode | IncludeDirective => {
    const [mode] = selectedModes(data);
    if (mode === undefined)
      throw new Error('unreachable: a mode must be selected after superRefine');
    return normalizeDagNode(data, mode);
  });

export const dagNodeSchema: z.ZodType<DagNode | IncludeDirective> = z
  .preprocess(validateRawDagNode, dagNodeVariantSchema)
  // Refinements do not reach OpenAPI; retain the include-specific fan-out contract
  // structurally so generated authoring types cannot offer workflow-only concurrency.
  // Retain authored targets on both sides until validation succeeds to avoid merge throws.
  .and(
    z.union([
      // The OpenAPI converter cannot emit ZodNever; an empty enum admits no value.
      z.object({ include: z.never().meta({ type: 'string', enum: [] }).optional() }),
      z.object({
        include: NODE_MODE_SHAPES.include.include,
        fan_out: composeFanOutConfigSchema.optional(),
      }),
    ])
  )
  .transform(node =>
    'include' in node && node.include !== undefined
      ? { ...node, include: node.include.trim() }
      : node
  )
  .meta({ id: 'DagNode' });

/**
 * The field-path contract a node's own definition declares for its output. A
 * loop_group's `output_format` is not applied to the group's own output, so it declares
 * none. A `workflow:` node has no schema; its contract is the child's, carried at run
 * time.
 */
export function definedOutputPaths(node: DagNode): DeclaredOutputPaths | undefined {
  return isLoopGroupNode(node) ? undefined : declaredOutputPathsFromSchema(node.output_format);
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
  ['wait', { kind: 'object', keys: waitConfigKeys }],
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

/**
 * Loop settings (`until_bash`, `interactive`, `max_iterations`, …) mapped to the
 * modes whose config reads them. Derived from the loop schemas, minus keys that
 * are also node keys (`prompt`, `command`). Read only at parse time, so it may
 * sit here with `loopGroupShape` (see the ordering note there).
 */
const LOOP_SETTING_OWNERS: ReadonlyMap<string, readonly NodeMode[]> = (() => {
  const loopKeys = new Set(Object.keys(loopNodeConfigSchema.shape));
  const groupKeys = new Set(Object.keys(loopGroupShape));
  return new Map(
    [...new Set([...loopKeys, ...groupKeys])]
      .filter(key => !KNOWN_DAG_NODE_KEYS.has(key))
      .map(key => [
        key,
        (['loop', 'loop_group'] as const).filter(mode =>
          (mode === 'loop' ? loopKeys : groupKeys).has(key)
        ),
      ])
  );
})();

/**
 * A key owned by another mode asserts something this node will not do — run a
 * script under `runtime:`, bound its time, pass a child `input:` — and a loop
 * setting at the top level asserts iteration or a gate the node never gets. Both
 * fail the load rather than being dropped (#2478). Check placement on the raw node
 * before the flat schema strips loop settings or checks the misplaced value's type.
 */
function validateRawDagNode(value: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const node = value as Record<string, unknown>;
  validateNodeHooks(node.hooks, ctx);
  const id = typeof node.id === 'string' ? node.id.trim() : '';
  const modes = selectedModes(node);
  // Without an id or a single mode the variant schema's own error comes first.
  if (id && modes.length === 1) rejectForeignModeKeys(node, modes[0], id, ctx);
  rejectTopLevelLoopSettings(node, id, ctx);
  return value;
}

function rejectForeignModeKeys(
  node: Readonly<Record<string, unknown>>,
  mode: NodeMode,
  id: string,
  ctx: z.RefinementCtx
): void {
  const ownKeys = NODE_MODE_KEYS.get(mode);
  for (const [key, owners] of MODE_KEY_OWNERS) {
    if (ownKeys?.has(key) || node[key] === undefined) continue;
    const launchOnly = mode === 'include' ? LAUNCH_ONLY_ON_INCLUDE.get(key) : undefined;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        launchOnly !== undefined
          ? `is not supported on an include node: ${launchOnly}. Use a 'workflow:' node instead when you want a separate governed run.`
          : `is only supported on ${joinOr(owners)} nodes, not on ${mode} nodes.`,
      path: [key],
      params: { nodeId: id },
    });
  }
}

function rejectTopLevelLoopSettings(
  node: Readonly<Record<string, unknown>>,
  id: string,
  ctx: z.RefinementCtx
): void {
  for (const key of Object.keys(node)) {
    const owners = LOOP_SETTING_OWNERS.get(key);
    if (owners === undefined) continue;
    const pauseHint =
      key === 'interactive'
        ? " Nothing on this node pauses. To ask for an answer, add a 'wait: { attention: <message> }'" +
          " node; to ask on each iteration of a loop, use a 'loop_group' whose body ends in one."
        : '';
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `is only honoured inside ${joinOr(owners.map(o => `'${o}:'`))}; at the top level nothing reads it.${pauseHint}`,
      params: { nodeId: id },
    });
  }
}
