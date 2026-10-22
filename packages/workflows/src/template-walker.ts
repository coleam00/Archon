import type {
  AgentNode,
  ComposeFanOutNode,
  DagNode,
  ExecNode,
  GateNode,
  LoopGroupNode,
  LoopNode,
  WaitNode,
  WorkflowNode,
} from './schemas';
import type { JsonValue } from './output-ref';
import {
  isAgentNode,
  isBindingDirective,
  isComposeFanOutNode,
  isExecNode,
  isGateNode,
  isHaltNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
} from './schemas';
import {
  COMPILED_LOOP_COMMAND,
  cloneNodeWithEngineMetadata,
  type LoopWithCompiledCommand,
  readComposedBindings,
  readComposedMeta,
} from './compiled-command';

export type TemplateSurface =
  | 'condition'
  | 'prompt'
  | 'shell'
  | 'script'
  | 'value'
  | 'binding_from'
  | 'binding_default';

export type TemplateSlotName =
  | 'when'
  | 'systemPrompt'
  | 'agents.*.prompt'
  | 'agents.*.description'
  | 'agent.prompt'
  | 'binding.value'
  | 'binding.from'
  | 'binding.if_skipped'
  | 'exec.bash'
  | 'exec.script'
  | 'loop.prompt'
  | 'loop.until_bash'
  | 'loop.compiled_prompt'
  | 'loop_group.until_bash'
  | 'approval.message'
  | 'approval.on_reject.prompt'
  | 'cancel.reason'
  | 'wait.until'
  | 'wait.event'
  | 'wait.attention'
  | 'wait.options'
  | 'wait.labels.*'
  | 'workflow.input'
  | 'workflow.with.*'
  | 'workflow.fan_out.items'
  | 'compose_fan_out.with.*'
  | 'compose_fan_out.fan_out.items'
  | 'composed.inputs.*';

export type TemplateValuePosition =
  | 'binding'
  | 'binding_default'
  | 'workflow_with'
  | 'compose_fan_out_with'
  | 'composed_input';

interface SlotDefinition {
  surface: TemplateSurface;
  outputReference: boolean;
  valuePosition?: TemplateValuePosition;
}

/** The complete engine-owned template surface. */
export const SLOT_SPEC = {
  when: { surface: 'condition', outputReference: true },
  systemPrompt: { surface: 'prompt', outputReference: true },
  'agents.*.prompt': { surface: 'prompt', outputReference: true },
  'agents.*.description': { surface: 'prompt', outputReference: true },
  'agent.prompt': { surface: 'prompt', outputReference: true },
  'binding.value': { surface: 'value', outputReference: true, valuePosition: 'binding' },
  'binding.from': { surface: 'binding_from', outputReference: true },
  'binding.if_skipped': {
    surface: 'binding_default',
    outputReference: false,
    valuePosition: 'binding_default',
  },
  'exec.bash': { surface: 'shell', outputReference: true },
  'exec.script': { surface: 'script', outputReference: true },
  'loop.prompt': { surface: 'prompt', outputReference: true },
  'loop.until_bash': { surface: 'shell', outputReference: true },
  'loop.compiled_prompt': { surface: 'prompt', outputReference: true },
  'loop_group.until_bash': { surface: 'shell', outputReference: true },
  'approval.message': { surface: 'prompt', outputReference: true },
  'approval.on_reject.prompt': { surface: 'prompt', outputReference: true },
  'cancel.reason': { surface: 'prompt', outputReference: true },
  'wait.until': { surface: 'value', outputReference: true },
  'wait.event': { surface: 'value', outputReference: true },
  'wait.attention': { surface: 'prompt', outputReference: true },
  'wait.options': { surface: 'value', outputReference: true },
  'wait.labels.*': { surface: 'value', outputReference: true },
  'workflow.input': { surface: 'value', outputReference: true },
  'workflow.with.*': { surface: 'value', outputReference: true, valuePosition: 'workflow_with' },
  'workflow.fan_out.items': { surface: 'value', outputReference: true },
  'compose_fan_out.with.*': {
    surface: 'value',
    outputReference: true,
    valuePosition: 'compose_fan_out_with',
  },
  'compose_fan_out.fan_out.items': { surface: 'value', outputReference: true },
  'composed.inputs.*': { surface: 'value', outputReference: true, valuePosition: 'composed_input' },
} satisfies Record<TemplateSlotName, SlotDefinition>;

