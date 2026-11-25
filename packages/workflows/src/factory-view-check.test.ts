import { describe, expect, test } from 'bun:test';
import { checkFactoryView } from './factory-view-check';
import type { PackGraph, PackGraphArrow } from './pack-graph';
import type { FactoryView } from './schemas/factory-view';

type GraphStage = PackGraph['stages'][number];

const PACK = 'acme/factory';

const stage = (
  workflow: string,
  steps: string[],
  outcomes: string[],
  inFlow = true
): GraphStage => ({
  name: `${PACK}:${workflow}`,
  workflow,
  entry: false,
  roles: [],
  inFlow,
  returns: outcomes.length === 0 ? null : 'end',
  outcome:
    outcomes.length === 0
      ? null
      : {
          field: 'outcome',
          form: 'enum',
          values: outcomes.map(value => ({ value, startsNothing: false, final: false })),
        },
  asks: false,
  waits: false,
  nodes: steps.map(id => ({
    id,
    kind: 'bash',
    dependsOn: [],
    loopGroup: null,
    blocks: [],
    fanOut: null,
  })),
});

/** A declared-only arrow: inactive, as every arrow is on a home with no trigger files. */
const arrow = (from: string, outcome: string, to: string): PackGraphArrow => ({
  from: { stage: `${PACK}:${from}`, outcome },
  to: `${PACK}:${to}`,
  linked: null,
  active: false,
  declared: { binding: `${from}-${to}`, problems: [] },
  installed: null,
});

/** make (done) -> check (pass) -> land; `helper` is included only, so never in flow. */
function graph(): PackGraph {
  return {
    pack: 'acme.factory',
    loaded: [],
    otherCopies: [],
    stages: [
      stage('make', ['write', 'end'], ['done']),
      stage('check', ['read'], ['pass', 'fail']),
      stage('land', ['merge'], []),
      stage('helper', ['help'], [], false),
    ],
    entries: [],
    document: null,
    metricViews: null,
    groups: [
      { name: 'Build', stages: ['make', 'check'] },
      { name: 'Ship', stages: ['land'] },
    ],
    capacity: [],
    settings: [],
    settingsFile: { path: '', problems: [] },
    arrows: [arrow('make', 'done', 'check'), arrow('check', 'pass', 'land')],
    fanOutBlocks: [],
    discoveryErrors: [],
  };
}

const card = (id: string, stages?: string[]) => ({
  id,
  title: id,
  text: id,
  icon: 'hammer' as const,
  kind: 'stage' as const,
  col: 1,
  row: 1,
  ...(stages === undefined ? {} : { stages }),
});

/** A view naming everything the graph has, and only that. */
function view(): FactoryView {
  const words = { label: 'x', blurb: 'x' };
  return {
    version: 1,
    title: 'Factory',
    summary: 'x',
    groups: { Build: { blurb: 'x' }, Ship: { blurb: 'x' } },
    stages: {
      make: { ...words, steps: { write: 'Writes' } },
      check: {
        ...words,
        drilldown: {
          phases: [
            {
              label: 'Read',
              cards: [{ ...card('r'), kind: 'check', icon: 'gavel', covers: ['read'] }],
            },
          ],
        },
      },
      land: words,
    },
    outcomes: { 'make:done': { story: 'Made it' }, 'land:*': { story: 'Landed' } },
    map: {
      cards: [
        { id: 'build', stages: ['make', 'check'] },
        { id: 'ship', stages: ['land'] },
      ],
      edges: [
        { from: 'build', to: 'build', label: 'built' },
        { from: 'build', to: 'ship', label: 'passed' },
      ],
    },
    howItWorks: {
      title: 'x',
      caption: 'x',
      root: 'top',
      views: {
        top: {
          cards: [card('a', ['make']), card('b', ['check'])],
          edges: [{ from: 'a', to: 'b', kind: 'feeds' }],
        },
      },
    },
  };
}

/** Each problem as `severity path`. */
const problems = (edit: (v: FactoryView) => void = () => undefined, g: PackGraph = graph()) => {
  const v = view();
  edit(v);
  return checkFactoryView(v, g).map(p => `${p.severity} ${p.path.join('.')}`);
};

test('a view naming only what the graph has passes clean', () => {
  expect(problems()).toEqual([]);
});

