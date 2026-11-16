import { describe, expect, test } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { mapOf, wf } from './include-expander.fixtures';
import { buildPackGraph, type InstalledArrow, packGraphSchema } from './pack-graph';
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

function installed(
  from: string,
  outcome: string,
  to: string,
  id: string,
  problems: string[] = []
): InstalledArrow {
  return {
    file: `/home/triggers/${id}.json`,
    sourceInstanceId: id,
    runEnded: { workflowName: from, outcome },
    launchWorkflow: to,
    problems,
  };
}

type GraphInput = Parameters<typeof buildPackGraph>[0];

/** A graph over `staged`, every one of them discoverable, with no discovery errors. */
function graphOf(
  staged: ReturnType<typeof stages>,
  rest: Pick<GraphInput, 'declared' | 'installed'> & Partial<GraphInput>
) {
  return buildPackGraph({
    packKey: 'chain',
    stages: staged,
    workflows: staged,
    discoveryErrors: [],
    ...rest,
  });
}

const plain = (id: string, dependsOn: string[] = []) => ({
  id,
  kind: 'exec',
  dependsOn,
  blocks: [],
  fanOut: null,
});

describe('a pack graph', () => {
  test('lists every stage and arrow, each active or declared, and the outcomes nothing leaves', () => {
    const graph = graphOf(
      stages(
        stage('a', ['ready', 'park']),
        stage('b', ['done', 'stuck'], true),
        stage('c', ['shipped'])
      ),
      {
        declared: {
          'b-after-a': runEnded('b', 'a', 'ready'),
          'c-after-b': runEnded('c', 'b', 'done'),
        },
        installed: [installed('a', 'ready', 'b', 'file-b')],
      }
    );

    expect(graph.stages.map(s => s.name)).toEqual(['a', 'b', 'c']);
    expect(graph.arrows).toEqual([
      {
        from: { stage: 'a', outcome: 'ready' },
        to: 'b',
        active: true,
        declared: { binding: 'b-after-a' },
        installed: { file: '/home/triggers/file-b.json', sourceInstanceId: 'file-b', problems: [] },
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
    const graph = graphOf(stages(stage('a', ['ready'])), {
      declared: undefined,
      installed: [installed('a', 'ready', 'elsewhere', 'hand-written')],
    });
    expect(graph.arrows).toEqual([
      {
        from: { stage: 'a', outcome: 'ready' },
        to: 'elsewhere',
        active: true,
        declared: null,
        installed: {
          file: '/home/triggers/hand-written.json',
          sourceInstanceId: 'hand-written',
          problems: [],
        },
      },
    ]);
    expect(graph.stages[0]?.outcome?.values).toEqual([{ value: 'ready', startsNothing: false }]);
  });

  test('an installed arrow the run preflight refuses starts nothing', () => {
    const graph = graphOf(stages(stage('a', ['ready']), stage('b', ['done'])), {
      declared: undefined,
      installed: [installed('a', 'ready', 'b', 'broken', ["input 'x' reads 'y'"])],
    });
    expect(graph.arrows[0]).toMatchObject({
      active: true,
      installed: { problems: ["input 'x' reads 'y'"] },
    });
    expect(graph.stages[0]?.outcome?.values).toEqual([{ value: 'ready', startsNothing: true }]);
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
    const graph = graphOf(
      stages(review, deliver).filter(s => s.name === 'deliver'),
      { declared: undefined, installed: [] }
    );

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
    const blocks = [{ include: 'check', workflow: 'review' }];
    expect(only?.nodes).toEqual([
      plain('build'),
      { ...plain('check__look', ['build']), blocks },
      { ...plain('check__decide', ['check__look']), blocks },
    ]);
  });

  test('a fan-out include stays one node, and its body is listed once under its workflow', () => {
    const fan = (id: string, include: string, dependsOn: string) => ({
      id,
      include,
      depends_on: [dependsOn],
      fan_out: { items: '$list.output', as: 'x' },
    });
    const inner = wf('inner', [{ id: 'leaf', bash: 'true' }]);
    const body = wf('body', [{ id: 'list', bash: 'echo []' }, fan('more', 'inner', 'list')]);
    const deliver = wf('deliver', [
      { id: 'list', bash: 'echo []' },
      fan('fan', 'body', 'list'),
      fan('again', 'body', 'fan'),
    ]);
    const all = stages(inner, body, deliver);
    const graph = graphOf(
      all.filter(s => s.name === 'deliver'),
      { declared: undefined, installed: [], workflows: all }
    );

    const fanned = (id: string, dependsOn: string, workflow: string) => ({
      ...plain(id, [dependsOn]),
      kind: 'compose_fan_out',
      fanOut: { workflow },
    });
    expect(graph.stages[0]?.nodes).toEqual([
      plain('list'),
      fanned('fan', 'list', 'body'),
      fanned('again', 'fan', 'body'),
    ]);
    expect(graph.fanOutBlocks).toEqual([
      { workflow: 'body', nodes: [plain('list'), fanned('more', 'list', 'inner')] },
      { workflow: 'inner', nodes: [plain('leaf')] },
    ]);
  });

  test('every discovery error is listed, so a missing stage is visible', () => {
    const graph = graphOf(stages(stage('a', ['ready'])), {
      declared: undefined,
      installed: [],
      discoveryErrors: [
        {
          filename: 'b.yaml',
          workflowName: 'b',
          error: "include target 'nope' not found",
          errorType: 'validation_error',
        },
      ],
    });
    expect(graph.discoveryErrors).toEqual([
      { filename: 'b.yaml', workflowName: 'b', error: "include target 'nope' not found" },
    ]);
  });

  test('a reader on this schema keeps reading a graph that gained fields it does not know', () => {
    const graph = graphOf(stages(stage('a', ['ready'])), { declared: undefined, installed: [] });
    const newer = {
      ...graph,
      laterField: 1,
      stages: graph.stages.map(s => ({ ...s, laterField: true })),
    };
    expect(packGraphSchema.safeParse(newer).success).toBe(true);
  });
});
