import { describe, expect, test } from 'bun:test';
import { reconcileFactoryView } from './factory-view-check';
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
          values: outcomes.map(value => ({
            value,
            startsNothing: false,
            ends: false,
            stops: false,
          })),
        },
  observes: false,
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

/** A view naming everything the graph has, and only that, with words for all of it. */
function view(): FactoryView {
  const words = { label: 'x', blurb: 'x' };
  return {
    version: 1,
    title: 'Factory',
    summary: 'x',
    groups: [
      { name: 'Build', blurb: 'x', stages: ['make', 'check'] },
      { name: 'Ship', blurb: 'x', stages: ['land'] },
    ],
    stages: {
      make: { ...words, steps: { write: 'Writes', end: 'Ends' } },
      check: {
        ...words,
        steps: { read: 'Reads' },
        drilldown: {
          phases: [
            {
              label: 'Read',
              cards: [{ ...card('r'), kind: 'check', icon: 'gavel', covers: ['read'] }],
            },
          ],
        },
      },
      land: { ...words, steps: { merge: 'Merges' } },
    },
    outcomes: {
      'make:done': { label: 'made', story: 'Made it' },
      'check:pass': { label: 'passed' },
      'check:fail': { label: 'failed' },
      'land:*': { story: 'Landed' },
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

/** `view()` after `edit`. */
const edited = (edit: (v: FactoryView) => void): FactoryView => {
  const v = view();
  edit(v);
  return v;
};

/** Each problem as `kind path`. */
const problems = (edit: (v: FactoryView) => void = () => undefined, g: PackGraph = graph()) =>
  reconcileFactoryView(edited(edit), g).problems.map(p => `${p.kind} ${p.path.join('.')}`);

/** `view()` after `edit`, as a console is served it against `g`. */
const served = (edit: (v: FactoryView) => void, g: PackGraph = graph()): FactoryView =>
  reconcileFactoryView(edited(edit), g).view;

test('a view naming only what the graph has, and wording all of it, passes clean', () => {
  expect(problems()).toEqual([]);
});

describe('an entry naming what the graph lacks drops alone', () => {
  test.each<[string, (v: FactoryView) => void, string]>([
    ['an unknown stage', v => void (v.stages.deploy = { label: 'x', blurb: 'x' }), 'stages.deploy'],
    ['an unknown merged stage', v => void (v.merged = 'deploy'), 'merged'],
    ['an unknown step', v => void (v.stages.make!.steps!.gone = 'x'), 'stages.make.steps.gone'],
    [
      'an unknown outcome',
      v => void (v.outcomes!['make:gone'] = { label: 'x' }),
      'outcomes.make:gone',
    ],
    [
      'an exact outcome of a stage that declares none',
      v => void (v.outcomes!['land:x'] = {}),
      'outcomes.land:x',
    ],
    [
      'an option no asks arrow leaves on',
      v => void (v.answers = { 'make:drop': { starts: 'x' } }),
      'answers.make:drop',
    ],
    [
      'a group naming a stage the graph lacks',
      v => void v.groups![1]!.stages.push('deploy'),
      'groups.1.stages.1',
    ],
    [
      'a How it works edge between stages no arrow joins',
      v => void v.howItWorks.views.top!.edges.push({ from: 'b', to: 'a', kind: 'loops-back' }),
      'howItWorks.views.top.edges.1',
    ],
  ])('%s', (_name, edit, path) => {
    expect(problems(edit)).toEqual([`dropped ${path}`]);
  });

  test('a stale stage entry leaves the served view, and every other stage stays', () => {
    const v = served(v => void (v.stages.deploy = { label: 'Deploy', blurb: 'x' }));
    expect(Object.keys(v.stages)).toEqual(['make', 'check', 'land']);
    expect(v.stages.make?.steps).toEqual({ write: 'Writes', end: 'Ends' });
  });

  test('a covered step the stage lacks drops its card, and the empty phase and drill-down go with it', () => {
    const edit = (v: FactoryView): void =>
      void (v.stages.check!.drilldown!.phases[0]!.cards[0]!.covers = ['gone']);
    expect(problems(edit)).toEqual([
      'dropped stages.check.drilldown.phases.0.cards.0.covers.0',
      'dropped stages.check.drilldown.phases.0.cards.0',
      'dropped stages.check.drilldown.phases.0',
      'dropped stages.check.drilldown',
    ]);
    expect(served(edit).stages.check?.drilldown).toBeUndefined();
  });

  test('a group left with no stage of the pack goes; one stage in two groups is invalid', () => {
    expect(
      problems(v => {
        v.groups = [
          { name: 'Build', blurb: 'x', stages: ['make', 'check'] },
          { name: 'Old', blurb: 'x', stages: ['deploy'] },
          { name: 'Ship', blurb: 'x', stages: ['land', 'make'] },
        ];
      })
    ).toEqual(['dropped groups.1.stages.0', 'dropped groups.1', 'invalid groups.2.stages.1']);
  });
});

test('a calls edge asks someone and is not compared with the arrows', () => {
  expect(
    problems(v => void v.howItWorks.views.top!.edges.push({ from: 'b', to: 'a', kind: 'calls' }))
  ).toEqual([]);
});

describe('what the graph has and the view gives no words is an error', () => {
  test('an in-flow stage with no words', () => {
    expect(problems(v => void delete v.stages.land)).toEqual([
      'unworded stages.land',
      'unworded stages.land.steps.merge',
    ]);
  });

  test('an in-flow step with no words', () => {
    expect(problems(v => void delete v.stages.make!.steps!.end)).toEqual([
      'unworded stages.make.steps.end',
    ]);
  });

  test('an outcome value with no label, where its stage has no catch-all label either', () => {
    expect(problems(v => void delete v.outcomes!['check:fail'])).toEqual([
      'unworded outcomes.check:fail',
    ]);
    expect(
      problems(v => {
        delete v.outcomes!['check:fail'];
        v.outcomes!['check:*'] = { label: 'checked' };
      })
    ).toEqual([]);
  });

  test('an option an asks-settled arrow leaves on, with no label', () => {
    const g = graph();
    g.arrows.push({
      ...arrow('check', 'x', 'make'),
      from: { stage: `${PACK}:check`, settled: 'answered', option: 'redo' },
    });
    expect(problems(undefined, g)).toEqual(['unworded answers.check:redo']);
    expect(problems(v => void (v.answers = { 'check:redo': { starts: 'x' } }), g)).toEqual([
      'unworded answers.check:redo',
    ]);
    expect(problems(v => void (v.answers = { 'check:redo': { label: 'again' } }), g)).toEqual([]);
  });

  test('a stage that is not in flow needs no words', () => {
    const g = graph();
    expect(g.stages.some(s => s.workflow === 'helper' && !s.inFlow)).toBe(true);
    expect(problems(undefined, g)).toEqual([]);
  });

  test("an in-flow stage the file's groups leave out, apart from the one items leave by", () => {
    expect(problems(v => void v.groups!.pop())).toEqual([]);
    expect(problems(v => void v.groups![0]!.stages.pop())).toEqual(['ungrouped groups']);
  });
});

test("a graph with no groups still serves the file's groups", () => {
  const g = { ...graph(), groups: [] };
  expect(problems(undefined, g)).toEqual([]);
  expect(served(() => undefined, g).groups?.map(group => group.name)).toEqual(['Build', 'Ship']);
});

describe('progress declarations are reconciled with the graph', () => {
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
    v.stages.check!.steps = { read: 'Reads', rounds: 'Rounds', 'rounds.judge': 'Judges' };
    v.outcomes!['check:fail'] = { label: 'failed', reads: 'returned' };
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

  test('a retired workflow placed at a stage of the flow passes', () => {
    expect(checked(v => void (v.retired = [{ workflow: 'deliver', stage: 'make' }]))).toEqual([]);
  });

  test('meaning entries naming a workflow the graph lacks are kept, and it is served as retired', () => {
    const edit = (v: FactoryView): void => {
      declared(v);
      v.rounds = [
        { workflow: 'check', loop: 'rounds' },
        { workflow: 'review', round: '/round', allowance: '/allowance' },
      ];
      v.returns?.push({ workflow: 'review', node: 'verdict', outcome: 'return' });
      v.approves?.push({ workflow: 'review', node: 'verdict', outcome: 'approve' });
      v.change = { workflow: 'review', pointer: '/change' };
    };
    expect(problems(edit, loopGraph())).toEqual([
      'retired returns.2.workflow',
      'retired approves.1.workflow',
      'retired rounds.1.workflow',
      'retired change.workflow',
    ]);
    const v = served(edit, loopGraph());
    expect(v.retired).toEqual(['deliver', 'review']);
    expect(v.rounds).toEqual([
      { workflow: 'check', loop: 'rounds' },
      { workflow: 'review', round: '/round', allowance: '/allowance' },
    ]);
    expect(v.returns?.map(point => point.workflow)).toEqual(['check', 'deliver', 'review']);
    expect(v.approves?.map(point => point.workflow)).toEqual(['check', 'review']);
    // A single source stays a single source, as the board's readers take it.
    expect(v.change).toEqual({ workflow: 'review', pointer: '/change' });
  });

  test.each<[string, (v: FactoryView) => void, string[]]>([
    ['a retired workflow the graph has', v => void v.retired?.push('land'), ['invalid retired.1']],
    ['a workflow retired twice', v => void v.retired?.push('deliver'), ['invalid retired.1']],
    [
      'a workflow retired twice, once with a stage',
      v => void v.retired?.push({ workflow: 'deliver', stage: 'make' }),
      ['invalid retired.1'],
    ],
    [
      'a retired workflow placed at a stage the graph lacks',
      v => void (v.retired = [{ workflow: 'deliver', stage: 'ship' }]),
      ['dropped retired.0.stage'],
    ],
    [
      'a retired workflow placed at a stage outside the flow',
      v => void (v.retired = [{ workflow: 'deliver', stage: 'helper' }]),
      ['dropped retired.0.stage'],
    ],
    [
      'an unknown step of a graph stage',
      v => void (v.approves = [{ workflow: 'check', node: 'judge', outcome: 'pass' }]),
      ['dropped approves.0.node'],
    ],
    [
      'an unknown loop of a graph stage',
      v => void (v.rounds = { workflow: 'check', loop: 'laps' }),
      ['dropped rounds.loop'],
    ],
    [
      'a source naming one workflow twice',
      v =>
        void (v.change = [
          { workflow: 'make', pointer: '/a' },
          { workflow: 'make', pointer: '/b' },
        ]),
      ['invalid change.1'],
    ],
    [
      'an outcome read as returned that no return point counts',
      v => void (v.outcomes!['make:done'] = { label: 'made', reads: 'returned' }),
      ['invalid outcomes.make:done'],
    ],
    [
      'a return point on a stage none of whose outcomes reads returned',
      v => void (v.outcomes!['check:fail'] = { label: 'failed' }),
      ['invalid returns.0.workflow'],
    ],
  ])('%s', (_name, edit, expected) => {
    expect(checked(edit)).toEqual(expected);
  });
});
