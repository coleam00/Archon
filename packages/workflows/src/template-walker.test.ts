import { expect, test } from 'bun:test';
import type { DagNode } from './schemas';
import type { TemplateSlotName, TemplateSurface } from './template-walker';
import {
  mapNodeTemplateSlots,
  mapNodeTemplateValueSlots,
  visitNodeTemplateSlots,
} from './template-walker';

test('the slot catalogue rejects omitted fixed fields', () => {
  // @ts-expect-error approval.on_reject.prompt must remain catalogued
  const incomplete: Record<TemplateSlotName, { surface: TemplateSurface }> = {
    when: { surface: 'condition' },
    systemPrompt: { surface: 'prompt' },
    'agents.*.prompt': { surface: 'prompt' },
    'agents.*.description': { surface: 'prompt' },
    'agent.prompt': { surface: 'prompt' },
    'binding.value': { surface: 'value' },
    'binding.from': { surface: 'binding_from' },
    'binding.if_skipped': { surface: 'binding_default' },
    'exec.bash': { surface: 'shell' },
    'exec.script': { surface: 'script' },
    'loop.prompt': { surface: 'prompt' },
    'loop.until_bash': { surface: 'shell' },
    'loop.compiled_prompt': { surface: 'prompt' },
    'loop_group.until_bash': { surface: 'shell' },
    'approval.message': { surface: 'prompt' },
    'cancel.reason': { surface: 'prompt' },
    'wait.until': { surface: 'value' },
    'wait.event': { surface: 'value' },
    'workflow.input': { surface: 'value' },
    'workflow.with.*': { surface: 'value' },
    'workflow.fan_out.items': { surface: 'value' },
    'compose_fan_out.with.*': { surface: 'value' },
    'compose_fan_out.fan_out.items': { surface: 'value' },
    'composed.inputs.*': { surface: 'value' },
  };
  expect(incomplete['approval.on_reject.prompt']).toBeUndefined();
});

test('walks dynamic template slots without mutating the source node', () => {
  const node = {
    id: 'group',
    kind: 'loop_group',
    systemPrompt: '$setup.output',
    agents: { reviewer: { prompt: '$setup.output', description: '$setup.output' } },
    loop_group: {
      until_bash: 'test $setup.output',
      nodes: [
        {
          id: 'run',
          kind: 'exec',
          runtime: 'bun',
          script: 'console.log($setup.output)',
          with: {
            value: '$setup.output',
            required: { from: '$setup.output', if_skipped: '$setup.output' },
            literal: true,
          },
        },
      ],
    },
  } as unknown as DagNode;

  const slots: string[] = [];
  const bindings: string[] = [];
  visitNodeTemplateSlots(node, slot => slots.push(`${slot.path}:${slot.surface}`), {
    bindingVisitor: binding => bindings.push(`${binding.owner.id}:${binding.path}:${binding.name}`),
  });
  expect(slots).toEqual([
    'systemPrompt:prompt',
    'agents.reviewer.prompt:prompt',
    'agents.reviewer.description:prompt',
    'loop_group.until_bash:shell',
    'loop_group.nodes.0.script:script',
    'loop_group.nodes.0.with.value:value',
    'loop_group.nodes.0.with.required.from:binding_from',
    'loop_group.nodes.0.with.required.if_skipped:binding_default',
  ]);
  expect(bindings).toEqual([
    'run:loop_group.nodes.0.with.value:value',
    'run:loop_group.nodes.0.with.required:required',
    'run:loop_group.nodes.0.with.literal:literal',
  ]);

  const mapped = mapNodeTemplateSlots(node, slot => slot.value.replace('$setup', '$renamed'));
  expect(mapped).not.toBe(node);
  expect(JSON.stringify(node)).toContain('$setup.output');
  expect(JSON.stringify(mapped)).toContain('$renamed.output');
  if (mapped.kind !== 'loop_group') throw new Error('expected loop group');
  expect(mapped.loop_group.nodes[0]).toMatchObject({
    with: { literal: true },
  });

  const values = mapNodeTemplateValueSlots(node, slot =>
    slot.value === '$setup.output' ? { forwarded: true } : slot.value
  );
  if (values.kind !== 'loop_group' || values.loop_group.nodes[0]?.kind !== 'exec')
    throw new Error('expected loop group exec node');
  expect(values.loop_group.nodes[0].with).toMatchObject({
    value: { forwarded: true },
    required: { from: '$setup.output', if_skipped: { forwarded: true } },
    literal: true,
  });
});
