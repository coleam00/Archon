import { describe, expect, test } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { mapOf, wf } from './include-expander.fixtures';
import {
  buildPackGraph,
  declaredStops,
  type InstalledArrow,
  packGraphSchema,
  packWorkflowIdentities,
} from './pack-graph';
import { packAsksSettledBindingSchema, packRunEndedBindingSchema } from './schemas/pack-bindings';

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

function stage(name: string, values: string[], asks = false, waits = false) {
  return wf(name, [decide(values)], {
    returns: 'decide',
    result: {
      outcome: 'outcome',
      ...(asks ? { asks: 'asks' } : {}),
      ...(waits ? { waits: 'waits' } : {}),
    },
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
  problems: string[] = [],
  startsStep = true
): InstalledArrow {
  return {
    file: `/home/triggers/${id}.json`,
    sourceInstanceId: id,
    from: { stage: from, outcome },
    launchWorkflow: to,
    linked: null,
    problems,
    startsStep,
  };
}

const partOfOrder = { kind: 'part_of', holder: 'to' } as const;
/** A link as an installed file's arrow carries it, reading no entries. */
const noEntries = <T extends object>(link: T) => ({ ...link, entries: {} });

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
        stage('c', ['shipped'], false, true)
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
        linked: null,
        active: true,
        declared: { binding: 'b-after-a', problems: [] },
        installed: { file: '/home/triggers/file-b.json', sourceInstanceId: 'file-b', problems: [] },
      },
      {
        from: { stage: 'b', outcome: 'done' },
        to: 'c',
        linked: null,
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
        s.waits,
        s.outcome?.values.filter(v => v.startsNothing).map(v => v.value),
      ])
    ).toEqual([
      ['a', false, false, ['park']],
      ['b', true, false, ['done', 'stuck']],
      ['c', false, true, ['shipped']],
    ]);
  });

  test('an asks arrow is active with its file and declared, inactive without one', () => {
    const asks = (workflow: string, from: string, settled: 'answered' | 'withdrawn') =>
      packAsksSettledBindingSchema.parse({
        workflow,
        resource: workflow,
        overlap: 'queue',
        asks_settled: { workflow: from, settled, checkout: 'asking-run' },
      });
    const graph = graphOf(stages(stage('a', ['ready'], true), stage('b', ['done'])), {
      declared: {
        'a-answered': asks('a', 'a', 'answered'),
        'b-withdrawn': asks('b', 'a', 'withdrawn'),
      },
      installed: [
        {
          file: '/home/triggers/answered.json',
          sourceInstanceId: 'answered',
          from: { stage: 'a', settled: 'answered' },
          launchWorkflow: 'a',
          linked: null,
          problems: [],
          startsStep: true,
        },
      ],
    });
    expect(graph.arrows.map(a => [a.from, a.to, a.active])).toEqual([
      [{ stage: 'a', settled: 'answered' }, 'a', true],
      [{ stage: 'a', settled: 'withdrawn' }, 'b', false],
    ]);
    // An asks arrow starts on answers, not on an outcome.
    expect(graph.stages[0]?.outcome?.values).toEqual([
      { value: 'ready', startsNothing: true, ends: false, stops: true },
    ]);
  });

  test('an asks binding that lists options is one arrow per option, each matched by its own file', () => {
    const graph = graphOf(stages(stage('a', ['ready'], true), stage('b', ['done'])), {
      declared: {
        'b-after-a': packAsksSettledBindingSchema.parse({
          workflow: 'b',
          resource: 'b',
          overlap: 'queue',
          asks_settled: { workflow: 'a', settled: 'answered', option: ['replan', 'send-back'] },
        }),
      },
      installed: [
        {
          file: '/home/triggers/replan.json',
          sourceInstanceId: 'replan',
          from: { stage: 'a', settled: 'answered', option: 'replan' },
          launchWorkflow: 'b',
          linked: null,
          problems: [],
          startsStep: true,
        },
      ],
    });
    expect(graph.arrows.map(a => [a.from, a.active])).toEqual([
      [{ stage: 'a', settled: 'answered', option: 'replan' }, true],
      [{ stage: 'a', settled: 'answered', option: 'send-back' }, false],
    ]);
  });

  test('an outcome spelled like a settlement is never matched by an asks arrow', () => {
    const graph = graphOf(stages(stage('a', ['asks:answered'], true), stage('b', ['done'])), {
      declared: { 'b-after-a': runEnded('b', 'a', 'asks:answered') },
      installed: [
        {
          file: '/home/triggers/asks.json',
          sourceInstanceId: 'asks',
          from: { stage: 'a', settled: 'answered' },
          launchWorkflow: 'b',
          linked: null,
          problems: [],
          startsStep: true,
        },
      ],
    });
    expect(graph.arrows.map(a => [a.from, a.active])).toEqual([
      [{ stage: 'a', outcome: 'asks:answered' }, false],
      [{ stage: 'a', settled: 'answered' }, true],
    ]);
    expect(graph.stages[0]?.outcome?.values).toEqual([
      { value: 'asks:answered', startsNothing: true, ends: false, stops: true },
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
        linked: null,
        active: true,
        declared: null,
        installed: {
          file: '/home/triggers/hand-written.json',
          sourceInstanceId: 'hand-written',
          problems: [],
        },
      },
    ]);
    expect(graph.stages[0]?.outcome?.values).toEqual([
      { value: 'ready', startsNothing: false, ends: false, stops: false },
    ]);
  });

  test('a linked trigger file is never the declared same-item arrow it shares stages with', () => {
    const graph = graphOf(stages(stage('a', ['ready']), stage('b', ['done'])), {
      declared: { 'b-after-a': runEnded('b', 'a', 'ready') },
      installed: [{ ...installed('a', 'ready', 'b', 'order'), linked: noEntries(partOfOrder) }],
    });
    expect(graph.arrows.map(arrow => [arrow.active, arrow.declared?.binding ?? null])).toEqual([
      [false, 'b-after-a'],
      [true, null],
    ]);
  });

  test('a declared linked binding is the installed file with the same link, and only that one', () => {
    const declared = packRunEndedBindingSchema.parse({
      workflow: 'b',
      resource: 'b',
      overlap: 'queue',
      run_ended: { workflow: 'a', outcome: 'ready', linked: partOfOrder },
    });
    const graph = graphOf(stages(stage('a', ['ready']), stage('b', ['done'])), {
      declared: { 'order-after-member': declared },
      installed: [
        installed('a', 'ready', 'b', 'same-item'),
        { ...installed('a', 'ready', 'b', 'order'), linked: noEntries(partOfOrder) },
        {
          ...installed('a', 'ready', 'b', 'depends'),
          linked: noEntries({ kind: 'depends_on', holder: 'to' } as const),
        },
      ],
    });
    expect(
      graph.arrows.map(arrow => [arrow.installed?.file ?? null, arrow.declared?.binding ?? null])
    ).toEqual([
      ['/home/triggers/order.json', 'order-after-member'],
      ['/home/triggers/same-item.json', null],
      ['/home/triggers/depends.json', null],
    ]);
  });

  test('an arrow shows the items a linked binding names and the inputs read from each entry', () => {
    const named = { ...partOfOrder, items: '/start' };
    const declared = packRunEndedBindingSchema.parse({
      workflow: 'b',
      resource: 'b',
      overlap: 'queue',
      run_ended: { workflow: 'a', outcome: 'ready', linked: named },
      inputs: { brief: { entry: '/brief' }, parent: { item: 'key' } },
    });
    const declaredOnly = graphOf(stages(stage('a', ['ready']), stage('b', ['done'])), {
      declared: { 'order-after-split': declared },
      installed: [],
    });
    // Inactive: what the declaration maps.
    expect(declaredOnly.arrows.map(arrow => arrow.linked)).toEqual([
      { ...named, entries: { brief: '/brief' } },
    ]);

    const graph = graphOf(stages(stage('a', ['ready']), stage('b', ['done'])), {
      declared: { 'order-after-split': declared },
      installed: [
        { ...installed('a', 'ready', 'b', 'every-holder'), linked: noEntries(partOfOrder) },
        // Another entry pointer is still the declared arrow, shown as the file maps it.
        {
          ...installed('a', 'ready', 'b', 'named'),
          linked: { ...named, entries: { brief: '/summary' } },
        },
      ],
    });
    expect(
      graph.arrows.map(arrow => [
        arrow.installed?.file ?? null,
        arrow.declared?.binding ?? null,
        arrow.linked,
      ])
    ).toEqual([
      [
        '/home/triggers/named.json',
        'order-after-split',
        { ...named, entries: { brief: '/summary' } },
      ],
      // Without the same items it is not the declared arrow.
      ['/home/triggers/every-holder.json', null, noEntries(partOfOrder)],
    ]);
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
    expect(graph.stages[0]?.outcome?.values).toEqual([
      { value: 'ready', startsNothing: true, ends: false, stops: true },
    ]);
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
        { value: 'approve', startsNothing: true, ends: false, stops: true },
        { value: 'reject', startsNothing: true, ends: false, stops: true },
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
        { value: 'succeeded', startsNothing: false, ends: false, stops: false },
        { value: 'failed', startsNothing: true, ends: false, stops: true },
      ],
    });
  });

  test('an outcome stops its item unless it ends it, its stage observes, or a step starts on it', () => {
    const review = wf('review', [decide(['close', 'not_ready', 'ready', 'advise'])], {
      returns: 'decide',
      result: { outcome: 'outcome', ends: ['close'] },
    });
    const shadow = wf('shadow', [decide(['agree', 'disagree'])], {
      returns: 'decide',
      result: { outcome: 'outcome' },
      observes: true,
    });
    const staged = stages(
      review,
      shadow,
      stage('build', ['done']),
      stage('host', ['open'], false, true)
    );
    const declared = {
      'build-after-review': runEnded('build', 'review', 'ready'),
      // Starts only an observing stage, which moves nothing on.
      'shadow-after-review': runEnded('shadow', 'review', 'advise'),
      // Starts on linked items, so it starts nothing on the ended run's own item.
      'build-linked': packRunEndedBindingSchema.parse({
        workflow: 'build',
        resource: 'build',
        overlap: 'queue',
        run_ended: { workflow: 'review', outcome: 'not_ready', linked: partOfOrder },
      }),
    };
    const graph = graphOf(staged, {
      declared,
      installed: [
        installed('review', 'ready', 'build', 'file-build'),
        // The check resolved the file's target as a workflow that observes its item.
        installed('review', 'advise', 'shadow', 'file-shadow', [], false),
      ],
    });

    const [reviewed, shadowed] = graph.stages;
    expect(reviewed?.outcome?.values).toEqual([
      { value: 'close', startsNothing: true, ends: true, stops: false },
      { value: 'not_ready', startsNothing: true, ends: false, stops: true },
      { value: 'ready', startsNothing: false, ends: false, stops: false },
      { value: 'advise', startsNothing: false, ends: false, stops: true },
    ]);
    expect(shadowed?.observes).toBe(true);
    expect(shadowed?.outcome?.values.map(v => v.stops)).toEqual([false, false]);
    // Read from the declared bindings alone, as `archon validate workflows` reads them.
    // A stage that can leave a wait stops its item only when a run leaves none.
    expect(graph.stages[3]?.outcome?.values.map(v => v.stops)).toEqual([true]);
    expect(declaredStops('chain', staged, declared)).toEqual([
      { stage: 'review', outcome: 'not_ready', unless: [] },
      { stage: 'review', outcome: 'advise', unless: [] },
      { stage: 'build', outcome: 'done', unless: [] },
      { stage: 'host', outcome: 'open', unless: ['waits'] },
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
      loaded: [],
      otherCopies: [],
      laterField: 1,
      stages: graph.stages.map(s => ({ ...s, laterField: true })),
    };
    expect(packGraphSchema.safeParse(newer).success).toBe(true);
  });
});
