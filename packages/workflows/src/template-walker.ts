import type { DagNode } from './schemas';
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
  COMPOSED_NODE,
  COMPILED_LOOP_COMMAND,
  attachComposedBindings,
  type LoopWithCompiledCommand,
  readComposedBindings,
  readComposedMeta,
  type NodeWithComposedMeta,
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

function walk(
  node: DagNode,
  callback: SlotCallback,
  valueCallback?: ValueSlotCallback,
  bindingCallback?: BindingCallback,
  prefix = '',
  recursive = true
): void {
  const slot = (
    name: TemplateSlotName,
    path: string,
    value: string,
    replace: (value: string) => void
  ): void => {
    callback(
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
  const valueSlot = (
    name: TemplateSlotName,
    path: string,
    value: JsonValue,
    replace: (value: JsonValue) => void
  ): void => {
    const position = (SLOT_SPEC[name] as SlotDefinition).valuePosition;
    if (position !== undefined)
      valueCallback?.({ path: `${prefix}${path}`, position, value }, replace);
  };
  const walkBindings = (
    bindings: Record<string, unknown> | undefined,
    write: (name: string, value: JsonValue) => void
  ): void => {
    for (const [name, binding] of Object.entries(bindings ?? {})) {
      bindingCallback?.({ owner: node, name, path: `${prefix}with.${name}` });
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

  if (node.when !== undefined) slot('when', 'when', node.when, value => (node.when = value));
  if (node.systemPrompt !== undefined)
    slot('systemPrompt', 'systemPrompt', node.systemPrompt, value => (node.systemPrompt = value));
  for (const [id, agent] of Object.entries(node.agents ?? {})) {
    slot('agents.*.prompt', `agents.${id}.prompt`, agent.prompt, value => (agent.prompt = value));
    slot(
      'agents.*.description',
      `agents.${id}.description`,
      agent.description,
      value => (agent.description = value)
    );
  }

  if (isAgentNode(node)) {
    if (node.source.kind === 'inline') {
      const source = node.source;
      slot('agent.prompt', 'prompt', source.prompt, value => (source.prompt = value));
      // A materialized command node keeps its bindings in the engine-private payload
      // (#2964); they are the same template surface as an unmaterialized `with:` map, so
      // an enclosing include namespaces their refs and forwards its own inputs into them.
      const composedBindings = readComposedBindings(node);
      if (composedBindings !== undefined)
        walkBindings(composedBindings, (name, value) => (composedBindings[name] = value));
    } else {
      walkBindings(node.source.with, (name, value) => {
        if (node.source.kind === 'command' && node.source.with !== undefined)
          node.source.with[name] = value as never;
      });
    }
  } else if (isExecNode(node)) {
    slot(
      node.runtime === 'sh' ? 'exec.bash' : 'exec.script',
      node.runtime === 'sh' ? 'bash' : 'script',
      node.script,
      value => (node.script = value)
    );
    walkBindings(node.with, (name, value) => {
      if (node.with !== undefined) node.with[name] = value as never;
    });
  } else if (isLoopNode(node)) {
    if (typeof node.loop.prompt === 'string')
      slot('loop.prompt', 'loop.prompt', node.loop.prompt, value => (node.loop.prompt = value));
    if (node.loop.until_bash !== undefined)
      slot(
        'loop.until_bash',
        'loop.until_bash',
        node.loop.until_bash,
        value => (node.loop.until_bash = value)
      );
    const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled?.prompt !== undefined)
      slot(
        'loop.compiled_prompt',
        'loop.compiled_prompt',
        compiled.prompt,
        value => (compiled.prompt = value)
      );
  } else if (isLoopGroupNode(node)) {
    if (node.loop_group.until_bash !== undefined)
      slot(
        'loop_group.until_bash',
        'loop_group.until_bash',
        node.loop_group.until_bash,
        value => (node.loop_group.until_bash = value)
      );
    if (recursive)
      for (const [index, body] of node.loop_group.nodes.entries())
        if (!isIncludeDirective(body))
          walk(
            body,
            callback,
            valueCallback,
            bindingCallback,
            `${prefix}loop_group.nodes.${index}.`,
            recursive
          );
  } else if (isGateNode(node)) {
    slot('approval.message', 'approval.message', node.message, value => (node.message = value));
    for (const decision of node.decisions) {
      const rework = decision.rework;
      if (rework !== undefined)
        slot(
          'approval.on_reject.prompt',
          'approval.on_reject.prompt',
          rework.prompt,
          value => (rework.prompt = value)
        );
    }
  } else if (isHaltNode(node)) {
    slot('cancel.reason', 'cancel', node.reason, value => (node.reason = value));
  } else if (isWaitNode(node)) {
    if (node.wait.until !== undefined)
      slot('wait.until', 'wait.until', node.wait.until, value => (node.wait = { until: value }));
    const deadlineMs = node.wait.deadline_ms;
    if (node.wait.event !== undefined && deadlineMs !== undefined)
      slot(
        'wait.event',
        'wait.event',
        node.wait.event,
        value => (node.wait = { event: value, deadline_ms: deadlineMs })
      );
    if (node.wait.attention !== undefined)
      slot('wait.attention', 'wait.attention', node.wait.attention, value => {
        node.wait = { attention: value };
      });
  } else if (isWorkflowNode(node) || isComposeFanOutNode(node)) {
    if (isWorkflowNode(node) && node.input !== undefined)
      slot('workflow.input', 'input', node.input, value => (node.input = value));
    const withName: TemplateSlotName = isWorkflowNode(node)
      ? 'workflow.with.*'
      : 'compose_fan_out.with.*';
    const withMap = node.with;
    if (withMap !== undefined)
      for (const [name, value] of Object.entries(withMap)) {
        if (typeof value === 'string')
          slot(withName, `with.${name}`, value, next => (withMap[name] = next));
        valueSlot(withName, `with.${name}`, value, next => (withMap[name] = next));
      }
    const fanOutName: TemplateSlotName = isWorkflowNode(node)
      ? 'workflow.fan_out.items'
      : 'compose_fan_out.fan_out.items';
    const fanOut = node.fan_out;
    if (fanOut !== undefined)
      slot(fanOutName, 'fan_out.items', fanOut.items, value => (fanOut.items = value));
  }

  const inputs = readComposedMeta(node)?.inputs;
  if (inputs !== undefined)
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value === 'string')
        slot('composed.inputs.*', `composed.inputs.${name}`, value, next => (inputs[name] = next));
      valueSlot(
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
    slot => {
      visitor(slot);
    },
    undefined,
    options?.bindingVisitor,
    '',
    options?.recursive ?? true
  );
}

/** Return a deep-enough clone of a node with every text template slot mapped exactly once. */
export function mapNodeTemplateSlots(
  node: DagNode,
  mapper: (slot: TemplateSlot) => string
): DagNode {
  const clone = cloneNode(node);
  walk(clone, (slot, replace) => {
    replace(mapper(slot));
  });
  return clone;
}

/** Return a clone with every JSON-capable template position mapped exactly once. */
export function mapNodeTemplateValueSlots(
  node: DagNode,
  mapper: (slot: TemplateValueSlot) => JsonValue
): DagNode {
  const clone = cloneNode(node);
  walk(
    clone,
    () => undefined,
    (slot, replace) => {
      replace(mapper(slot));
    },
    undefined
  );
  return clone;
}

function cloneNode(node: DagNode): DagNode {
  const clone = structuredClone(node);
  preserveInternalMetadata(node, clone);
  return clone;
}

function preserveInternalMetadata(source: DagNode, target: DagNode): void {
  const meta = readComposedMeta(source);
  if (meta !== undefined)
    (target as DagNode & NodeWithComposedMeta)[COMPOSED_NODE] = structuredClone(meta);
  const bindings = readComposedBindings(source);
  if (bindings !== undefined) attachComposedBindings(target, structuredClone(bindings));
  if (isLoopNode(source) && isLoopNode(target)) {
    const compiled = (source.loop as typeof source.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled !== undefined)
      (target.loop as typeof target.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND] =
        structuredClone(compiled);
  }
  if (isLoopGroupNode(source) && isLoopGroupNode(target))
    for (const [index, sourceBody] of source.loop_group.nodes.entries()) {
      const targetBody = target.loop_group.nodes[index];
      if (
        targetBody !== undefined &&
        !isIncludeDirective(sourceBody) &&
        !isIncludeDirective(targetBody)
      )
        preserveInternalMetadata(sourceBody, targetBody);
    }
}
