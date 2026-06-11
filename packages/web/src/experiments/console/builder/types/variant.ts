/**
 * Builder type definitions — the in-editor data model for a workflow under edit.
 *
 * A `BuilderNode` partitions a wire `DagNode` into `{ id, variant, base, data }`:
 *   - `variant`  — the discriminant (which of the seven node kinds this is)
 *   - `base`     — shared base fields (depends_on, when, model, …) minus `id`
 *   - `data`     — variant-specific fields, discriminated by `variant`
 *
 * Wire shapes are reached only through `./wire`; the variant id is the
 * console's existing `WorkflowNodeKind` primitive.
 */
import type { WorkflowNodeKind } from '../../primitives/workflow-graph';
import type { WireDagNode, WireWorkflowDefinition } from './wire';

/**
 * The seven representable node variants — an alias of the console's
 * `WorkflowNodeKind` primitive so the builder and the graph renderer share one
 * union (the builder does not redefine the kinds).
 */
export type VariantId = WorkflowNodeKind;

// ---------------------------------------------------------------------------
// Base fields — shared across every variant (the wire base keys minus `id`)
// ---------------------------------------------------------------------------

/**
 * The base-field keys present on every wire `DagNode`, excluding `id` (which is
 * partitioned out separately) and the seven mutually-exclusive mode fields
 * (command/prompt/bash/script/loop/approval/cancel) plus their satellites
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

/** Loop config. `fresh_context` is always present (engine default `false`). */
export interface LoopNodeData {
  prompt: string;
  until: string;
  max_iterations: number;
  fresh_context: boolean;
  until_bash?: string;
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

/** Script node data (inline code or named script run via bun/uv). */
export interface ScriptNodeData {
  script: string;
  runtime: 'bun' | 'uv';
  deps?: string[];
  timeout?: number;
}

/** Named-command node data. */
export interface CommandNodeData {
  command: string;
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