export interface TemplateSlot {
  owner: DagNode;
  name: TemplateSlotName;
  path: string;
  surface: TemplateSurface;
  outputReference: boolean;
  value: string;
}

export interface TemplateBinding {
  owner: DagNode;
  name: string;
  path: string;
}

export interface TemplateValueSlot {
  path: string;
  position: TemplateValuePosition;
  value: JsonValue;
}

type SlotCallback = (slot: TemplateSlot, replace: (value: string) => void) => void;
type ValueSlotCallback = (slot: TemplateValueSlot, replace: (value: JsonValue) => void) => void;
type BindingCallback = (binding: TemplateBinding) => void;

interface WalkCallbacks {
  slot: SlotCallback;
  value?: ValueSlotCallback;
  binding?: BindingCallback;
}

/** Reports one node's template positions, with paths under the walk's prefix. */
interface SlotEmitter {
  slot(name: TemplateSlotName, path: string, value: string, replace: (value: string) => void): void;
  valueSlot(
    name: TemplateSlotName,
    path: string,
    value: JsonValue,
    replace: (value: JsonValue) => void
  ): void;
  bindings(
    bindings: Record<string, unknown> | undefined,
    write: (name: string, value: JsonValue) => void
  ): void;
}

function walk(node: DagNode, callbacks: WalkCallbacks, prefix = '', recursive = true): void {
  const emit = slotEmitter(node, callbacks, prefix);
  walkSharedSlots(node, emit);
  if (isAgentNode(node)) walkAgent(node, emit);
  else if (isExecNode(node)) walkExec(node, emit);
  else if (isLoopNode(node)) walkLoop(node, emit);
  else if (isLoopGroupNode(node)) {
    walkLoopGroup(node, emit);
    if (recursive) walkLoopGroupBodies(node, callbacks, prefix);
  } else if (isGateNode(node)) walkGate(node, emit);
  else if (isHaltNode(node))
    emit.slot('cancel.reason', 'cancel', node.reason, value => (node.reason = value));
  else if (isWaitNode(node)) walkWait(node, emit);
  else if (isWorkflowNode(node) || isComposeFanOutNode(node)) walkComposition(node, emit);
  walkComposedInputs(node, emit);
}

function slotEmitter(node: DagNode, callbacks: WalkCallbacks, prefix: string): SlotEmitter {
  const slot: SlotEmitter['slot'] = (name, path, value, replace) => {
    callbacks.slot(
      {
        owner: node,
        name,
        path: `${prefix}${path}`,
        surface: SLOT_SPEC[name].surface,
        outputReference: SLOT_SPEC[name].outputReference,
        value,
      },
      replace
    );
  };
  const valueSlot: SlotEmitter['valueSlot'] = (name, path, value, replace) => {
    const position = (SLOT_SPEC[name] as SlotDefinition).valuePosition;
    if (position !== undefined)
      callbacks.value?.({ path: `${prefix}${path}`, position, value }, replace);
  };
  const bindings: SlotEmitter['bindings'] = (bindings, write) => {
    for (const [name, binding] of Object.entries(bindings ?? {})) {
      callbacks.binding?.({ owner: node, name, path: `${prefix}with.${name}` });
      if (typeof binding === 'string') {
        slot('binding.value', `with.${name}`, binding, value => {
          write(name, value);
        });
        valueSlot('binding.value', `with.${name}`, binding, value => {
          write(name, value);
        });
      } else if (isBindingDirective(binding)) {
        slot('binding.from', `with.${name}.from`, binding.from, value => (binding.from = value));
        if (binding.if_skipped !== undefined) {
          if (typeof binding.if_skipped === 'string')
            slot(
              'binding.if_skipped',
              `with.${name}.if_skipped`,
              binding.if_skipped,
              value => (binding.if_skipped = value)
            );
          valueSlot('binding.if_skipped', `with.${name}.if_skipped`, binding.if_skipped, value => {
            binding.if_skipped = value;
          });
        }
      }
    }
  };
  return { slot, valueSlot, bindings };
}

