import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { wf, mapOf, nodeById, inlinePrompt } from './include-expander.fixtures';

describe('expandWorkflowIncludes — returns drives primarySink (#2470)', () => {
  test('$blk.output resolves to the declared returns node (a non-sink); depends_on still waits on the sink', () => {
    const block = wf(
      'review-block',
      [
        { id: 'synthesize', prompt: 'synthesize' },
        { id: 'implement', prompt: 'implement $synthesize.output', depends_on: ['synthesize'] },
      ],
      { returns: 'synthesize' }
    );
    const parent = wf('parent', [
      { id: 'blk', include: 'review-block' },
      { id: 'consume', prompt: 'result: $blk.output', depends_on: ['blk'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const consume = nodeById(workflows.get('parent')!, 'consume')!;
    expect(inlinePrompt(consume) ?? '').toBe('result: $blk__synthesize.output');
    expect(consume.depends_on).toContain('blk__implement');
  });

  test('rewrites workflow-level returns when it names an included block', () => {
    const inner = wf(
      'inner',
      [
        { id: 'result', prompt: 'result' },
        { id: 'cleanup', prompt: 'cleanup', depends_on: ['result'] },
      ],
      { returns: 'result' }
    );
    const outer = wf('outer', [{ id: 'blk', include: 'inner' }], {
      returns: 'blk',
    });
    const parent = wf('parent', [
      { id: 'outer', include: 'outer' },
      { id: 'consume', prompt: 'value: $outer.output', depends_on: ['outer'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, outer, parent));
    expect(errors).toHaveLength(0);
    expect(workflows.get('outer')?.returns).toBe('blk__result');
    const consume = nodeById(workflows.get('parent')!, 'consume')!;
    expect(inlinePrompt(consume) ?? '').toBe('value: $outer__blk__result.output');
  });

  test('validates an outer outcome_field against the rebound flattened return node', () => {
    const resultNode = {
      id: 'result',
      prompt: 'result',
      output_format: {
        type: 'object',
        properties: { green: { type: 'boolean' } },
        required: ['green'],
      },
    };
    const inner = wf('inner', [resultNode], { returns: 'result' });
    const outer = wf('outer', [{ id: 'blk', include: 'inner' }], {
      returns: 'blk',
      outcome_field: 'green',
    });

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, outer));

    expect(errors).toHaveLength(0);
    expect(workflows.get('outer')).toMatchObject({
      returns: 'blk__result',
      outcome_field: 'green',
    });
  });

  test('rejects an outer outcome_field after return rebinding when the child contract is invalid', () => {
    const inner = wf(
      'inner',
      [
        {
          id: 'result',
          prompt: 'result',
          output_format: {
            type: 'object',
            properties: { green: { type: 'string' } },
            required: ['green'],
          },
        },
      ],
      { returns: 'result' }
    );
    const outer = wf('outer', [{ id: 'blk', include: 'inner' }], {
      returns: 'blk',
      outcome_field: 'green',
    });

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, outer));

    expect(workflows.has('outer')).toBe(false);
    expect(errors.find(error => error.filename === 'outer')?.error).toContain(
      'must explicitly declare type: boolean'
    );
  });

  test('keeps a nested outer declaration but never propagates an included workflow outcome', () => {
    const leaf = wf(
      'leaf',
      [
        {
          id: 'result',
          prompt: 'result',
          output_format: {
            type: 'object',
            properties: { green: { type: 'boolean' } },
            required: ['green'],
          },
        },
      ],
      { returns: 'result', outcome_field: 'green' }
    );
    const middle = wf('middle', [{ id: 'leaf-block', include: 'leaf' }], {
      returns: 'leaf-block',
    });
    const outer = wf('outer', [{ id: 'middle-block', include: 'middle' }], {
      returns: 'middle-block',
      outcome_field: 'green',
    });

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, outer));

    expect(errors).toHaveLength(0);
    expect(workflows.get('middle')?.outcome_field).toBeUndefined();
    expect(workflows.get('outer')).toMatchObject({
      returns: 'middle-block__leaf-block__result',
      outcome_field: 'green',
    });
  });
});

describe('expandWorkflowIncludes — requires: unions instead of dropping (#1764)', () => {
  test("a composed block's requirement reaches the composing workflow, de-duplicated", () => {
    const inner = { ...wf('inner', [{ id: 'a', prompt: 'a' }]), requires: ['github' as const] };
    const mid = { ...wf('mid', [{ id: 'i', include: 'inner' }]), requires: ['github' as const] };
    const top = wf('top', [{ id: 'm', include: 'mid' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, mid, top));
    expect(errors).toHaveLength(0);
    expect(workflows.get('top')!.requires).toEqual(['github']);
    expect(workflows.get('mid')!.requires).toEqual(['github']);
  });

  test('a workflow composing nothing that requires anything keeps requires undefined', () => {
    const block = wf('plain', [{ id: 'a', prompt: 'a' }]);
    const parent = wf('parent', [{ id: 'inc', include: 'plain' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.get('parent')!.requires).toBeUndefined();
  });
});
