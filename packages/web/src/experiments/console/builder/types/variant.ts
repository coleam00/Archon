/**
 * Builder type definitions — the in-editor data model for a workflow under edit.
 *
 * A `BuilderNode` partitions a wire `DagNode` into `{ id, variant, base, data }`:
 *   - `variant`  — the discriminant (which of the eight node kinds this is)
 *   - `base`     — shared base fields (depends_on, when, model, …) minus `id`
 *   - `data`     — variant-specific fields, discriminated by `variant`
 *
 * Wire shapes are reached only through `./wire`; the variant id is the
 * console's existing `WorkflowNodeKind` primitive.
 */
import type { WorkflowNodeKind } from '../../primitives/workflow-graph';
import type { WireDagNode, WireWorkflowDefinition } from './wire';

/**
 * The eight representable node variants — an alias of the console's
 * `WorkflowNodeKind` primitive so the builder and the graph renderer share one
 * union (the builder does not redefine the kinds).
 */
export type VariantId = WorkflowNodeKind;

// ---------------------------------------------------------------------------
// Base fields — shared across every variant (the wire base keys minus `id`)
// ---------------------------------------------------------------------------

/**
 * The base-field keys present on every wire `DagNode`, excluding `id` (which is
 * partitioned out separately) and the eight mutually-exclusive mode fields
 * (command/prompt/bash/script/loop/approval/wait/cancel) plus their satellites
 * (runtime/deps/timeout). Picking from `WireDagNode` keeps `BaseFields` exactly
 * in sync with the generated spec.
 *
 * Exported so `variants/base-fields.ts` can derive its runtime key list from an
 * exhaustive `Record<WireBaseKey, true>` — adding a key here without updating
 * the record (or vice versa) is a compile error, not silent round-trip loss.
 */
export type WireBaseKey =
  | 'depends_on'
  | 'when'
  | 'trigger_rule'
  | 'model'
  | 'provider'
  | 'context'
  | 'output_format'
  | 'allowed_tools'
  | 'denied_tools'
  | 'idle_timeout'
  | 'retry'
  | 'hooks'
  | 'mcp'
  | 'skills'
  | 'agents'
  | 'effort'
  | 'thinking'
  | 'maxBudgetUsd'
  | 'systemPrompt'
  | 'fallbackModel'
  | 'betas'
  | 'sandbox'
  | 'always_run'
  | 'persist_session'
  | 'output_type';

/** Shared base fields carried verbatim across the round-trip. All optional. */
export type BaseFields = Pick<WireDagNode, WireBaseKey>;

// ---------------------------------------------------------------------------
// Per-variant data shapes
// ---------------------------------------------------------------------------

/**
 * Loop config. `fresh_context` is always present (engine default `false`).
 *
 * Exactly ONE of `prompt` (inline per-iteration prompt) / `command` (named
 * command file whose body is the per-iteration prompt) is present — mirroring
 * the engine schema's one-of rule. The inspector's source toggle maintains the
 * invariant while editing; structural validation reports a violation instead
 * of letting export guess.
 */
export interface LoopNodeData {
  prompt?: string;
  command?: string;
  /**
   * Prose completion signal. Optional since #2563 — a loop declaring only
   * `until_bash` has no prose path at all, so the engine requires *at least one*
   * of the two rather than `until` unconditionally. Structural validation mirrors
   * that rule; every read here must tolerate `undefined`.
   */
  until?: string;
  max_iterations: number;
  fresh_context: boolean;
  until_bash?: string;
  /**
   * Structured completion channel (#2563): names a declared boolean in the node's
   * `output_format` (carried as a base field) whose `true` ends the loop. `loop:`
   * only — a `loop_group` has no such channel.
   */
  until_field?: string;
  interactive?: boolean;
  gate_message?: string;
}

/** The `on_reject` sub-object on an approval node. */
export interface ApprovalOnReject {
  prompt: string;
  max_attempts?: number;
}