/** Slots every node kind can carry. */
function walkSharedSlots(node: DagNode, emit: SlotEmitter): void {
  if (node.when !== undefined) emit.slot('when', 'when', node.when, value => (node.when = value));
  if (node.systemPrompt !== undefined)
    emit.slot(
      'systemPrompt',
      'systemPrompt',
      node.systemPrompt,
      value => (node.systemPrompt = value)
    );
  for (const [id, agent] of Object.entries(node.agents ?? {})) {
    emit.slot(
      'agents.*.prompt',
      `agents.${id}.prompt`,
      agent.prompt,
      value => (agent.prompt = value)
    );
    emit.slot(
      'agents.*.description',
      `agents.${id}.description`,
      agent.description,
      value => (agent.description = value)
    );
  }
}

function walkAgent(node: AgentNode, emit: SlotEmitter): void {
  if (node.source.kind === 'inline') {
    const source = node.source;
    emit.slot('agent.prompt', 'prompt', source.prompt, value => (source.prompt = value));
    // A materialized command node keeps its bindings in the engine-private payload
    // (#2964); they are the same template surface as an unmaterialized `with:` map, so
    // an enclosing include namespaces their refs and forwards its own inputs into them.
    const composedBindings = readComposedBindings(node);
    if (composedBindings !== undefined)
      emit.bindings(composedBindings, (name, value) => (composedBindings[name] = value));
  } else {
    emit.bindings(node.source.with, (name, value) => {
      if (node.source.kind === 'command' && node.source.with !== undefined)
        node.source.with[name] = value as never;
    });
  }
}

function walkExec(node: ExecNode, emit: SlotEmitter): void {
  emit.slot(
    node.runtime === 'sh' ? 'exec.bash' : 'exec.script',
    node.runtime === 'sh' ? 'bash' : 'script',
    node.script,
    value => (node.script = value)
  );
  emit.bindings(node.with, (name, value) => {
    if (node.with !== undefined) node.with[name] = value as never;
  });
}

function walkLoop(node: LoopNode, emit: SlotEmitter): void {
  if (typeof node.loop.prompt === 'string')
    emit.slot('loop.prompt', 'loop.prompt', node.loop.prompt, value => (node.loop.prompt = value));
  if (node.loop.until_bash !== undefined)
    emit.slot(
      'loop.until_bash',
      'loop.until_bash',
      node.loop.until_bash,
      value => (node.loop.until_bash = value)
    );
  const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND];
  if (compiled?.prompt !== undefined)
    emit.slot(
      'loop.compiled_prompt',
      'loop.compiled_prompt',
      compiled.prompt,
      value => (compiled.prompt = value)
    );
}

function walkLoopGroup(node: LoopGroupNode, emit: SlotEmitter): void {
  if (node.loop_group.until_bash !== undefined)
    emit.slot(
      'loop_group.until_bash',
      'loop_group.until_bash',
      node.loop_group.until_bash,
      value => (node.loop_group.until_bash = value)
    );
}

function walkLoopGroupBodies(node: LoopGroupNode, callbacks: WalkCallbacks, prefix: string): void {
  for (const [index, body] of node.loop_group.nodes.entries())
    if (!isIncludeDirective(body))
      walk(body, callbacks, `${prefix}loop_group.nodes.${index}.`, true);
}

function walkGate(node: GateNode, emit: SlotEmitter): void {
  emit.slot('approval.message', 'approval.message', node.message, value => (node.message = value));
  for (const decision of node.decisions) {
    const rework = decision.rework;
    if (rework !== undefined)
      emit.slot(
        'approval.on_reject.prompt',
        'approval.on_reject.prompt',
        rework.prompt,
        value => (rework.prompt = value)
      );
  }
}

