import type { PackGraph } from '../../skills/items';

/*
 * A small pack graph, written by hand for the factory console's tests: the Wirasm factory's
 * shape in 16 stages, with its stage ids and words, holding only what the tests read. It is not
 * a copy of a real pack; `scripts/check-factory-view.ts` checks the real pack's view file
 * against a real pack tree. It has:
 *
 * - four document groups with blurbs and kinds, an exit stage (`landed`) and count words;
 * - an entry stage (`order`) whose work orders loop back to it over a `part_of` link, an event
 *   entry stage (`survey`), an observing stage reached over a linked arrow (`order-done`), and
 *   an out-of-flow stage in no group with no `display` (`review`);
 * - a retired workflow (`deliver`) standing at `stage-build`, and check rounds on `stage-check`;
 * - arrows of every kind the map sorts: forward hand-offs, ones that skip a column, answers,
 *   send-backs, self hand-offs, a `depends_on` arrow the map leaves out, and Merged's.
 */

type Stage = PackGraph['stages'][number];
type Display = NonNullable<Stage['display']>;
type Arrow = PackGraph['arrows'][number];
type Linked = NonNullable<Arrow['linked']>;

const name = (workflow: string): string => `Wirasm/archon-software-factory:${workflow}`;

/** An outcome value, with its label and story when the pack words it. */
type Outcome = [value: string, label?: string, story?: string];

function stage(
  workflow: string,
  outcomes: Outcome[] | null,
  display: Display | undefined,
  {
    nodes = [],
    inFlow = true,
    entry = false,
    observes = false,
  }: { nodes?: [string, string][]; inFlow?: boolean; entry?: boolean; observes?: boolean } = {}
): Stage {
  return {
    name: name(workflow),
    workflow,
    entry,
    roles: [],
    inFlow,
    returns: 'end',
    outcome:
      outcomes === null
        ? null
        : {
            field: 'outcome',
            form: 'enum',
            values: outcomes.map(([value, label, story]) => ({
              value,
              startsNothing: true,
              ends: false,
              stops: true,
              ...(label === undefined ? {} : { display: { label, ...(story ? { story } : {}) } }),
            })),
          },
    observes,
    asks: true,
    waits: false,
    nodes: nodes.map(([id, label]) => ({
      id,
      kind: 'agent',
      dependsOn: [],
      loopGroup: null,
      blocks: [],
      fanOut: null,
      display: { label },
    })),
    ...(display === undefined ? {} : { display }),
  };
}

/** A stage's ask options as the pack labels them. */
const answers = (labels: Record<string, string>): Display['answers'] =>
  Object.fromEntries(Object.entries(labels).map(([option, label]) => [option, { label }]));

const DECIDE = {
  'send-back': 'sent back',
  other: 'something else',
  drop: 'dropped by you',
  reshape: 'needs shaping',
};

const card = (title: string, covers: string, text = title) => ({
  title,
  text,
  icon: 'hammer',
  kind: 'agent',
  covers: [covers],
});

