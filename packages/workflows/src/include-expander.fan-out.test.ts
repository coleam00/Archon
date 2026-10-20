import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { wf, mapOf, blockWorkflow } from './include-expander.fixtures';

describe('expandWorkflowIncludes — composed fan-out deferral (#2512)', () => {
  test('leaves an include+fan_out node unexpanded but validates the target exists', () => {
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'blk',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('parent')!;
    expect(expanded.nodes).toHaveLength(2);
    expect(expanded.plan.layers.map(layer => layer.map(node => node.id))).toEqual([
      ['list'],
      ['fan'],
    ]);
    expect(expanded.plan.sinks).toEqual(['fan']);
    const deferred = expanded.nodes.find(n => n.id === 'fan');
    expect(deferred).toMatchObject({ kind: 'compose_fan_out', include: 'blk' });
  });

  test('errors at load time when the fan-out target name does not resolve', () => {
    const parent = wf('parent', [
      {
        id: 'fan',
        include: 'no-such-block',
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(parent));
    expect(workflows.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Node 'fan'");
    expect(errors[0]?.error).toContain("'no-such-block' not found");
  });

  test('validates required inputs and the item binding through ordinary include expansion', () => {
    const block = {
      ...wf('typed-block', [{ id: 'work', prompt: '$INPUTS.file $INPUTS.mode' }]),
      inputs: { file: { required: true }, mode: { required: true } },
    };
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'typed-block',
        depends_on: ['list'],
        with: { mode: 'strict' },
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "does not declare input 'item'"
    );
  });

  test('rejects a missing non-item required input before runtime', () => {
    const block = {
      ...wf('typed-block', [{ id: 'work', prompt: '$INPUTS.item $INPUTS.mode' }]),
      inputs: { item: { required: true }, mode: { required: true } },
    };
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'typed-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "requires input 'mode'"
    );
  });

  test('materializes packaged command resources for a deferred block at load time', () => {
    const block = wf('command-block', [{ id: 'work', command: 'missing-command' }]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'command-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "command 'missing-command'"
    );
  });

  test.each([
    ['approval gate', { id: 'pause', approval: { message: 'Continue?' } }],
    ['durable wait', { id: 'pause', wait: { duration_ms: 3_600_000 } }],
    [
      'interactive loop',
      {
        id: 'pause',
        loop: {
          prompt: 'iterate',
          until: 'DONE',
          max_iterations: 2,
          interactive: true,
          gate_message: 'Continue?',
        },
      },
    ],
    [
      'interactive loop group',
      {
        id: 'pause',
        loop_group: {
          nodes: [{ id: 'work', bash: 'echo work' }],
          until_bash: 'exit 1',
          max_iterations: 2,
          interactive: true,
          gate_message: 'Continue?',
        },
      },
    ],
  ])('rejects a %s in the composed closure at load time', (_label, pausingNode) => {
    const block = wf('pausing-block', [pausingNode]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'pausing-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      'unsupported suspension-capable path'
    );
  });

  test('rejects a pause-capable nested workflow target at load time', () => {
    const child = wf('child', [{ id: 'pause', wait: { duration_ms: 3_600_000 } }]);
    const block = wf('workflow-block', [{ id: 'child-run', workflow: 'child' }]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'workflow-block',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(child, block, parent));

    expect(workflows.has('parent')).toBe(false);
    const error = errors.find(entry => entry.filename === 'parent')?.error;
    expect(error).toContain("'pause' (durable wait)");
  });

  test("rewrites $node.output refs in the deferred node's with values and items ref", () => {
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      { id: 'blk1', include: 'blk', depends_on: ['list'] },
      {
        id: 'fan',
        include: 'blk',
        depends_on: ['list', 'blk1'],
        with: { seed: '$blk1.output' },
        fan_out: { items: '$list.output', as: 'item' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);
    expect(workflows.get('parent')!.nodes.find(n => n.id === 'fan')).toMatchObject({
      with: { seed: '$blk1__impl.output' },
      fan_out: { items: '$list.output' },
    });
  });
});
