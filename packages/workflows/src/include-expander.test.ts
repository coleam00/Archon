// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import {
  wf,
  mapOf,
  nodeById,
  composedBoundaries,
  inlinePrompt,
  blockWorkflow,
} from './include-expander.fixtures';

describe('expandWorkflowIncludes — namespacing', () => {
  test('inlines the block as flattened, namespaced nodes with no include remaining', () => {
    const parent = wf('parent', [
      { id: 'setup', bash: 'echo setup' },
      { id: 'review', include: 'blk', depends_on: ['setup'] },
      { id: 'summary', prompt: 'summarize $review.output', depends_on: ['review'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('parent')!;
    const ids = expanded.nodes.map(n => n.id);
    expect(ids).toContain('review__verify');
    expect(ids).toContain('review__scope');
    expect(ids).toContain('review__impl');
    expect(ids).not.toContain('review');
    expect(expanded.nodes.some(n => 'include' in n)).toBe(false);
  });

  test('rewires internal depends_on to namespaced ids', () => {
    const parent = wf('parent', [{ id: 'review', include: 'blk' }]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const expanded = workflows.get('parent')!;
    expect(nodeById(expanded, 'review__scope')?.depends_on).toEqual(['review__verify']);
    expect(nodeById(expanded, 'review__impl')?.depends_on).toEqual(['review__scope']);
  });

  test('rewrites named session sources through nested include namespaces', () => {
    const leaf = wf('leaf-lineage', [
      { id: 'source', prompt: 'scope' },
      {
        id: 'consumer',
        prompt: 'continue',
        depends_on: ['source'],
        context: { resume: 'source' },
      },
    ]);
    const middle = wf('middle-lineage', [{ id: 'inner', include: 'leaf-lineage' }]);
    const parent = wf('parent-lineage', [{ id: 'outer', include: 'middle-lineage' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent-lineage')!;
    const consumer = nodeById(expanded, 'outer__inner__consumer');
    expect(consumer?.context).toEqual({ resume: 'outer__inner__source' });
    expect(consumer?.depends_on).toEqual(['outer__inner__source']);
  });

  test('entry node inherits the include node upstream deps; sinks feed downstream refs', () => {
    const parent = wf('parent', [
      { id: 'setup', bash: 'echo setup' },
      { id: 'review', include: 'blk', depends_on: ['setup'] },
      { id: 'summary', prompt: 'done', depends_on: ['review'] },
    ]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const expanded = workflows.get('parent')!;
    expect(nodeById(expanded, 'review__verify')?.depends_on).toEqual(['setup']);
    expect(nodeById(expanded, 'summary')?.depends_on).toEqual(['review__impl']);
  });

  test('rewrites $includeId.output to the primary sink, and internal refs to namespaced ids', () => {
    const parent = wf('parent', [
      { id: 'review', include: 'blk' },
      { id: 'summary', prompt: 'read $review.output here', depends_on: ['review'] },
    ]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const expanded = workflows.get('parent')!;
    const summary = nodeById(expanded, 'summary');
    expect(inlinePrompt(summary) ?? '').toBe('read $review__impl.output here');
    const scope = nodeById(expanded, 'review__scope');
    expect(inlinePrompt(scope) ?? '').toBe('scope $review__verify.output');
  });

  test('rewrites node refs and inputs in wait conditions', () => {
    const block = wf('waiting-block', [
      { id: 'schedule', bash: 'echo 2026-08-25T22:00:00Z' },
      {
        id: 'wait-for-window',
        wait: { until: '$schedule.output' },
        depends_on: ['schedule'],
      },
      {
        id: 'wait-for-event',
        wait: { event: '$INPUTS.event', deadline_ms: 60_000 },
        depends_on: ['wait-for-window'],
      },
      {
        id: 'wait-for-input-time',
        wait: { until: '$INPUTS.resume_at' },
        depends_on: ['wait-for-event'],
      },
      {
        id: 'wait-for-action',
        wait: { attention: 'Confirm $schedule.output with $INPUTS.operator.' },
        depends_on: ['wait-for-input-time'],
      },
    ]);
    block.inputs = {
      event: { required: true },
      resume_at: { required: true },
      operator: { required: true },
    };
    const parent = wf('parent', [
      {
        id: 'waiting',
        include: 'waiting-block',
        with: {
          event: 'checks.complete',
          resume_at: '2026-08-25T23:00:00Z',
          operator: 'release manager',
        },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;
    expect(nodeById(expanded, 'waiting__wait-for-window')).toMatchObject({
      wait: { until: '$waiting__schedule.output' },
    });
    expect(nodeById(expanded, 'waiting__wait-for-event')).toMatchObject({
      wait: { event: 'checks.complete' },
    });
    expect(nodeById(expanded, 'waiting__wait-for-input-time')).toMatchObject({
      wait: { until: '2026-08-25T23:00:00Z' },
    });
    expect(nodeById(expanded, 'waiting__wait-for-action')).toMatchObject({
      wait: { attention: 'Confirm $waiting__schedule.output with release manager.' },
    });
  });

  test("propagates the include node's when/trigger_rule onto entry nodes", () => {
    const parent = wf('parent', [
      { id: 'gate', bash: 'echo gate' },
      {
        id: 'review',
        include: 'blk',
        depends_on: ['gate'],
        when: "$gate.output == 'gate'",
        trigger_rule: 'all_success',
      },
    ]);
    const { workflows } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    const entry = nodeById(workflows.get('parent')!, 'review__verify');
    expect(entry?.when).toBe("$gate.output == 'gate'");
    expect(entry?.trigger_rule).toBe('all_success');
  });

  test('two include nodes of the same block get distinct namespaces', () => {
    const parent = wf('parent', [
      { id: 'a', include: 'blk' },
      { id: 'b', include: 'blk', depends_on: ['a'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(blockWorkflow(), parent));
    expect(errors).toHaveLength(0);
    const ids = workflows.get('parent')!.nodes.map(n => n.id);
    expect(ids).toContain('a__verify');
    expect(ids).toContain('b__verify');
    expect(nodeById(workflows.get('parent')!, 'b__verify')?.depends_on).toEqual(['a__impl']);
  });

  test('boundary dependency edges fan out to every sink while scalar refs use the primary sink', () => {
    const upstream = wf('upstream', [
      { id: 'primary', bash: 'echo primary' },
      { id: 'secondary', bash: 'echo secondary' },
    ]);
    const downstream = wf('downstream', [
      { id: 'entry', bash: 'echo entry', trigger_rule: 'one_success' },
      { id: 'join', bash: 'echo join', depends_on: ['entry'], trigger_rule: 'all_done' },
    ]);
    const parent = wf('parent', [
      { id: 'up', include: 'upstream' },
      {
        id: 'down',
        include: 'downstream',
        depends_on: ['up'],
        when: "$up.output == 'primary'",
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(upstream, downstream, parent));
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('parent')!;

    expect(nodeById(expanded, 'down__entry')?.depends_on).toEqual(['up__primary', 'up__secondary']);
    expect(composedBoundaries(nodeById(expanded, 'down__join'))).toEqual([
      {
        dependsOn: ['up__primary', 'up__secondary'],
        entryTriggerRules: ['one_success'],
        when: "$up__primary.output == 'primary'",
        isEntry: false,
      },
    ]);
  });

  test('does not mutate the input workflow map', () => {
    const parent = wf('parent', [{ id: 'review', include: 'blk' }]);
    const raw = mapOf(blockWorkflow(), parent);
    expandWorkflowIncludes(raw);
    expect(raw.get('parent')!.nodes.some(n => 'include' in n)).toBe(true);
  });
});

describe('expandWorkflowIncludes — nested', () => {
  test('recursively expands a block that itself includes another', () => {
    const leaf = wf('leaf', [{ id: 'x', prompt: 'x' }]);
    const mid = wf('mid', [
      { id: 'm', prompt: 'm' },
      { id: 'inner', include: 'leaf', depends_on: ['m'] },
    ]);
    const parent = wf('parent', [{ id: 'outer', include: 'mid' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, mid, parent));
    expect(errors).toHaveLength(0);
    const ids = workflows.get('parent')!.nodes.map(n => n.id);
    expect(ids).toContain('outer__m');
    expect(ids).toContain('outer__inner__x');
    expect(workflows.get('parent')!.nodes.some(n => 'include' in n)).toBe(false);
  });
});

describe('expandWorkflowIncludes — composition', () => {
  test('persist_session survives inlining and namespaces per parent (independent keys)', () => {
    const block = wf('sesblk', [{ id: 'ai', prompt: 'do work', persist_session: true }]);
    const parentA = wf('parentA', [{ id: 'rev', include: 'sesblk' }]);
    const parentB = wf('parentB', [{ id: 'rev', include: 'sesblk' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parentA, parentB));
    expect(errors).toHaveLength(0);

    const a = workflows.get('parentA')!;
    const b = workflows.get('parentB')!;
    expect(nodeById(a, 'rev__ai')).toMatchObject({ persist_session: true });
    expect(nodeById(b, 'rev__ai')).toMatchObject({ persist_session: true });
    expect(a.name).not.toBe(b.name);
  });

  test('diamond include: two blocks both including the same leaf expand without collision', () => {
    const leaf = wf('leaf', [{ id: 'x', prompt: 'x' }]);
    const b1 = wf('b1', [{ id: 'l', include: 'leaf' }]);
    const b2 = wf('b2', [{ id: 'l', include: 'leaf' }]);
    const parent = wf('parent', [
      { id: 'a', include: 'b1' },
      { id: 'b', include: 'b2' },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, b1, b2, parent));
    expect(errors).toHaveLength(0);
    const ids = workflows.get('parent')!.nodes.map(n => n.id);
    expect(ids).toContain('a__l__x');
    expect(ids).toContain('b__l__x');
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});

describe('expandWorkflowIncludes — determinism', () => {
  test('expanding the same map twice yields identical node ids and structure', () => {
    const build = () => {
      const parent = wf('parent', [
        { id: 'setup', bash: 'echo setup' },
        { id: 'review', include: 'blk', depends_on: ['setup'] },
        { id: 'summary', prompt: 'summarize $review.output', depends_on: ['review'] },
      ]);
      return expandWorkflowIncludes(mapOf(blockWorkflow(), parent)).workflows.get('parent')!;
    };
    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
