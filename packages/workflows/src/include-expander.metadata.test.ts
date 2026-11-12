import { expandComposeInstance } from './dag/nodes/compose-fan-out/compose-fan-out-expansion';
import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowDefinition } from './schemas';
import { evaluateCondition } from './condition-evaluator';
import {
  wf,
  mapOf,
  nodeById,
  composedInputs,
  composedOrigin,
  composedBoundaries,
  loopGroupNodes,
} from './include-expander.fixtures';

describe('expandWorkflowIncludes — composed-node metadata survives nesting', () => {
  test('a node stamped at the INNER level keeps that stamp two levels out', () => {
    // inner declares `plan`; mid forwards its own `topic` into it; top supplies `topic`.
    // `mid__blk__run` is cloned TWICE (inner→mid, then mid→top). structuredClone drops
    // symbol keys, so without explicit preservation the stamp vanishes at the second
    // clone and the composed script silently sees no INPUTS_PLAN.
    const inner = wf('inner', [{ id: 'run', bash: 'echo run' }], {
      inputs: { plan: { required: true } },
    });
    const mid = wf('mid', [{ id: 'blk', include: 'inner', with: { plan: '$INPUTS.topic' } }], {
      inputs: { topic: { required: true } },
    });
    const top = wf('top', [{ id: 'mid', include: 'mid', with: { topic: 'ship it' } }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(inner, mid, top));
    expect(errors).toHaveLength(0);

    const run = nodeById(workflows.get('top')!, 'mid__blk__run')!;
    // Write-once: the INNER workflow's own input name, not the outer's `topic`.
    expect(composedInputs(run)).toEqual({ plan: 'ship it' });
    expect(composedOrigin(run)).toBe('inner');
  });

  test('repeated includes keep distinct caller boundaries', () => {
    const block = wf('gated-block', [
      { id: 'entry', bash: 'echo entry', trigger_rule: 'all_done' },
      { id: 'done', bash: 'echo done', depends_on: ['entry'], trigger_rule: 'all_done' },
    ]);
    const parent = wf('parent', [
      { id: 'gate-a', bash: 'echo A' },
      { id: 'gate-b', bash: 'echo B' },
      {
        id: 'first',
        include: 'gated-block',
        depends_on: ['gate-a'],
        when: "$gate-a.output == 'A'",
        trigger_rule: 'one_success',
      },
      {
        id: 'second',
        include: 'gated-block',
        depends_on: ['gate-b'],
        when: "$gate-b.output == 'B'",
        trigger_rule: 'one_success',
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);

    expect(composedBoundaries(nodeById(workflows.get('parent')!, 'first__done'))).toEqual([
      {
        boundary: { includeId: 'first', workflow: 'gated-block' },
        dependsOn: ['gate-a'],
        entryTriggerRules: ['all_done'],
        when: "$gate-a.output == 'A'",
        isEntry: false,
      },
    ]);
    expect(composedBoundaries(nodeById(workflows.get('parent')!, 'second__done'))).toEqual([
      {
        boundary: { includeId: 'second', workflow: 'gated-block' },
        dependsOn: ['gate-b'],
        entryTriggerRules: ['all_done'],
        when: "$gate-b.output == 'B'",
        isEntry: false,
      },
    ]);
  });

  test('nested include boundaries retain their own namespaced predicates', () => {
    const leaf = wf('leaf', [{ id: 'work', bash: 'echo work' }]);
    const middle = wf(
      'middle',
      [
        { id: 'local-gate', bash: 'echo local' },
        {
          id: 'inner',
          include: 'leaf',
          depends_on: ['local-gate'],
          when: "$local-gate.output == '$INPUTS.expected'",
        },
      ],
      { inputs: { expected: { required: true } } }
    );
    const top = wf('top', [
      { id: 'outer-gate', bash: 'echo outer' },
      {
        id: 'outer',
        include: 'middle',
        depends_on: ['outer-gate'],
        when: "$outer-gate.output == 'outer'",
        with: { expected: 'local' },
      },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, top));
    expect(errors).toHaveLength(0);
    expect(composedBoundaries(nodeById(workflows.get('top')!, 'outer__inner__work'))).toEqual([
      {
        boundary: { includeId: 'outer', workflow: 'middle' },
        dependsOn: ['outer-gate'],
        entryTriggerRules: ['all_success'],
        when: "$outer-gate.output == 'outer'",
        isEntry: false,
      },
      {
        boundary: { includeId: 'outer__inner', workflow: 'leaf' },
        dependsOn: ['outer__local-gate'],
        entryTriggerRules: ['all_success'],
        when: "$outer__local-gate.output == 'local'",
        isEntry: true,
        entryTriggerRule: 'all_success',
      },
    ]);
  });

  test('loop_group body boundaries are renamed when the enclosing block is included again', () => {
    // Regression: lifecycle → ship → deliver. deliver's corrections loop body carried
    // ship-level boundary ids ('gate-direct'); including ship into lifecycle renamed the
    // top-level nodes to 'ship__gate-direct' but left the body's boundary untouched, so
    // the first correction iteration was skipped as "upstream failed: gate-direct".
    const leaf = wf('leaf', [
      { id: 'seed', bash: 'echo seed' },
      {
        id: 'loop',
        depends_on: ['seed'],
        loop_group: {
          until_bash: 'test 1 = 1',
          max_iterations: 1,
          nodes: [{ id: 'body', bash: 'echo body' }],
        },
      },
    ]);
    const middle = wf('middle', [
      { id: 'm-gate', bash: 'echo m' },
      {
        id: 'inner',
        include: 'leaf',
        depends_on: ['m-gate'],
        when: "$m-gate.output == 'run'",
        trigger_rule: 'none_failed_min_one_success',
      },
    ]);
    const top = wf('top', [
      { id: 't-gate', bash: 'echo t' },
      { id: 'outer', include: 'middle', depends_on: ['t-gate'] },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, top));
    expect(errors).toHaveLength(0);
    const loop = nodeById(workflows.get('top')!, 'outer__inner__loop');
    const body = loopGroupNodes(loop)?.find(node => node.id === 'body');
    expect(composedBoundaries(body)?.map(boundary => boundary.boundary)).toEqual([
      { includeId: 'outer', workflow: 'middle' },
      { includeId: 'outer__inner', workflow: 'leaf' },
    ]);
    expect(composedBoundaries(body)?.map(boundary => boundary.dependsOn)).toEqual([
      ['t-gate'],
      ['outer__m-gate'],
    ]);
    expect(composedBoundaries(body)?.map(boundary => boundary.entryTriggerRules)).toEqual([
      ['all_success'],
      ['none_failed_min_one_success'],
    ]);
    const innerBoundary = composedBoundaries(body)?.at(-1);
    expect(innerBoundary?.when).toBe("$outer__m-gate.output == 'run'");
    expect(
      evaluateCondition(
        innerBoundary!.when!,
        new Map([['outer__m-gate', { state: 'completed', output: 'run' }]])
      )
    ).toEqual({ parsed: true, result: true });
  });

  test('same include name in sibling loop bodies keeps distinct ownership through nesting', () => {
    const leaf = wf('leaf', [{ id: 'work', bash: 'echo work' }]);
    const middle = wf(
      'middle',
      ['first', 'second'].map(id => ({
        id,
        loop_group: {
          until_bash: 'true',
          max_iterations: 1,
          nodes: [{ id: 'review', include: 'leaf', when: "$INPUTS.route == 'run'" }],
        },
      })),
      { inputs: { route: { required: true } } }
    );
    const top = wf('top', [
      { id: 'pick', bash: 'echo run' },
      {
        id: 'outer',
        include: 'middle',
        depends_on: ['pick'],
        with: { route: '$pick.output' },
        when: "$pick.output == 'run'",
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, top));
    expect(errors).toHaveLength(0);
    for (const id of ['first', 'second']) {
      const group = nodeById(workflows.get('middle')!, id);
      const local = loopGroupNodes(group)?.[0];
      expect(composedBoundaries(local)?.map(b => b.boundary)).toEqual([
        { includeId: `${id}.review`, workflow: 'leaf' },
      ]);
      const outerGroup = nodeById(workflows.get('top')!, `outer__${id}`);
      const nested = loopGroupNodes(outerGroup)?.[0];
      expect(composedBoundaries(nested)?.map(b => b.boundary)).toEqual([
        { includeId: 'outer', workflow: 'middle' },
        { includeId: `outer__${id}.review`, workflow: 'leaf' },
      ]);
    }
  });

  test('loop scope delimiters cannot alias authored IDs, even for the same workflow', () => {
    const leaf = wf('leaf', [{ id: 'work', bash: 'exit 99' }]);
    const nested = {
      id: 'two',
      loop_group: {
        until_bash: 'true',
        max_iterations: 1,
        nodes: [{ id: 'review', include: 'leaf', when: "$INPUTS.route == 'run'" }],
      },
    };
    const parent = wf(
      'parent',
      [
        {
          id: 'one.two',
          loop_group: {
            until_bash: 'true',
            max_iterations: 1,
            nodes: [{ id: 'review', include: 'leaf', when: "$INPUTS.route == 'run'" }],
          },
        },
        { id: 'one', loop_group: { until_bash: 'true', max_iterations: 1, nodes: [nested] } },
      ],
      { inputs: { route: { default: 'stop' } } }
    );
    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, parent));
    expect(errors).toEqual([]);
    const expanded = workflows.get('parent')!;
    const dotted = loopGroupNodes(nodeById(expanded, 'one.two'))?.[0];
    const inner = loopGroupNodes(nodeById(expanded, 'one'))?.[0];
    const nestedWork = loopGroupNodes(inner)?.[0];
    expect(composedBoundaries(dotted)?.[0]?.boundary).toEqual({
      includeId: 'one%2Etwo.review',
      workflow: 'leaf',
    });
    expect(composedBoundaries(nestedWork)?.[0]?.boundary).toEqual({
      includeId: 'one.two.review',
      workflow: 'leaf',
    });
  });

  test('fan-out item scopes cannot alias authored include names or other component splits', () => {
    const leaf = wf('leaf', [{ id: 'work', bash: 'exit 99' }]);
    const middle = wf('middle', [
      { id: 'gate', bash: 'echo stop' },
      { id: 'review', include: 'leaf', depends_on: ['gate'], when: "$gate.output == 'run'" },
    ]);
    const top = wf('top', [{ id: 'batch__item-a', include: 'middle' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, top));
    expect(errors).toEqual([]);
    const staticOwner = composedBoundaries(
      nodeById(workflows.get('top')!, 'batch__item-a__review__work')
    )?.[0]?.boundary.includeId;
    const owners = [staticOwner];
    for (const [id, identity] of [
      ['batch', 'item-a'],
      ['batch__item', 'a'],
    ]) {
      const expanded = expandComposeInstance(
        {
          id,
          kind: 'compose_fan_out',
          include: 'middle',
          fan_out: {
            items: '$source.output.items',
            as: 'item',
            join: 'all_success',
            max_parallel: 2,
          },
        },
        identity,
        {},
        workflows.get('middle')!,
        new Map()
      );
      if ('error' in expanded) throw new Error(expanded.error);
      owners.push(composedBoundaries(expanded.nodes[1])?.[0]?.boundary.includeId);
    }
    expect(owners).toEqual([
      'batch%5F%5Fitem-a__review',
      'batch/item-a__review',
      'batch%5F%5Fitem/a__review',
    ]);
  });

  test('fan-out instances namespace the complete include identity with the parent scope', () => {
    const leaf = wf('leaf', [{ id: 'work', bash: 'echo work' }]);
    const middle = wf('middle', [
      { id: 'gate', bash: 'echo run' },
      { id: 'review', include: 'leaf', depends_on: ['gate'], when: "$gate.output == 'run'" },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle));
    expect(errors).toHaveLength(0);
    const node = {
      id: 'batch',
      kind: 'compose_fan_out',
      include: 'middle',
      fan_out: { items: '$source.output.items', as: 'item', join: 'all_success', max_parallel: 2 },
    } as const;
    for (const identity of ['item-a', 'item-b']) {
      const includeId = `cycle.outer__batch__${identity}`;
      const expanded = expandComposeInstance(
        node,
        identity,
        {},
        workflows.get('middle')!,
        new Map(),
        includeId
      );
      if ('error' in expanded) throw new Error(expanded.error);
      expect(
        composedBoundaries(
          expanded.nodes.find(n => n.id === `batch__${identity}__review__work`)
        )?.map(b => b.boundary)
      ).toEqual([{ includeId: `${includeId}__review`, workflow: 'leaf' }]);
    }
  });

  test("a loop_group body boundary gets the block's input substituted in its gate", () => {
    // A block that gates an include on one of its own inputs: the caller binds the input
    // to a node output. The loop body's copy of that gate kept `$INPUTS.route`, which
    // cannot be evaluated, so every body node was skipped on the first iteration.
    const leaf = wf('leaf', [
      {
        id: 'loop',
        loop_group: {
          until_bash: 'test 1 = 1',
          max_iterations: 1,
          nodes: [{ id: 'body', bash: 'echo body' }],
        },
      },
    ]);
    const middle = wf(
      'middle',
      [
        { id: 'seed', bash: 'echo seed' },
        { id: 'inner', include: 'leaf', depends_on: ['seed'], when: "$INPUTS.route == 'run'" },
      ],
      { inputs: { route: { required: true } } }
    );
    const top = wf('top', [
      { id: 'pick', bash: 'echo run' },
      { id: 'outer', include: 'middle', depends_on: ['pick'], with: { route: '$pick.output' } },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(leaf, middle, top));
    expect(errors).toHaveLength(0);
    const loop = nodeById(workflows.get('top')!, 'outer__inner__loop');
    const body = loopGroupNodes(loop)?.find(node => node.id === 'body');
    expect(composedBoundaries(body)?.at(-1)?.when).toBe("$pick.output == 'run'");
  });
});

describe('expandWorkflowIncludes — composed approval gates carry their origin (#1764)', () => {
  const gateBlock = (): WorkflowDefinition =>
    wf('gate-blk', [
      { id: 'plan', prompt: 'plan' },
      { id: 'gate', approval: { message: 'Approve?' }, depends_on: ['plan'] },
    ]);

  test('a composed gate carries its origin', () => {
    const parent = wf('parent', [{ id: 'inc', include: 'gate-blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(gateBlock(), parent));

    expect(errors).toHaveLength(0);
    expect(composedOrigin(nodeById(workflows.get('parent')!, 'inc__gate'))).toBe('gate-blk');
  });

  test('a gate composed through an intermediate block names the file that authored it', () => {
    const mid = wf('mid', [{ id: 'i', include: 'gate-blk' }]);
    const top = wf('top', [{ id: 'm', include: 'mid' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(gateBlock(), mid, top));
    expect(errors).toHaveLength(0);
    expect(workflows.has('top')).toBe(true);
    expect(workflows.has('mid')).toBe(true);
    // The stamp names the file that authored the gate, three levels down.
    expect(composedOrigin(nodeById(workflows.get('top')!, 'm__i__gate'))).toBe('gate-blk');
  });

  test("a parent's OWN approval node carries no composed origin", () => {
    const plain = wf('plain-blk', [{ id: 'work', prompt: 'work' }]);
    const parent = wf('parent', [
      { id: 'inc', include: 'plain-blk' },
      { id: 'gate', approval: { message: 'Approve?' }, depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(plain, parent));
    expect(errors).toHaveLength(0);
    expect(composedOrigin(nodeById(workflows.get('parent')!, 'gate'))).toBeUndefined();
  });

  test('a composed gate nested inside a loop_group body is stamped too', () => {
    const block = wf('lg-gate-blk', [
      {
        id: 'group',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [{ id: 'gate', approval: { message: 'Approve?' } }],
        },
      },
    ]);
    const parent = wf('parent', [{ id: 'inc', include: 'lg-gate-blk' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toHaveLength(0);
    const group = nodeById(workflows.get('parent')!, 'inc__group');
    expect(composedOrigin(loopGroupNodes(group)?.[0])).toBe('lg-gate-blk');
  });
});