/** Human-gate approval data. */
export interface ApprovalNodeData {
  message: string;
  capture_response?: boolean;
  on_reject?: ApprovalOnReject;
}

/** Cancel data — the wire `cancel` is a bare string; we wrap it as `reason`. */
export interface CancelNodeData {
  reason: string;
}

type UnionKeys<T> = T extends T ? keyof T : never;
type UnionValue<T, K extends PropertyKey> = T extends Record<K, infer V> ? V : never;

/**
 * The wire wait is a validated one-of union. The builder deliberately holds an
 * incomplete form while the operator switches variants and edits fields, then
 * structural validation restores the wire invariant before serialization.
 */
export type WaitNodeData = {
  [K in UnionKeys<NonNullable<WireDagNode['wait']>>]?: UnionValue<
    NonNullable<WireDagNode['wait']>,
    K
  >;
};

/** Sparse builder output before structural validation restores the wire invariant. */
export type BuilderDagFragment = Omit<Partial<WireDagNode>, 'wait'> & {
  wait?: WaitNodeData;
};

/** Full preview node that may still contain an incomplete wait draft. */
export type BuilderDagNode = Omit<WireDagNode, 'wait'> & {
  wait?: WaitNodeData;
};

/** Preview/validation payload; it becomes a wire definition only after validation. */
export type BuilderWorkflowDefinition = Omit<WireWorkflowDefinition, 'nodes'> & {
  nodes: BuilderDagNode[];
};

/** Script node data (inline code or named script run via bun/uv). */
export interface ScriptNodeData {
  script: string;
  runtime: 'bun' | 'uv';
  deps?: string[];
  timeout?: number;
  /**
   * Node-local bindings (#2637). Opaque passthrough: the builder has no editor
   * for them yet, but dropping the field on save would silently destroy a
   * workflow's bindings, so it round-trips verbatim. String values and directive
   * `from` refs are scanned by content validation.
   */
  with?: Record<string, unknown>;
}

/** Named-command node data. */
export interface CommandNodeData {
  command: string;
  /** Node-local bindings (#2637) — opaque passthrough, same contract as script. */
  with?: Record<string, unknown>;
}

/** Inline-prompt node data. */
export interface PromptNodeData {
  prompt: string;
}

/** Bash node data. */
export interface BashNodeData {
  bash: string;
  timeout?: number;
}

/** Maps each variant id to its concrete data shape. */
export interface VariantDataMap {
  loop: LoopNodeData;
  approval: ApprovalNodeData;
  wait: WaitNodeData;
  cancel: CancelNodeData;
  script: ScriptNodeData;
  command: CommandNodeData;
  prompt: PromptNodeData;
  bash: BashNodeData;
}

/** Union of all variant data shapes. */
export type VariantData = VariantDataMap[VariantId];

// ---------------------------------------------------------------------------
// BuilderNode / BuilderWorkflow
// ---------------------------------------------------------------------------

/**
 * A node under edit. Modelled as a discriminated union over `variant` so that
 * `node.data` narrows to the correct shape in a `switch (node.variant)`.
 *
 * No `position`/selection/clipboard fields — those are canvas concerns owned by
 * PR-2 (added as an additive extension later).
 */
export type BuilderNode = {
  [K in VariantId]: {
    id: string;
    variant: K;
    base: BaseFields;
    data: VariantDataMap[K];
  };
}[VariantId];

/** Workflow-level metadata (everything on the wire def except name/description/nodes). */
export type WorkflowMeta = Omit<WireWorkflowDefinition, 'name' | 'description' | 'nodes'>;

/**
 * A whole workflow definition under edit. Distinct from the console's list-entry
 * `Workflow` ({ name, description, source }) — this is the "definition being
 * edited" concept with a full node list.
 */
export interface BuilderWorkflow {
  name: string;
  description: string;
  meta: WorkflowMeta;
  nodes: BuilderNode[];
}