function walkWait(node: WaitNode, emit: SlotEmitter): void {
  if (node.wait.until !== undefined)
    emit.slot('wait.until', 'wait.until', node.wait.until, value => (node.wait = { until: value }));
  const deadlineMs = node.wait.deadline_ms;
  if (node.wait.event !== undefined && deadlineMs !== undefined)
    emit.slot(
      'wait.event',
      'wait.event',
      node.wait.event,
      value => (node.wait = { event: value, deadline_ms: deadlineMs })
    );
  // Each replace re-reads `node.wait`, so mapping both slots keeps both results.
  if (node.wait.attention !== undefined)
    emit.slot('wait.attention', 'wait.attention', node.wait.attention, value => {
      const wait = node.wait;
      if (wait.attention !== undefined) node.wait = { ...wait, attention: value };
    });
  if (typeof node.wait.options === 'string')
    emit.slot('wait.options', 'wait.options', node.wait.options, value => {
      const wait = node.wait;
      if (wait.attention !== undefined) node.wait = { ...wait, options: value };
    });
  for (const [key, label] of Object.entries(node.wait.labels ?? {}))
    emit.slot('wait.labels.*', `wait.labels.${key}`, label, value => {
      const wait = node.wait;
      if (wait.attention !== undefined)
        node.wait = { ...wait, labels: { ...wait.labels, [key]: value } };
    });
}

function walkComposition(node: WorkflowNode | ComposeFanOutNode, emit: SlotEmitter): void {
  const workflow = isWorkflowNode(node);
  if (workflow && node.input !== undefined)
    emit.slot('workflow.input', 'input', node.input, value => (node.input = value));
  const withName: TemplateSlotName = workflow ? 'workflow.with.*' : 'compose_fan_out.with.*';
  const withMap = node.with;
  if (withMap !== undefined)
    for (const [name, value] of Object.entries(withMap)) {
      if (typeof value === 'string')
        emit.slot(withName, `with.${name}`, value, next => (withMap[name] = next));
      emit.valueSlot(withName, `with.${name}`, value, next => (withMap[name] = next));
    }
  const fanOutName: TemplateSlotName = workflow
    ? 'workflow.fan_out.items'
    : 'compose_fan_out.fan_out.items';
  const fanOut = node.fan_out;
  if (fanOut !== undefined)
    emit.slot(fanOutName, 'fan_out.items', fanOut.items, value => (fanOut.items = value));
}

function walkComposedInputs(node: DagNode, emit: SlotEmitter): void {
  const inputs = readComposedMeta(node)?.inputs;
  if (inputs === undefined) return;
  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value === 'string')
      emit.slot(
        'composed.inputs.*',
        `composed.inputs.${name}`,
        value,
        next => (inputs[name] = next)
      );
    emit.valueSlot(
      'composed.inputs.*',
      `composed.inputs.${name}`,
      value,
      next => (inputs[name] = next)
    );
  }
}

export function visitNodeTemplateSlots(
  node: DagNode,
  visitor: (slot: TemplateSlot) => void,
  options?: { recursive?: boolean; bindingVisitor?: (binding: TemplateBinding) => void }
): void {
  walk(
    node,
    {
      slot: slot => {
        visitor(slot);
      },
      binding: options?.bindingVisitor,
    },
    '',
    options?.recursive ?? true
  );
}

/** Return a deep-enough clone of a node with every text template slot mapped exactly once. */
export function mapNodeTemplateSlots(
  node: DagNode,
  mapper: (slot: TemplateSlot) => string
): DagNode {
  const clone = cloneNodeWithEngineMetadata(node);
  walk(clone, {
    slot: (slot, replace) => {
      replace(mapper(slot));
    },
  });
  return clone;
}

/** Return a clone with every JSON-capable template position mapped exactly once. */
export function mapNodeTemplateValueSlots(
  node: DagNode,
  mapper: (slot: TemplateValueSlot) => JsonValue
): DagNode {
  const clone = cloneNodeWithEngineMetadata(node);
  walk(clone, {
    slot: () => undefined,
    value: (slot, replace) => {
      replace(mapper(slot));
    },
  });
  return clone;
}
