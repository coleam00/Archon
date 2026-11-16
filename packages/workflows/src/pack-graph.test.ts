import { describe, expect, test } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { mapOf, wf } from './include-expander.fixtures';
import { buildPackGraph, type InstalledArrow } from './pack-graph';
import { packRunEndedBindingSchema } from './schemas/pack-bindings';

function decide(values: string[]) {
  return {
    id: 'decide',
    bash: 'true',
    output_format: {
      type: 'object',
      properties: { outcome: { type: 'string', enum: values } },
      required: ['outcome'],
    },
  };
}

function stage(name: string, values: string[], asks = false) {
  return wf(name, [decide(values)], {
    returns: 'decide',
    result: { outcome: 'outcome', ...(asks ? { asks: 'asks' } : {}) },
  });
}

function stages(...workflows: ReturnType<typeof wf>[]) {
  const { workflows: expanded, errors } = expandWorkflowIncludes(mapOf(...workflows));
  expect(errors).toEqual([]);
  return [...expanded.values()];
}

function runEnded(workflow: string, from: string, outcome: string) {
  return packRunEndedBindingSchema.parse({
    workflow,
    resource: workflow,
    overlap: 'queue',
    run_ended: { workflow: from, outcome },
  });
}

function installed(from: string, outcome: string, to: string, id: string): InstalledArrow {
  return {
    file: `/home/triggers/${id}.json`,
    sourceInstanceId: id,
    runEnded: { workflowName: from, outcome },
    launchWorkflow: to,
  };
}

describe('a pack graph', () => {
  test('lists every stage and arrow, each active or declared, and the outcomes nothing leaves', () => {
    const graph = buildPackGraph({
      packKey: 'chain',
      stages: stages(
        stage('a', ['ready', 'park']),
        stage('b', ['done', 'stuck'], true),
        stage('c', ['shipped'])
      ),
      declared: {
        'b-after-a': runEnded('b', 'a', 'ready'),
        'c-after-b': runEnded('c', 'b', 'done'),
      },
      installed: [installed('a', 'ready', 'b', 'file-b')],
    });

    expect(graph.stages.map(s => s.name)).toEqual(['a', 'b', 'c']);
    expect(graph.arrows).toEqual([
      {
        from: { stage: 'a', outcome: 'ready' },
        to: 'b',
        active: true,
        declared: { binding: 'b-after-a' },
        installed: { file: '/home/triggers/file-b.json', sourceInstanceId: 'file-b' },
      },
      {
        from: { stage: 'b', outcome: 'done' },
        to: 'c',
        active: false,
        declared: { binding: 'c-after-b' },
        installed: null,
      },
    ]);
    // An inactive arrow starts nothing, so its outcome is reported with the true dead ends.
    expect(
      graph.stages.map(s => [
        s.name,
        s.asks,
        s.outcome?.values.filter(v => v.startsNothing).map(v => v.value),
      ])
    ).toEqual([
      ['a', false, ['park']],
      ['b', true, ['done', 'stuck']],
      ['c', false, ['shipped']],
    ]);
  });

  test('a trigger file the pack does not declare is an active arrow with no declaration', () => {
    const graph = buildPackGraph({
      packKey: 'chain',
      stages: stages(stage('a', ['ready'])),
      declared: undefined,
      installed: [installed('a', 'ready', 'elsewhere', 'hand-written')],
    });
    expect(graph.arrows).toEqual([
      {
        from: { stage: 'a', outcome: 'ready' },
        to: 'elsewhere',
        active: true,
        declared: null,
        installed: { file: '/home/triggers/hand-written.json', sourceInstanceId: 'hand-written' },
      },
    ]);
    expect(graph.stages[0]?.outcome?.values).toEqual([{ value: 'ready', startsNothing: false }]);
  });

  test('a stage that returns an include reads its outcome and nodes through the block', () => {
    const review = wf(
      'review',
      [
        { id: 'look', bash: 'true' },
        { ...decide(['approve', 'reject']), depends_on: ['look'] },
      ],
      { returns: 'decide' }
    );
    const deliver = wf(
      'deliver',
      [
        { id: 'build', bash: 'true' },
        { id: 'check', include: 'review', depends_on: ['build'] },
      ],
      { returns: 'check', result: { outcome: 'outcome' } }
    );
    const graph = buildPackGraph({
      packKey: 'chain',
      stages: stages(review, deliver).filter(s => s.name === 'deliver'),
      declared: undefined,
      installed: [],
    });

    const [only] = graph.stages;
    expect(only?.returns).toBe('check__decide');
    expect(only?.outcome).toEqual({
      field: 'outcome',
      form: 'enum',
      values: [
        { value: 'approve', startsNothing: true },
        { value: 'reject', startsNothing: true },
      ],
    });
    const block = [{ include: 'check', workflow: 'review' }];
    expect(only?.nodes).toEqual([
      { id: 'build', kind: 'exec', dependsOn: [], blocks: [] },
      { id: 'check__look', kind: 'exec', dependsOn: ['build'], blocks: block },
      { id: 'check__decide', kind: 'exec', dependsOn: ['check__look'], blocks: block },
    ]);
  });
});
