/**
 * The transform half of `dagNodeSchema`: one builder per node mode turns a validated
 * flat node into the `DagNode` (or `IncludeDirective`) that mode describes. Every
 * builder copies only the fields its kind carries, and only the ones the author set.
 */
import type { AgentNode } from './agent-node';
import type { DagNode, DagNodeFields, LoopGroupNode, NodeMode } from './dag-node';
import {
  bashExecAuthoringSchema,
  type ExecNode,
  resolveBashExecAuthoring,
  resolveScriptExecAuthoring,
  scriptExecAuthoringSchema,
} from './exec-node';
import { type DecisionOption, type GateNode, getApprovalDecisions } from './gate-node';
import type { HaltNode } from './halt-node';
import {
  type ComposeFanOutNode,
  composeFanOutNodeSchema,
  type IncludeDirective,
  includeDirectiveSchema,
} from './include-node';
import { loopAiAuthoringSchema, type LoopNode } from './loop-node';
import { nodeBindingsSchema } from './node-bindings';
import type { NodeMcp } from './provider-options';
import { loopRetryConfigSchema } from './retry';
import { type WaitNode, waitOutputFormat } from './wait-node';
import { type WorkflowNode, workflowNodeSchema } from './workflow-node';

type NodeBuilder = (data: DagNodeFields) => DagNode | IncludeDirective;

/** Builds the node `mode` selects. The superRefine has already validated `data`. */
export function normalizeDagNode(data: DagNodeFields, mode: NodeMode): DagNode | IncludeDirective {
  return NODE_BUILDERS[mode](data);
}

/** The selected mode's own field, which mode selection guarantees is set. */
function selectedField<T>(value: T | undefined, mode: NodeMode): T {
  if (value === undefined)
    throw new Error(`unreachable: ${mode} must be defined after superRefine`);
  return value;
}

/** The fields among `keys` that the author set, in `keys` order. */
function definedFields<K extends keyof DagNodeFields>(
  data: DagNodeFields,
  keys: readonly K[]
): Partial<Pick<DagNodeFields, K>> {
  const fields: Partial<Pick<DagNodeFields, K>> = {};
  for (const key of keys) {
    if (data[key] !== undefined) fields[key] = data[key];
  }
  return fields;
}

/**
 * Structural graph fields present on every node — including the execution-less
 * include node, which carries ONLY these.
 */
function structuralFields(data: DagNodeFields) {
  return {
    id: data.id.trim(),
    ...definedFields(data, ['description']),
    ...(data.depends_on !== undefined && data.depends_on.length > 0
      ? { depends_on: data.depends_on }
      : {}),
    ...definedFields(data, ['when', 'trigger_rule']),
  };
}

/** Structural fields plus the scheduling fields of a node that executes. */
function executableFields(data: DagNodeFields) {
  return {
    ...structuralFields(data),
    ...definedFields(data, ['idle_timeout', 'always_run', 'mutates_checkout', 'output_type']),
  };
}

/** Provider-call fields; each node mode selects the fields it supports. */
function providerFields(data: DagNodeFields) {
  return {
    ...definedFields(data, [
      'model',
      'provider',
      'context',
      'output_format',
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
    ]),
    // Overwriting a key keeps its position, so these stay in list order.
    ...(data.mcp !== undefined ? { mcp: trimNodeMcp(data.mcp) } : {}),
    ...(data.skills !== undefined ? { skills: data.skills.map(s => s.trim()) } : {}),
  };
}

function trimNodeMcp(mcp: NodeMcp): NodeMcp {
  return typeof mcp === 'string' ? mcp.trim() : { ...mcp, path: mcp.path.trim() };
}

