/**
 * The fields each node kind accepts in YAML but never reads: the loader warns about
 * them, and whether `output_format` is enforced derives from the same lists.
 */
import type { DagNode } from './dag-node';
import type { IncludeDirective } from './include-node';
import { loopAiAuthoringSchema } from './loop-node';
import {
  isComposeFanOutNode,
  isExecNode,
  isGateNode,
  isHaltNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
} from './node-guards';

/**
 * AI-specific fields that are meaningless on bash nodes — exported for loader warnings.
 *
 * `output_format` is deliberately ABSENT since #2453: an exec node that declares one
 * certifies its own stdout (strict JSON + the shared ajv gate), so the field is enforced
 * rather than warned-and-dropped. The three lists below that derive from this one and
 * have no execution site for a schema re-add it explicitly.
 */
export const BASH_NODE_AI_FIELDS: readonly string[] = [
  'provider',
  'model',
  'context',
  'allowed_tools',
  'denied_tools',
  'hooks',
  'mcp',
  'skills',
  'plugins',
  'agents',
  'pi',
  'effort',
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

/** Fields ignored by a loop's own provider call, derived from its authored projection. */
export const LOOP_NODE_AI_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS.filter(field => !(field in loopAiAuthoringSchema.shape)),
  // Tree-integrity enforcement belongs to exec/agent nodes, not whole loops.
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
  // Still inert here after #2453 made it live on exec nodes: a group never calls
  // sendQuery and never certifies a payload of its own — its output is the last
  // iteration's raw text — so a schema declared on the group governs nothing.
  'output_format',
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
  // Still inert after #2453: a gate/halt produces no payload to certify.
  'output_format',
  'mutates_checkout',
];

/**
 * Fields a wait cannot consume; its output contract and lifecycle are engine-owned.
 * `output_format` is absent because a wait node REJECTS it outright (the schema's
 * superRefine: the engine fixes the wait's own contract, `waitOutputFormat`), so it
 * never reaches this warn set.
 */
export const WAIT_NODE_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS,
  'idle_timeout',
  // The tree-integrity assertion is enforced only on exec/agent nodes (#2771); a
  // wait's lifecycle is engine-owned and touches no checkout-scoped payload.
  'mutates_checkout',
];

/**
 * Fields that are meaningless on an include node — it inlines another workflow's
 * nodes at load time and executes nothing itself, so every AI/exec field is
 * ignored (the inlined child nodes carry their own). A superset of
 * `BASH_NODE_AI_FIELDS` plus the remaining execution-only base fields (`timeout` is
 * owned by the exec and loop modes, so on an include it is a load error). The structural
 * graph fields the include node DOES use (id / depends_on / when / trigger_rule /
 * description) are deliberately absent. Provider tool-policy enforcement belongs to
 * #2848; workspace boundaries belong to #2490 and #2206.
 */
export const INCLUDE_NODE_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS,
  // Still inert after #2453: an include has no execution site, and the transform
  // drops the field — the included workflow's selected node owns the contract.
  'output_format',
  'retry',
  'output_type',
  'always_run',
  'idle_timeout',
];

/**
 * Fields that are meaningless on a workflow (sub-run) node — it starts a child
 * run and makes no direct provider call, so every AI-turn field is ignored (the
 * child's own nodes carry theirs). `output_format` is absent for the same reason
 * it is absent from WAIT_NODE_IGNORED_FIELDS: the loader REJECTS it outright
 * (#2453 — the child's `returns:` node owns the result contract), so it never
 * reaches this warn set. `output_type` (typed sidecar) and the structural graph
 * fields (id / depends_on / when / trigger_rule / description / input / isolation)
 * are meaningful and absent here.
 */
// `mutates_checkout` is appended rather than filtered out: enforcement (#2771) is
// per-node over the parent checkout, which a sub-run child does not own — its own
// workflow-level declaration governs instead.
export const WORKFLOW_NODE_IGNORED_FIELDS: readonly string[] = [
  ...BASH_NODE_AI_FIELDS.filter(f => f !== 'output_format'),
  'mutates_checkout',
];

/**
 * Which AI-level fields a node kind accepts in YAML but ignores at runtime, with the
 * label the loader's warning uses. The one mapping from node kind to its ignored-field
 * list, so the load-time warning and {@link isOutputFormatEnforced} cannot disagree.
 * Agent nodes have no such list: every AI field is live there.
 */
export function ignoredFieldsForNode(
  node: DagNode | IncludeDirective
): { type: string; fields: readonly string[] } | undefined {
  if (isIncludeDirective(node)) return { type: 'include', fields: INCLUDE_NODE_IGNORED_FIELDS };
  // Same execution-less posture as a static include: the composed body's own nodes
  // carry their config, so AI-level fields declared here are ignored (#2512).
  if (isComposeFanOutNode(node)) return { type: 'include', fields: INCLUDE_NODE_IGNORED_FIELDS };
  if (isHaltNode(node)) return { type: 'cancel', fields: GATE_AND_HALT_IGNORED_FIELDS };
  if (isWorkflowNode(node)) return { type: 'workflow', fields: WORKFLOW_NODE_IGNORED_FIELDS };
  if (isGateNode(node)) return { type: 'approval', fields: GATE_AND_HALT_IGNORED_FIELDS };
  if (isWaitNode(node)) return { type: 'wait', fields: WAIT_NODE_IGNORED_FIELDS };
  if (isLoopNode(node)) return { type: 'loop', fields: LOOP_NODE_AI_FIELDS };
  if (isLoopGroupNode(node)) return { type: 'loop_group', fields: LOOP_GROUP_NODE_AI_FIELDS };
  if (isExecNode(node)) {
    return { type: node.runtime === 'sh' ? 'bash' : 'script', fields: BASH_NODE_AI_FIELDS };
  }
  return undefined;
}

/**
 * Whether the engine enforces this node's `output_format` against its output. Derived
 * from the ignored-field lists rather than enumerated again: a kind whose list names
 * the field (loop_group, gate, halt, include, composed fan-out) is inert, everything
 * else (agent, exec, `loop:`, `workflow:`) certifies or validates against it. The
 * load-time compile gate and the resource validator both read this, so a schema is
 * rejected at load exactly where a broken one would later fail a node. A `workflow:`
 * node's `output_format` is rejected at load by ownership before this predicate is
 * consulted, so its answer there is never reached.
 */
export function isOutputFormatEnforced(node: DagNode | IncludeDirective): boolean {
  return !ignoredFieldsForNode(node)?.fields.includes('output_format');
}
