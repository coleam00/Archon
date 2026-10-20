import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { resolvedBodyNodes } from './graph-plan';
import type { WorkflowDefinition } from './schemas';
import {
  wf,
  mapOf,
  nodeById,
  composedInputs,
  composedOrigin,
  loopGroupOf,
  loopGroupNodes,
  inlinePrompt,
  bashScript,
} from './include-expander.fixtures';

describe('expandWorkflowIncludes — loop_group in an included block', () => {
  test('renames outer-sibling refs but leaves body ids and $LOOP_PREV refs body-local', () => {
    const block = wf('lgblk', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'lg',
        depends_on: ['seed'],
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          nodes: [
            {
              id: 'inner',
              prompt: 'prev=$LOOP_PREV.inner.output outer=$seed.output',
              depends_on: [],
            },
          ],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'rev', include: 'lgblk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('parent')!;
    expect(expanded.nodes.map(n => n.id)).toContain('rev__lg');
    const lg = nodeById(expanded, 'rev__lg');
    const body = loopGroupNodes(lg)?.[0];
    expect(body?.id).toBe('inner');
    expect(inlinePrompt(body)).toBe('prev=$LOOP_PREV.inner.output outer=$rev__seed.output');
  });

  test('a loop_group body id shadowing a parent top-level id is rejected', () => {
    const block = wf('lgblk', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'lg',
        depends_on: ['seed'],
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [{ id: 'clash', prompt: 'work', depends_on: [] }],
        },
      },
    ]);
    const parent = wf('parent', [
      { id: 'clash', bash: 'echo clash' },
      { id: 'rev', include: 'lgblk' },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(e => e.filename === 'parent')?.error).toContain('shadows');
  });
});