const NODE_BUILDERS: Record<NodeMode, NodeBuilder> = {
  command: data =>
    ({
      ...executableFields(data),
      ...definedFields(data, ['retry']),
      ...providerFields(data),
      kind: 'agent',
      source: {
        kind: 'command',
        name: selectedField(data.command, 'command').trim(),
        ...(data.with !== undefined ? { with: nodeBindingsSchema.parse(data.with) } : {}),
      },
    }) as AgentNode,
  prompt: data =>
    ({
      ...executableFields(data),
      ...definedFields(data, ['retry']),
      ...providerFields(data),
      kind: 'agent',
      source: { kind: 'inline', prompt: selectedField(data.prompt, 'prompt').trim() },
    }) as AgentNode,
  bash: data =>
    ({
      ...executableFields(data),
      ...definedFields(data, ['retry']),
      kind: 'exec',
      ...resolveBashExecAuthoring(bashExecAuthoringSchema.parse(data)),
      // Kept for the same reason as on a `loop:` node: since #2453 an exec node with a
      // declared schema certifies its OWN stdout — strict JSON, the shared ajv gate,
      // then canonical text plus the logical value — so the schema must survive the
      // transform to reach `certifyExecOutput`. It is a base field, not exec authoring,
      // which is why it rides beside the resolved authoring rather than inside it.
      ...definedFields(data, ['output_format']),
    }) satisfies ExecNode,
  script: data =>
    ({
      ...executableFields(data),
      ...definedFields(data, ['retry']),
      kind: 'exec',
      ...resolveScriptExecAuthoring(scriptExecAuthoringSchema.parse(data)),
      // Same as the bash builder (#2453) — the node certifies its own stdout.
      ...definedFields(data, ['output_format']),
    }) satisfies ExecNode,
  approval: data => {
    const approval = selectedField(data.approval, 'approval');
    return {
      ...executableFields(data),
      ...definedFields(data, ['retry']),
      kind: 'gate',
      message: approval.message,
      decisions: gateDecisions(approval),
      decisionsAuthored: approval.decisions !== undefined,
      captureResponse: approval.capture_response ?? false,
    } as GateNode;
  },
  wait: data => {
    const wait = selectedField(data.wait, 'wait');
    return {
      ...executableFields(data),
      kind: 'wait',
      wait,
      output_format: waitOutputFormat(wait),
    } as WaitNode;
  },
  cancel: data =>
    ({
      ...executableFields(data),
      ...definedFields(data, ['retry']),
      kind: 'halt',
      reason: selectedField(data.cancel, 'cancel').trim(),
    }) as HaltNode,
  include: data => {
    const include = selectedField(data.include, 'include');
    // Runtime-width composition survives expansion so the executor can resolve its items.
    if (data.fan_out !== undefined) {
      return {
        ...structuralFields(data),
        kind: 'compose_fan_out',
        include,
        ...(data.with !== undefined
          ? { with: composeFanOutNodeSchema.shape.with.unwrap().parse(data.with) }
          : {}),
        fan_out: data.fan_out,
      } as ComposeFanOutNode;
    }
    // Static includes carry only graph fields and load-time bindings. The loader warns
    // about ignored executable fields through INCLUDE_NODE_IGNORED_FIELDS.
    return {
      ...structuralFields(data),
      kind: 'include',
      include,
      ...(data.with !== undefined
        ? { with: includeDirectiveSchema.shape.with.unwrap().parse(data.with) }
        : {}),
    } as IncludeDirective;
  },
  // A workflow (sub-run) node makes no direct provider call, so it carries only the
  // structural graph fields plus the sub-run surface: the target name, the input data
  // string, the isolation mode, and `output_type` (typed sidecar). `output_format` is
  // copied through ONLY so the loader can reject it by node id (#2453): the child's
  // `returns:` node owns the result contract. Provider fields, retry, and the other
  // scheduling fields are dropped; the loader warns about them via
  // WORKFLOW_NODE_IGNORED_FIELDS.
  workflow: data =>
    ({
      ...structuralFields(data),
      kind: 'workflow',
      ...definedFields(data, ['output_type', 'output_format']),
      workflow: selectedField(data.workflow, 'workflow').trim(),
      ...definedFields(data, ['input']),
      // `with:` supplies named $INPUTS to the child sub-run (#2470), validated in shape
      // by the superRefine and mutually exclusive with `input:`. Mirrors the include
      // builder's `with` assembly.
      ...(data.with !== undefined
        ? { with: workflowNodeSchema.shape.with.unwrap().parse(data.with) }
        : {}),
      // Isolation is EXPLICIT-ONLY — never inferred, including from `fan_out`. How many
      // children a node spawns says nothing about whether they write; N review or
      // research children over the shared checkout is the common case. A shared-checkout
      // fan-out whose children would collide is caught at spawn time instead
      // (executeFanOutWorkflowNode), where the child's `mutates_checkout` is knowable.
      ...definedFields(data, ['isolation', 'fan_out']),
    }) as WorkflowNode,
  // Provider fields ride along so group-level model/provider survive parsing — the
  // executor forwards them to body AI nodes unless overridden per-node. The REMAINING
  // provider fields are the ones LOOP_GROUP_NODE_AI_FIELDS declares unsupported: the
  // loader warns about and ignores them at runtime.
  loop_group: data =>
    ({
      ...executableFields(data),
      ...providerFields(data),
      kind: 'loop_group',
      loop_group: selectedField(data.loop_group, 'loop_group'),
      ...definedFields(data, ['timeout']),
    }) as LoopGroupNode,
  loop: data =>
    ({
      ...executableFields(data),
      ...loopAiAuthoringSchema.parse(data),
      ...(data.retry !== undefined ? { retry: loopRetryConfigSchema.parse(data.retry) } : {}),
      kind: 'loop',
      loop: selectedField(data.loop, 'loop'),
      ...definedFields(data, ['timeout']),
    }) satisfies LoopNode,
};

/**
 * Two mechanisms, mutually exclusive (enforced by validateApprovalNode): legacy
 * 'on_reject' synthesizes a 'reject' decision carrying a 'rework' continuation —
 * dag-executor's existing reject-resume path (a synthetic AI re-prompt with a
 * max-attempts counter) stays byte-identical, reading from this same synthesized shape
 * (#2707 step 1's "grow-then-deprecate": nothing breaks by rename). A gate with no
 * 'on_reject' AND an explicitly authored 'approval.decisions:' uses the new mechanism —
 * see GateNode.decisionsAuthored's doc for why THAT exact field (not merely "no
 * on_reject") is the mode signal: no pre-PR workflow can have authored 'decisions:', so
 * every already-authored gate — including a bare one, or one only setting
 * capture_response — is unaffected regardless of on_reject.
 */
function gateDecisions(approval: NonNullable<DagNodeFields['approval']>): DecisionOption[] {
  if (approval.on_reject === undefined) return getApprovalDecisions(approval);
  return [
    { id: 'approve' },
    {
      id: 'reject',
      rework: {
        prompt: approval.on_reject.prompt,
        ...(approval.on_reject.max_attempts !== undefined
          ? { maxAttempts: approval.on_reject.max_attempts }
          : {}),
      },
    },
  ];
}