describe('a name the graph lacks is an error', () => {
  test.each<[string, (v: FactoryView) => void, string]>([
    [
      'an unknown stage',
      v => void (v.stages.deploy = { label: 'x', blurb: 'x' }),
      'error stages.deploy',
    ],
    [
      'an unknown map stage',
      v => void v.map.cards[1]?.stages.push('deploy'),
      'error map.cards.1.stages.1',
    ],
    [
      'an unknown step',
      v => void (v.stages.make!.steps = { gone: 'x' }),
      'error stages.make.steps.gone',
    ],
    [
      'an unknown covered step',
      v => void (v.stages.check!.drilldown!.phases[0]!.cards[0]!.covers = ['gone']),
      'error stages.check.drilldown.phases.0.cards.0.covers.0',
    ],
    [
      'an unknown outcome',
      v => void (v.outcomes!['make:gone'] = { label: 'x' }),
      'error outcomes.make:gone',
    ],
    [
      'an exact outcome of a stage that declares none',
      v => void (v.outcomes!['land:x'] = {}),
      'error outcomes.land:x',
    ],
    [
      'an option no asks arrow leaves on',
      v => void (v.answers = { 'make:drop': { starts: 'x' } }),
      'error answers.make:drop',
    ],
    ['an unknown group', v => void (v.groups!.Other = { blurb: 'x' }), 'error groups.Other'],
    [
      'a map edge between stages no arrow joins',
      v => void v.map.edges?.push({ from: 'ship', to: 'build', label: 'back' }),
      'error map.edges.2',
    ],
    [
      'a How it works edge between stages no arrow joins',
      v => void v.howItWorks.views.top!.edges.push({ from: 'b', to: 'a', kind: 'loops-back' }),
      'error howItWorks.views.top.edges.1',
    ],
  ])('%s', (_name, edit, expected) => {
    expect(problems(edit)).toEqual([expected]);
  });
});

test('a calls edge asks someone and is not compared with the arrows', () => {
  expect(
    problems(v => void v.howItWorks.views.top!.edges.push({ from: 'b', to: 'a', kind: 'calls' }))
  ).toEqual([]);
});

describe('what the graph has and the view leaves out warns', () => {
  test('an in-flow stage on no map card, or with no words', () => {
    expect(
      problems(v => {
        v.map.cards.pop();
        v.map.edges?.pop();
        delete v.stages.land;
      })
    ).toEqual(['warning map.cards', 'warning stages']);
  });

  test('a group with no words', () => {
    expect(problems(v => void delete v.groups!.Ship)).toEqual(['warning groups']);
  });

  test('a stage that is not in flow is not warned on', () => {
    const g = graph();
    expect(g.stages.some(s => s.workflow === 'helper' && !s.inFlow)).toBe(true);
    expect(problems(undefined, g)).toEqual([]);
  });
});

describe('progress declarations are checked against the graph', () => {
  /** `check` with a loop group `rounds` holding `rounds.judge`. */
  function loopGraph(): PackGraph {
    const g = graph();
    const check = g.stages.find(s => s.workflow === 'check');
    const node = { kind: 'bash', dependsOn: [], blocks: [], fanOut: null };
    check?.nodes.push(
      { ...node, id: 'rounds', loopGroup: null },
      { ...node, id: 'rounds.judge', loopGroup: 'rounds' }
    );
    return g;
  }
  /** Returns and approvals on check's judge, rounds from its loop, the change from make and an old `deliver`. */
  const declared = (v: FactoryView): void => {
    v.outcomes!['check:fail'] = { reads: 'returned' };
    v.retired = ['deliver'];
    v.rounds = [
      { workflow: 'check', loop: 'rounds' },
      { workflow: 'deliver', loop: 'anything' },
    ];
    v.returns = [
      { workflow: 'check', node: 'rounds.judge', outcome: 'fail' },
      { workflow: 'deliver', node: 'gone.step', outcome: 'return' },
    ];
    v.approves = [{ workflow: 'check', node: 'rounds.judge', outcome: 'pass' }];
    v.change = [
      { workflow: 'make', pointer: '/change' },
      { workflow: 'deliver', pointer: '/change' },
    ];
  };
  const checked = (edit: (v: FactoryView) => void) =>
    problems(v => {
      declared(v);
      edit(v);
    }, loopGraph());

  test('a valid declaration passes, a retired workflow unchecked', () => {
    expect(checked(() => undefined)).toEqual([]);
  });

  test.each<[string, (v: FactoryView) => void, string[]]>([
    [
      'an unknown workflow',
      v => void v.approves?.push({ workflow: 'ship', node: 'x', outcome: 'y' }),
      ['error approves.1.workflow'],
    ],
    ['a retired workflow the graph has', v => void v.retired?.push('land'), ['error retired.1']],
    ['a workflow retired twice', v => void v.retired?.push('deliver'), ['error retired.1']],
    [
      'an unknown step',
      v => void (v.approves = [{ workflow: 'check', node: 'judge', outcome: 'pass' }]),
      ['error approves.0.node'],
    ],
    [
      'an unknown loop',
      v => void (v.rounds = { workflow: 'check', loop: 'laps' }),
      ['error rounds.loop'],
    ],
    [
      'a source naming one workflow twice',
      v =>
        void (v.change = [
          { workflow: 'make', pointer: '/a' },
          { workflow: 'make', pointer: '/b' },
        ]),
      ['error change.1'],
    ],
    [
      'an outcome read as returned that no return point counts',
      v => void (v.outcomes!['make:done'] = { reads: 'returned' }),
      ['error outcomes.make:done'],
    ],
    [
      'a return point on a stage none of whose outcomes reads returned',
      v => void delete v.outcomes!['check:fail'],
      ['error returns.0.workflow'],
    ],
  ])('%s is an error', (_name, edit, expected) => {
    expect(checked(edit)).toEqual(expected);
  });
});