describe('expandWorkflowIncludes — loop_group body composition (#2623)', () => {
  test('expands a body include in local scope and binds completion to its declared return', () => {
    const block: WorkflowDefinition = {
      ...wf('review-block', [
        {
          id: 'decide',
          prompt: 'review $INPUTS.context',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
        },
        {
          id: 'cleanup',
          bash: 'echo $LOOP_PREV.decide.output.done',
          depends_on: ['decide'],
        },
      ]),
      inputs: { context: { required: true } },
      returns: 'decide',
      requires: ['github'],
    };
    const parent = wf('parent', [
      {
        id: 'group',
        loop_group: {
          until_bash: 'test "$review.output.done" = true',
          max_iterations: 3,
          nodes: [
            { id: 'seed', bash: 'echo context' },
            {
              id: 'review',
              include: 'review-block',
              depends_on: ['seed'],
              with: { context: '$seed.output' },
            },
            {
              id: 'consume',
              prompt: 'done=$review.output.done previous=$LOOP_PREV.review.output',
              depends_on: ['review'],
            },
          ],
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    const group = nodeById(expanded, 'group');
    const groupConfig = loopGroupOf(group);
    expect(groupConfig?.nodes.map(node => node.id)).toEqual([
      'seed',
      'review__decide',
      'review__cleanup',
      'consume',
    ]);
    expect(groupConfig?.nodes.some(node => 'include' in node)).toBe(false);
    expect(groupConfig?.until_bash).toBe('test "$review__decide.output.done" = true');

    const decide = groupConfig?.nodes.find(node => node.id === 'review__decide');
    const cleanup = groupConfig?.nodes.find(node => node.id === 'review__cleanup');
    const consume = groupConfig?.nodes.find(node => node.id === 'consume');
    expect(decide?.depends_on).toEqual(['seed']);
    expect(cleanup?.depends_on).toEqual(['review__decide']);
    expect(bashScript(cleanup) ?? '').toBe('echo $LOOP_PREV.review__decide.output.done');
    expect(consume?.depends_on).toEqual(['review__cleanup']);
    expect(inlinePrompt(consume) ?? '').toBe(
      'done=$review__decide.output.done previous=$LOOP_PREV.review.output'
    );
    expect(inlinePrompt(decide) ?? '').toBe('review $seed.output');
    expect(composedOrigin(decide)).toBe('review-block');
    expect(composedInputs(decide)).toEqual({ context: '$seed.output' });
    expect(expanded.requires).toEqual(['github']);
  });

  test('expands independent includes in nested loop_group scopes without leaking directives', () => {
    const block = wf('block', [{ id: 'work', prompt: 'work' }]);
    const parent = wf('parent', [
      {
        id: 'outer',
        loop_group: {
          until_bash: 'true',
          max_iterations: 1,
          nodes: [
            { id: 'first', include: 'block' },
            { id: 'second', include: 'block', depends_on: ['first'] },
            {
              id: 'inner',
              loop_group: {
                until_bash: 'test -n "$third.output"',
                max_iterations: 1,
                nodes: [{ id: 'third', include: 'block' }],
              },
              depends_on: ['second'],
            },
          ],
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    const outer = nodeById(workflows.get('parent')!, 'outer');
    const outerConfig = loopGroupOf(outer);
    expect(outerConfig?.nodes.map(node => node.id)).toEqual([
      'first__work',
      'second__work',
      'inner',
    ]);
    expect(outerConfig?.nodes.find(node => node.id === 'second__work')?.depends_on).toEqual([
      'first__work',
    ]);
    const inner = outerConfig?.nodes.find(node => node.id === 'inner');
    const innerConfig = loopGroupOf(inner);
    expect(innerConfig?.nodes.map(node => node.id)).toEqual(['third__work']);
    expect(innerConfig?.until_bash).toBe('test -n "$third__work.output"');
  });

  test('fails the owning workflow when a body include target is unknown', () => {
    const parent = wf('parent', [
      {
        id: 'group',
        loop_group: {
          until_bash: 'true',
          max_iterations: 1,
          nodes: [{ id: 'missing', include: 'does-not-exist' }],
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      "Node 'missing': include target 'does-not-exist' not found"
    );
  });
});

describe('loop_group structured completion after include expansion (#2998)', () => {
  test.each([
    { type: 'object', properties: { done: { type: 'boolean' } } },
    { type: ['object', 'null'] },
  ])('checks an included terminal schema: %j', outputFormat => {
    for (const withBash of [false, true]) {
      const block = wf('structured-review', [
        {
          id: 'review',
          prompt: 'Review',
          output_format: outputFormat,
        },
      ]);
      const parent = wf('parent', [
        {
          id: 'refine',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            ...(withBash ? { until_bash: 'exit 0' } : {}),
            nodes: [{ id: 'check', include: 'structured-review' }],
          },
        },
      ]);
      const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
      if (withBash) {
        expect(errors).toEqual([]);
        expect(workflows.has('parent')).toBe(true);
      } else {
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toContain(
          "node 'check__review', which the group's output is read from"
        );
        expect(errors[0].error).toContain('until_bash');
        expect(workflows.has('parent')).toBe(false);
      }
    }
  });

  test.each([{ type: 'string' }, { type: ['string', 'object'] }])(
    'preserves included schemas that permit strings: %j',
    outputFormat => {
      const block = wf('string-review', [
        { id: 'review', prompt: 'Review', output_format: outputFormat },
      ]);
      const parent = wf('parent', [
        {
          id: 'refine',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            nodes: [{ id: 'check', include: 'string-review' }],
          },
        },
      ]);
      const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
      expect(errors).toEqual([]);
      expect(workflows.has('parent')).toBe(true);
    }
  );
});

describe('named loop owner ancestry after composition', () => {
  test('namespaces both the pre-loop source and the body selector', () => {
    const block = wf('correction-block', [
      { id: 'implement', prompt: 'Implement' },
      {
        id: 'corrections',
        depends_on: ['implement'],
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 2,
          nodes: [{ id: 'owner', prompt: 'Correct', context: { resume: 'implement' } }],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'delivery', include: 'correction-block' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toEqual([]);
    const group = workflows.get('parent')?.nodes.find(n => n.id === 'delivery__corrections');
    if (group?.kind !== 'loop_group') throw new Error('missing expanded group');
    expect(resolvedBodyNodes(group.loop_group)[0]?.context).toEqual({
      resume: 'delivery__implement',
    });
    expect(group.depends_on).toEqual(['delivery__implement']);
  });
});
