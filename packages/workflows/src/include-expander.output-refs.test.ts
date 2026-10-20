import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { wf, mapOf, nodeById, inlinePrompt, bashScript } from './include-expander.fixtures';

describe('expandWorkflowIncludes — shorthand when: refs', () => {
  test('renames a shorthand $sibling.field ref inside an internal when:', () => {
    const block = wf('shbk', [
      { id: 'sib', bash: 'echo hi' },
      { id: 'e', prompt: 'e', when: "$sib.exit_code == '0'", depends_on: ['sib'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'shbk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'inc__e')?.when).toBe("$inc__sib.exit_code == '0'");
  });

  test('renames a shorthand $includeId.field ref on a downstream parent node', () => {
    const block = wf('blk1', [{ id: 'only', bash: 'echo hi' }]);
    const parent = wf('parent', [
      { id: 'inc', include: 'blk1' },
      { id: 'after', prompt: 'after', when: "$inc.exit_code == '0'", depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    expect(nodeById(workflows.get('parent')!, 'after')?.when).toBe("$inc__only.exit_code == '0'");
  });

  test('still renames the canonical $id.output form in when:', () => {
    const block = wf('blk2', [
      { id: 'a', bash: 'echo a' },
      { id: 'b', prompt: 'b', when: "$a.output == 'x'", depends_on: ['a'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk2' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(block, parent));
    expect(nodeById(workflows.get('parent')!, 'inc__b')?.when).toBe("$inc__a.output == 'x'");
  });

  test('rejects an external shorthand ref even when the parent has a colliding id', () => {
    const block = wf('blk3', [{ id: 'task', prompt: 'work', when: "$caller.status == 'ok'" }]);
    const parent = wf('parent', [
      { id: 'caller', bash: 'echo parent' },
      { id: 'inc', include: 'blk3', depends_on: ['caller'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "field 'when' references unknown node '$caller.status'"
    );
  });
});

describe('expandWorkflowIncludes — refs in Markdown code spans', () => {
  test('rewrites refs both outside and inside a fenced example', () => {
    const block = wf('blk', [
      { id: 'helper', bash: 'echo hi' },
      {
        id: 'writer',
        prompt: 'Live: $helper.output\n```\nexample: $helper.output\n```',
        depends_on: ['helper'],
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const writer = nodeById(workflows.get('parent')!, 'inc__writer');
    const prompt = inlinePrompt(writer) ?? '';
    expect(prompt).toContain('Live: $inc__helper.output');
    expect(prompt).toContain('```\nexample: $inc__helper.output\n```');
  });

  test('bash refs are rewritten verbatim (code fields are not fence-protected)', () => {
    const block = wf('blk', [
      { id: 'a', bash: 'echo a' },
      { id: 'b', bash: 'echo $a.output', depends_on: ['a'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(block, parent));
    const b = nodeById(workflows.get('parent')!, 'inc__b');
    expect(bashScript(b) ?? '').toBe('echo $inc__a.output');
  });

  test('rewrites approval rejection prompts to the included sibling namespace', () => {
    const block = wf('approval-block', [
      { id: 'plan', prompt: 'plan' },
      {
        id: 'gate',
        approval: {
          message: 'Approve $plan.output',
          on_reject: { prompt: 'Revise $plan.output' },
        },
        depends_on: ['plan'],
      },
    ]);
    const parent = wf('parent', [
      { id: 'plan', prompt: 'parent plan' },
      { id: 'inc', include: 'approval-block', depends_on: ['plan'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const gate = nodeById(workflows.get('parent')!, 'inc__gate');
    expect(gate && 'message' in gate ? gate.message : '').toBe('Approve $inc__plan.output');
    expect(
      (gate && 'decisions' in gate
        ? gate.decisions.find(d => d.id === 'reject')?.rework?.prompt
        : undefined) ?? ''
    ).toBe('Revise $inc__plan.output');
  });

  test('workflow: node in an included block — id namespaced, input: refs rewritten, target untouched', () => {
    const block = wf('blk', [
      { id: 'plan', bash: 'echo plan' },
      { id: 'sub', workflow: 'child-target', input: 'goal: $plan.output', depends_on: ['plan'] },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const sub = nodeById(workflows.get('parent')!, 'inc__sub');
    expect(sub).toBeDefined();
    expect(sub && 'input' in sub ? sub.input : '').toBe('goal: $inc__plan.output');
    expect(sub && 'workflow' in sub ? sub.workflow : '').toBe('child-target');
  });

  test('fan_out.items refs rewritten inside an included block', () => {
    const block = wf('fanblk', [
      { id: 'plan', bash: 'echo tasks' },
      {
        id: 'work',
        workflow: 'child-target',
        depends_on: ['plan'],
        fan_out: { items: '$plan.output.tasks' },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'fanblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const work = nodeById(workflows.get('parent')!, 'inc__work');
    expect(work).toBeDefined();
    expect(work && 'fan_out' in work ? work.fan_out?.items : '').toBe('$inc__plan.output.tasks');
    expect(work && 'workflow' in work ? work.workflow : '').toBe('child-target');
  });
});

describe('expandWorkflowIncludes — systemPrompt/agents are node-ref surfaces (#2476)', () => {
  test('namespaces $node.output refs in systemPrompt and every agents field', () => {
    const block = wf('blk', [
      { id: 'gather', bash: 'echo data' },
      {
        id: 'use',
        prompt: 'work',
        depends_on: ['gather'],
        systemPrompt: 'context: $gather.output',
        agents: {
          helper: { description: 'reads $gather.output', prompt: 'act on $gather.output' },
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'blk' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    const use = nodeById(workflows.get('parent')!, 'inc__use')!;
    expect(use.systemPrompt).toBe('context: $inc__gather.output');
    expect(use.agents?.helper.description).toBe('reads $inc__gather.output');
    expect(use.agents?.helper.prompt).toBe('act on $inc__gather.output');
  });
});

test('include aliases and prior-iteration namespaces retain complete nested suffixes', () => {
  const block = wf('nested-block', [
    { id: 'work', bash: 'echo json' },
    {
      id: 'read',
      prompt: '$work.output.proposal.action $LOOP_PREV.work.output.proposal.details.count',
      depends_on: ['work'],
    },
  ]);
  const parent = wf('nested-parent', [
    { id: 'sub', include: 'nested-block' },
    { id: 'summary', prompt: '$sub.output.proposal.action', depends_on: ['sub'] },
  ]);
  const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
  expect(errors).toEqual([]);
  const expanded = workflows.get('nested-parent')!;
  expect(inlinePrompt(nodeById(expanded, 'sub__read'))).toBe(
    '$sub__work.output.proposal.action $LOOP_PREV.sub__work.output.proposal.details.count'
  );
  expect(inlinePrompt(nodeById(expanded, 'summary'))).toBe('$sub__read.output.proposal.action');
});