const STAGES: Stage[] = [
  stage(
    'order',
    [
      ['ready', 'ready'],
      ['work_order', 'Ordered as a work order'],
    ],
    { label: 'Order', short: 'Orders, labelled issues' },
    { entry: true }
  ),
  stage(
    'triage',
    [
      ['build', 'build'],
      ['narrow', 'narrow'],
      ['split', 'split'],
      ['park', 'Parked by triage'],
    ],
    {
      label: 'Triage',
      short: 'Is it worth building?',
      answers: answers({ build: 'build', ...DECIDE }),
    }
  ),
  stage(
    'link',
    [
      ['place', 'placed'],
      ['waiting', 'waiting on what it needs'],
    ],
    {
      label: 'Link',
      short: 'What does it wait on?',
    }
  ),
  stage(
    'split',
    [
      ['whole', 'kept whole'],
      ['split', 'Split into pieces'],
    ],
    {
      label: 'Split',
      short: 'Cuts it into pieces',
      phases: [{ label: 'Cut', cards: [card('Cut it', 'cut', 'Cuts the item into pieces')] }],
    },
    { nodes: [['cut', 'Cuts the item']] }
  ),
  stage('plan', [['planned', 'planned']], { label: 'Plan', short: 'Plans how to build it' }),
  stage(
    'stage-build',
    [
      ['built', 'built'],
      ['built_for_host', 'fixed for CI'],
      ['replan', 'plan again'],
    ],
    {
      label: 'Build',
      short: 'Writes the change and PR',
      blurb: 'Writes the change and opens a draft pull request, then fixes what comes back.',
      answers: answers(DECIDE),
      phases: [
        { label: 'Write', cards: [card('Write or fix the change', 'build__build')] },
        { label: 'Hand off', cards: [card('Count the round', 'limit'), card('Hand off', 'end')] },
      ],
      results: { change: '/change' },
      replaces: [
        {
          workflow: 'deliver',
          loops: { round: 'rounds' },
          marks: [
            { node: 'rounds.verdict__verdict', outcome: 'return', means: 'returns' },
            { node: 'hostrounds.host__host', outcome: 'return', means: 'returns' },
            { node: 'rounds.verdict__verdict', outcome: 'approve', means: 'approves' },
          ],
          results: { change: '/change' },
        },
      ],
    },
    {
      nodes: [
        ['build__build', 'Writes or fixes the change'],
        ['limit', 'Counts the round'],
        ['end', 'Hands the change on'],
      ],
    }
  ),
  stage(
    'stage-check',
    [
      ['approve', 'approved', 'The checks approved it'],
      ['return', 'returned', 'The checks sent it back'],
      ['replan', 'plan again'],
    ],
    {
      label: 'Checks',
      short: 'Review, tests, product',
      answers: answers({ ...DECIDE, 'one-more-round': 'one more round' }),
      results: { round: '/round', allowance: '/allowance', change: '/change' },
      marks: [
        { node: 'verdict__verdict', outcome: 'return', means: 'returns' },
        { node: 'verdict__verdict', outcome: 'approve', means: 'approves' },
      ],
    },
    {
      nodes: [
        ['review__review', 'Code review'],
        ['verdict__verdict', 'Verdict'],
      ],
    }
  ),
  stage(
    'stage-host',
    [
      ['ready', 'ready'],
      ['return', 'returned'],
    ],
    {
      label: 'CI and review',
      short: 'Reads CI and PR reviews',
      answers: answers(DECIDE),
      results: { change: '/change' },
      marks: [{ node: 'rounds__host', outcome: 'return', means: 'returns' }],
    },
    { nodes: [['rounds__host', 'Reads CI and the reviews']] }
  ),
  stage('landgate', [['land', 'merge it']], {
    label: 'Merge gate',
    short: 'May it merge?',
    answers: answers({ land: 'merge it', ...DECIDE }),
  }),
  stage(
    'land',
    [
      ['landed', 'merged'],
      ['behind', 'behind its branch'],
    ],
    {
      label: 'Land',
      short: 'Merges the change',
    }
  ),
  stage(
    'landed',
    [
      ['clear', 'branch sound'],
      ['broken_here', 'broke the branch'],
    ],
    { label: 'Merged', short: 'The change is merged', answers: answers({ fix: 'fix ordered' }) },
    { observes: true }
  ),
  stage('discoveries', null, {
    label: 'Discoveries',
    short: 'Files what was noticed',
    story: 'The factory looked for other work it noticed',
  }),
  stage(
    'survey',
    [['build', 'would build']],
    { label: 'Survey', short: 'Would triage build it?' },
    { entry: true, observes: true }
  ),
  stage(
    'close',
    [
      ['dropped', 'Dropped by you'],
      ['reshape', 'Needs shaping'],
    ],
    {
      label: 'Drop or reshape',
      short: 'Carries out your answer',
    }
  ),
  stage(
    'order-done',
    [
      ['reported', 'reported'],
      ['proposed', 'proposed for landing'],
    ],
    { label: 'Order done', short: 'Reports finished orders' },
    { observes: true }
  ),
  stage('review', null, undefined, { inFlow: false }),
];

function arrow(from: Arrow['from'], to: string, link?: [Linked['kind'], Linked['holder']]): Arrow {
  return {
    from: { ...from, stage: name(from.stage) },
    to: name(to),
    linked: link === undefined ? null : { kind: link[0], holder: link[1], entries: {} },
    active: false,
    declared: { binding: `${to}-after-${from.stage}`, problems: [] },
    installed: null,
  };
}
const on = (
  stage: string,
  outcome: string,
  to: string,
  link?: [Linked['kind'], Linked['holder']]
) => arrow({ stage, outcome }, to, link);
const answered = (stage: string, option: string | undefined, to: string) =>
  arrow({ stage, settled: 'answered', ...(option === undefined ? {} : { option }) }, to);

