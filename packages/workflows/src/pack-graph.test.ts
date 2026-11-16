import { describe, expect, test } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { mapOf, wf } from './include-expander.fixtures';
import {
  buildPackGraph,
  type InstalledArrow,
  packGraphSchema,
  packWorkflowIdentities,
} from './pack-graph';
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
  loopGroup: null as string | null,
  blocks: [] as { include: string; workflow: string }[],
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
        declared: { binding: 'b-after-a', problems: [] },
        installed: { file: '/home/triggers/file-b.json', sourceInstanceId: 'file-b', problems: [] },
      },
      {
        from: { stage: 'b', outcome: 'done' },
        to: 'c',
        active: false,
        declared: { binding: 'c-after-b', problems: [] },
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

  test('an installed pack resolves plain binding names to its own stages, never to another pack', () => {
    // Two installed packs share the authored stage names `plan` and `build`.
    const first = stages(stage('acme/first:plan', ['ready']), stage('acme/first:build', ['done']));
    const declared = { build: runEnded('build', 'plan', 'ready') };
    const own = packWorkflowIdentities(
      first.map(s => s.name),
      { ...declared, gone: runEnded('gone', 'plan', 'ready') }
    );
    expect([...own].sort()).toEqual(['acme/first:build', 'acme/first:gone', 'acme/first:plan']);
    // A completion compares names exactly, so the other pack's ends are not this pack's.
    expect(own.has('acme/second:plan') || own.has('acme/second:build')).toBe(false);

    const graph = graphOf(first, {
      declared,
      installed: [
        installed('acme/first:plan', 'ready', 'acme/first:build', 'own'),
        // A genuine cross-pack arrow: it starts one of this pack's stages.
        installed('acme/second:plan', 'ready', 'acme/first:build', 'into-first'),
      ],
    });
    expect(
      graph.arrows.map(a => [a.from.stage, a.to, a.active, a.declared?.binding ?? null])
    ).toEqual([
      ['acme/first:plan', 'acme/first:build', true, 'build'],
      ['acme/second:plan', 'acme/first:build', true, null],
    ]);
    expect(graph.arrows[0]?.declared?.problems).toEqual([]);
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

  test('a loop group lists its body, nested groups and included blocks under their step names', () => {
    const pr = wf('pr', [
      { id: 'open', bash: 'true' },
      { id: 'publish', bash: 'true', depends_on: ['open'] },
    ]);
    const loop = (nodes: unknown[]) => ({ until: 'DONE', max_iterations: 2, nodes });
    const deliver = wf('deliver', [
      { id: 'start', bash: 'true' },
      {
        id: 'rounds',
        depends_on: ['start'],
        loop_group: loop([
          { id: 'build', bash: 'true' },
          { id: 'pr', include: 'pr', depends_on: ['build'] },
          { id: 'inner', depends_on: ['pr'], loop_group: loop([{ id: 'check', bash: 'true' }]) },
        ]),
      },
    ]);
    const graph = graphOf(
      stages(pr, deliver).filter(s => s.name === 'deliver'),
      { declared: undefined, installed: [] }
    );

    const blocks = [{ include: 'rounds.pr', workflow: 'pr' }];
    const inRounds = (id: string, dependsOn: string[] = []) => ({
      ...plain(`rounds.${id}`, dependsOn),
      loopGroup: 'rounds',
    });
    expect(graph.stages[0]?.nodes).toEqual([
      plain('start'),
      { ...plain('rounds', ['start']), kind: 'loop_group' },
      inRounds('build'),
      { ...inRounds('pr__open', ['rounds.build']), blocks },
      { ...inRounds('pr__publish', ['rounds.pr__open']), blocks },
      { ...inRounds('inner', ['rounds.pr__publish']), kind: 'loop_group' },
      { ...plain('rounds.inner.check'), loopGroup: 'rounds.inner' },
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

  test('a stage with a boolean outcome ends with succeeded or failed', () => {
    const check = wf(
      'check',
      [
        {
          id: 'decide',
          bash: 'true',
          output_format: {
            type: 'object',
            properties: { green: { type: 'boolean' } },
            required: ['green'],
          },
        },
      ],
      { returns: 'decide', result: { outcome: 'green' } }
    );
    const graph = graphOf(stages(check, stage('next', ['done'])), {
      declared: undefined,
      installed: [installed('check', 'succeeded', 'next', 'on-green')],
    });
    expect(graph.stages[0]?.outcome).toEqual({
      field: 'green',
      form: 'boolean',
      values: [
        { value: 'succeeded', startsNothing: false },
        { value: 'failed', startsNothing: true },
      ],
    });
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
