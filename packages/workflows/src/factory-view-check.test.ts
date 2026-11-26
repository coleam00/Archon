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

/** A view file whose picture names only what the graph has. */
function view(): FactoryView {
  return {
    version: 1,
    summary: 'x',
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

test('a picture naming only what the graph has passes clean', () => {
  expect(problems()).toEqual([]);
});

describe('what the picture names and the graph lacks drops alone', () => {
  test('a card stage the graph lacks leaves the card, and a card left with none stays unbound', () => {
    const edit = (v: FactoryView) => {
      v.howItWorks.views.top!.cards[0] = card('a', ['make', 'deploy']);
      v.howItWorks.views.top!.cards.push(card('c', ['gone']));
    };
    expect(problems(edit)).toEqual([
      'dropped howItWorks.views.top.cards.0.stages.1',
      'dropped howItWorks.views.top.cards.2.stages.0',
    ]);
    const cards = served(edit).howItWorks.views.top!.cards;
    expect(cards[0]?.stages).toEqual(['make']);
    expect(cards[2]).not.toHaveProperty('stages');
  });

  test('an edge between stages no arrow joins', () => {
    const edit = (v: FactoryView) =>
      void v.howItWorks.views.top!.edges.push({ from: 'b', to: 'a', kind: 'loops-back' });
    expect(problems(edit)).toEqual(['dropped howItWorks.views.top.edges.1']);
    expect(served(edit).howItWorks.views.top!.edges).toHaveLength(1);
  });
});

test('a calls edge asks someone and is not compared with the arrows', () => {
  expect(
    problems(v => void v.howItWorks.views.top!.edges.push({ from: 'b', to: 'a', kind: 'calls' }))
  ).toEqual([]);
});