const ARROWS: Arrow[] = [
  on('order', 'ready', 'triage'),
  on('order', 'work_order', 'order', ['part_of', 'from']),
  on('triage', 'build', 'link'),
  on('triage', 'narrow', 'link'),
  on('triage', 'park', 'link', ['depends_on', 'from']),
  on('link', 'place', 'plan'),
  arrow({ stage: 'link', settled: 'any' }, 'link'),
  answered('triage', 'build', 'link'),
  answered('triage', 'other', 'triage'),
  answered('triage', 'drop', 'close'),
  answered('triage', 'reshape', 'close'),
  on('triage', 'split', 'split'),
  on('split', 'whole', 'plan'),
  on('split', 'split', 'order', ['part_of', 'from']),
  answered('split', undefined, 'split'),
  on('plan', 'planned', 'stage-build'),
  answered('plan', undefined, 'plan'),
  on('stage-build', 'built', 'stage-check'),
  on('stage-build', 'built_for_host', 'stage-host'),
  on('stage-build', 'replan', 'plan'),
  answered('stage-build', 'send-back', 'stage-build'),
  answered('stage-build', 'drop', 'close'),
  answered('stage-build', 'reshape', 'close'),
  on('stage-check', 'approve', 'stage-host'),
  on('stage-check', 'return', 'stage-build'),
  on('stage-check', 'replan', 'plan'),
  answered('stage-check', 'send-back', 'stage-build'),
  answered('stage-check', 'one-more-round', 'stage-build'),
  answered('stage-check', 'other', 'stage-build'),
  on('stage-host', 'ready', 'landgate'),
  on('stage-host', 'return', 'stage-build'),
  // Two stages of one column hand the same word forward: the pill names it once.
  answered('stage-check', 'drop', 'close'),
  answered('stage-host', 'drop', 'close'),
  on('landgate', 'land', 'land'),
  answered('landgate', 'land', 'land'),
  answered('landgate', 'send-back', 'stage-build'),
  on('land', 'landed', 'landed'),
  on('land', 'landed', 'discoveries'),
  on('land', 'landed', 'order-done', ['part_of', 'to']),
  on('land', 'behind', 'stage-build'),
  on('order-done', 'reported', 'order-done', ['part_of', 'to']),
  on('order-done', 'proposed', 'landgate'),
  on('landed', 'broken_here', 'order'),
  answered('landed', 'fix', 'order'),
];

export const smallGraph: PackGraph = {
  pack: 'Wirasm.archon-software-factory',
  loaded: [{ source: 'installed', key: 'Wirasm.archon-software-factory', dir: '<install>' }],
  otherCopies: [],
  stages: STAGES,
  entries: [
    { binding: 'order', kind: 'fire', stage: name('order') },
    { binding: 'survey-on-opened', kind: 'event', stage: name('survey') },
  ],
  document: {
    path: 'how-it-works.md',
    problems: [],
    text: '# How the factory works\n',
    words: { round: 'check round', rounds: 'check rounds', sentBack: 'sent back' },
    exit: 'landed',
  },
  metricViews: null,
  groups: [
    {
      name: 'Intake',
      blurb: 'Order, triage, split and link',
      stages: ['order', 'triage', 'split', 'link', 'survey'],
      kind: 'intake',
    },
    {
      name: 'Plan and build',
      blurb: 'Plan, then build',
      stages: ['plan', 'stage-build'],
      kind: 'build',
    },
    {
      name: 'Checks',
      blurb: 'Checks, CI and PR reviews',
      stages: ['stage-check', 'stage-host'],
      kind: 'check',
    },
    {
      name: 'Landing',
      blurb: 'Gate, merge, and what follows the merge',
      stages: ['landgate', 'land', 'landed', 'discoveries', 'close', 'order-done'],
      kind: 'merge',
    },
  ],
  capacity: [],
  settings: [],
  settingsFile: { path: '.archon/packs/Wirasm.archon-software-factory.yaml', problems: [] },
  arrows: ARROWS,
  fanOutBlocks: [],
  discoveryErrors: [],
};
