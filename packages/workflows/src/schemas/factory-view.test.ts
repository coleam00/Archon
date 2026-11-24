import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { factoryViewSchema, type FactoryView } from './factory-view';

/** The declaration this repository ships for its own factory, as a project file. */
const SHIPPED = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '.archon',
  'packs',
  'Wirasm.archon-software-factory.factory-view.json'
);

const minimal = (): FactoryView => ({
  version: 1,
  pack: 'factory',
  title: 'Factory',
  summary: 'Items in, changes out.',
  stages: [
    { id: 'plan', label: 'Plan', blurb: 'Plans.', group: 'intake', workflows: ['plan'] },
    { id: 'build', label: 'Build', blurb: 'Builds.', group: 'build', workflows: ['build'] },
    { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
  ],
  placement: { 'plan:planned': 'build' },
  endings: { 'plan:*': 'Stopped' },
  landed: { stage: 'landed' },
  map: {
    cards: [{ stage: 'plan' }, { stage: 'build' }],
    arrows: [{ from: 'build', to: 'landed', label: 'merged' }],
    notes: [{ text: 'You answer asks here', near: 'needs-you' }],
  },
});

type Drilldown = NonNullable<FactoryView['stages'][number]['drilldown']>;

/** Build's story in two phases, the second repeated by its `rounds` loop. */
const drilldown = (): Drilldown => ({
  phases: [
    {
      label: 'Build',
      cards: [
        {
          title: 'Write the change',
          text: 'Writes the change and opens a draft pull request',
          icon: 'pencil',
          kind: 'agent',
          covers: [{ workflow: 'build', steps: ['build__build'] }],
        },
      ],
    },
    {
      label: 'Check',
      cards: [
        {
          title: 'Code review',
          text: 'Reads the change',
          icon: 'search-code',
          kind: 'check',
          covers: [{ workflow: 'build', steps: ['rounds.review'] }],
        },
      ],
    },
  ],
  loop: { label: 'Up to 3 rounds', from: 2, to: 2, workflow: 'build', step: 'rounds' },
});

/**
 * Where a rejected declaration fails, as dotted issue paths. The path is what a pack author
 * acts on; the message wording is not asserted.
 */
function issuePaths(view: unknown): string[] {
  const parsed = factoryViewSchema.safeParse(view);
  if (parsed.success) throw new Error('expected the declaration to be rejected');
  return parsed.error.issues.map(issue => issue.path.join('.'));
}

describe('factoryViewSchema', () => {
  test("accepts this repository's shipped declaration", async () => {
    const parsed = factoryViewSchema.safeParse(JSON.parse(await readFile(SHIPPED, 'utf8')));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.pack).toBe('Wirasm/archon-software-factory');
  });

  test('accepts a minimal declaration', () => {
    expect(factoryViewSchema.safeParse(minimal()).success).toBe(true);
  });

  test('a placement naming an undeclared stage is rejected at its key', () => {
    const view = minimal();
    view.placement['plan:planned'] = 'biuld';
    expect(issuePaths(view)).toEqual(['placement.plan:planned']);
  });

  test('placement takes workflow:* beside exact outcomes; a key without both halves is rejected', () => {
    const view = minimal();
    view.placement['build:*'] = 'landed';
    expect(factoryViewSchema.safeParse(view).success).toBe(true);
    for (const key of ['build:', ':built', 'build']) {
      const broken = minimal();
      broken.placement[key] = 'landed';
      expect(issuePaths(broken)).toEqual([`placement.${key}`]);
    }
  });

  test("a declared arrow may join any two stages, and may be marked as a person's step", () => {
    const view = minimal();
    view.map.arrows = [
      { from: 'plan', to: 'build', label: 'planned' },
      { from: 'build', to: 'plan', label: 'replan', back: true, person: true },
      { from: 'plan', to: 'plan', label: 'asks answered' },
    ];
    expect(factoryViewSchema.safeParse(view).error?.issues ?? []).toEqual([]);
  });

  test("a stage's short line is optional and at most 24 characters", () => {
    const view = minimal();
    const plan = view.stages[0];
    if (plan === undefined) throw new Error('minimal() has a first stage');
    expect(factoryViewSchema.safeParse(view).success).toBe(true);
    plan.short = 'x'.repeat(24);
    expect(factoryViewSchema.safeParse(view).success).toBe(true);
    plan.short = 'x'.repeat(25);
    expect(issuePaths(view)).toEqual(['stages.0.short']);
  });

  test('a stage takes a drill-down of phases, cards and a loop over its own workflow', () => {
    const view = minimal();
    view.stages[1] = { ...view.stages[1]!, drilldown: drilldown() };
    const parsed = factoryViewSchema.safeParse(view);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.stages[1]?.drilldown?.phases.map(phase => phase.label)).toEqual([
      'Build',
      'Check',
    ]);
  });

  test("a drill-down card covering a workflow its stage does not list is rejected at the cover's path", () => {
    const view = minimal();
    const steps = drilldown();
    steps.phases[1]!.cards[0]!.covers.push({ workflow: 'plan', steps: ['plan'] });
    view.stages[1] = { ...view.stages[1]!, drilldown: steps };
    expect(issuePaths(view)).toEqual(['stages.1.drilldown.phases.1.cards.0.covers.1.workflow']);
  });

  test('a loop beyond the phases, or naming another workflow, is rejected', () => {
    const view = minimal();
    const steps = drilldown();
    steps.loop = { label: 'Rounds', from: 2, to: 3, workflow: 'plan', step: 'rounds' };
    view.stages[1] = { ...view.stages[1]!, drilldown: steps };
    expect(issuePaths(view)).toEqual([
      'stages.1.drilldown.loop.workflow',
      'stages.1.drilldown.loop',
    ]);
  });

  test('a drill-down card needs a kind it knows and at least one step', () => {
    const view = minimal();
    const steps = drilldown();
    const first = steps.phases[0]!.cards[0]!;
    steps.phases[0]!.cards = [
      { ...first, kind: 'robot' as 'agent' },
      { ...first, covers: [{ workflow: 'build', steps: [] }] },
    ];
    view.stages[1] = { ...view.stages[1]!, drilldown: steps };
    expect(issuePaths(view)).toEqual([
      'stages.1.drilldown.phases.0.cards.0.kind',
      'stages.1.drilldown.phases.0.cards.1.covers.0.steps',
    ]);
  });

  test('a drill-down card names an icon from the closed set', () => {
    const view = minimal();
    const steps = drilldown();
    const first = steps.phases[0]!.cards[0]!;
    steps.phases[0]!.cards = [{ ...first, icon: 'not-an-icon' as 'pencil' }, first];
    view.stages[1] = { ...view.stages[1]!, drilldown: steps };
    expect(issuePaths(view)).toEqual(['stages.1.drilldown.phases.0.cards.0.icon']);
  });

  test('a stage declared twice is rejected', () => {
    const view = minimal();
    view.stages.push({ ...view.stages[0]!, label: 'Again' });
    expect(issuePaths(view)).toEqual(['stages.3.id']);
  });

  test('a returns entry naming a workflow no stage lists is rejected', () => {
    const view = {
      ...minimal(),
      returns: [{ workflow: 'deliver', node: 'verdict', outcome: 'x' }],
    };
    expect(issuePaths(view)).toEqual(['returns.0.workflow']);
  });

  test('an approves entry is accepted beside returns, and one naming a workflow no stage lists is rejected', () => {
    const point = { workflow: 'build', node: 'rounds.verdict', outcome: 'approve' };
    expect(
      factoryViewSchema.safeParse({
        ...minimal(),
        returns: [{ ...point, outcome: 'return' }],
        approves: [point],
      }).success
    ).toBe(true);
    expect(issuePaths({ ...minimal(), approves: [{ ...point, workflow: 'deliver' }] })).toEqual([
      'approves.0.workflow',
    ]);
  });

  test('change is one source or a list; a list names each workflow once, each one a stage lists', () => {
    const one = { workflow: 'build', pointer: '/change' };
    expect(factoryViewSchema.safeParse({ ...minimal(), change: one }).success).toBe(true);
    const list = [one, { workflow: 'plan', pointer: '/pr' }];
    expect(factoryViewSchema.safeParse({ ...minimal(), change: list }).success).toBe(true);
    expect(issuePaths({ ...minimal(), change: [one, one] })).toEqual(['change.1.workflow']);
    expect(
      issuePaths({ ...minimal(), change: [one, { workflow: 'deliver', pointer: '/change' }] })
    ).toEqual(['change.1.workflow']);
    expect(issuePaths({ ...minimal(), change: { workflow: 'deliver', pointer: '/c' } })).toEqual([
      'change.workflow',
    ]);
    expect(issuePaths({ ...minimal(), change: [] })).toEqual(['change']);
  });

  test('rounds takes the loop form, the stage form, or a list of both', () => {
    const loop = { workflow: 'build', loop: 'rounds' };
    const stage = { workflow: 'plan', round: '/round', allowance: '/allowance' };
    for (const rounds of [loop, stage, [loop, stage]])
      expect(factoryViewSchema.safeParse({ ...minimal(), rounds }).error?.issues ?? []).toEqual([]);
    expect(issuePaths({ ...minimal(), rounds: [loop, { ...stage, workflow: 'build' }] })).toEqual([
      'rounds.1.workflow',
    ]);
    expect(issuePaths({ ...minimal(), rounds: { ...stage, workflow: 'deliver' } })).toEqual([
      'rounds.workflow',
    ]);
  });

  test('a stage form with no round pointer, or with a loop too, is rejected', () => {
    const noRound = { workflow: 'plan', allowance: '/allowance' };
    expect(factoryViewSchema.safeParse({ ...minimal(), rounds: noRound }).success).toBe(false);
    expect(factoryViewSchema.safeParse({ ...minimal(), rounds: [noRound] }).success).toBe(false);
    const both = { workflow: 'plan', loop: 'rounds', round: '/round', allowance: '/allowance' };
    expect(factoryViewSchema.safeParse({ ...minimal(), rounds: both }).success).toBe(false);
    const notPointer = { workflow: 'plan', round: 'round', allowance: '/allowance' };
    expect(factoryViewSchema.safeParse({ ...minimal(), rounds: notPointer }).success).toBe(false);
  });

  test('a bad rounds or change source says which entry and which key to fix', () => {
    const said = (view: unknown): string[] =>
      (factoryViewSchema.safeParse(view).error?.issues ?? []).map(
        issue => `${issue.path.join('.')}: ${issue.message}`
      );
    const loop = { workflow: 'build', loop: 'rounds' };
    const stage = 'a stage-form rounds source { workflow, round, allowance }';
    const noRound = { workflow: 'plan', allowance: '/allowance' };
    expect(said({ ...minimal(), rounds: noRound })).toEqual([`rounds: ${stage} needs \`round\``]);
    expect(said({ ...minimal(), rounds: [loop, noRound] })).toEqual([
      `rounds: entry 1: ${stage} needs \`round\``,
    ]);
    // A misspelt key is named, not only the key it was meant to be.
    expect(said({ ...minimal(), rounds: [loop, { ...noRound, rond: '/round' }] })).toEqual([
      `rounds: entry 1: ${stage} does not take \`rond\``,
    ]);
    expect(said({ ...minimal(), rounds: { ...loop, round: '/round' } })).toEqual([
      'rounds: a loop-form rounds source { workflow, loop } does not take `round`',
    ]);
    expect(said({ ...minimal(), rounds: 'build' })).toEqual([
      'rounds: expected a rounds source: { workflow, loop } or { workflow, round, allowance }',
    ]);
    const source = { workflow: 'build', pointer: '/change' };
    expect(said({ ...minimal(), change: [source, { workflow: 'plan' }] })).toEqual([
      'change: entry 1: a change source { workflow, pointer } needs `pointer`',
    ]);
    expect(said({ ...minimal(), change: { workflow: 'build' } })).toEqual([
      'change: a change source { workflow, pointer } needs `pointer`',
    ]);
  });

  test('a partOf naming a workflow no stage lists is rejected', () => {
    expect(
      issuePaths({
        ...minimal(),
        partOf: { workflow: 'order', pointer: '/part_of', outcome: 'ready' },
      })
    ).toEqual(['partOf.workflow']);
  });

  test('discoveries may name a workflow no stage lists; its pointers and keys are checked', () => {
    // Not a shadow, so it needs no `shadows` entry (see "the discoveries flag and the shadows").
    const discoveries = {
      workflow: 'discoveries',
      shadow: false,
      filed: '/filed',
      held: '/held',
      dropped: '/dropped',
      entry: { title: '/title', kind: '/kind', verified: '/verified' },
    };
    expect(factoryViewSchema.safeParse({ ...minimal(), discoveries }).success).toBe(true);
    expect(
      issuePaths({ ...minimal(), discoveries: { ...discoveries, entry: { title: 'title' } } })
    ).toEqual(['discoveries.entry.title']);
    expect(
      issuePaths({ ...minimal(), discoveries: { ...discoveries, folded: '/folded' } })
    ).toEqual(['discoveries']);
  });

  test('step names are accepted for a listed workflow and rejected for one no stage lists', () => {
    const steps = { build: { build__build: 'Writes the change' } };
    expect(factoryViewSchema.safeParse({ ...minimal(), steps }).success).toBe(true);
    expect(issuePaths({ ...minimal(), steps: { deliver: { build__build: 'x' } } })).toEqual([
      'steps.deliver',
    ]);
  });

  test('verdicts and asked are accepted for a listed workflow and rejected for one no stage lists', () => {
    const verdicts = { build: { 'rounds.review': { approve: 'approved', ask: 'asked' } } };
    expect(
      factoryViewSchema.safeParse({ ...minimal(), verdicts, asked: ['build:ask', 'plan:*'] })
        .success
    ).toBe(true);
    expect(
      issuePaths({
        ...minimal(),
        verdicts: { deliver: { review: { return: 'returned' } } },
        asked: ['deliver:ask'],
      })
    ).toEqual(['verdicts.deliver', 'asked.0']);
  });

  test('answers word an option of a listed workflow, exactly, in one plain sentence', () => {
    const answers = { 'build:drop': { starts: 'Closes the PR without merging' } };
    expect(factoryViewSchema.safeParse({ ...minimal(), answers }).success).toBe(true);
    expect(
      issuePaths({ ...minimal(), answers: { 'deliver:drop': { starts: 'Closes it' } } })
    ).toEqual(['answers.deliver:drop']);
    for (const key of ['build:*', 'drop'])
      expect(
        factoryViewSchema.safeParse({ ...minimal(), answers: { [key]: { starts: 'Closes it' } } })
          .success
      ).toBe(false);
    for (const starts of [' ', 'x'.repeat(161)])
      expect(issuePaths({ ...minimal(), answers: { 'build:drop': { starts } } })).toEqual([
        'answers.build:drop.starts',
      ]);
  });

  test('a story may word the discoveries drain; a workflow no stage lists is rejected', () => {
    const story = {
      outcomes: { 'plan:planned': 'Plan wrote the approach', 'build:*': 'Build finished' },
      steps: { build: { build__build: 'Build wrote the change' } },
      said: ['/summary', '/why'],
    };
    expect(factoryViewSchema.safeParse({ ...minimal(), story }).success).toBe(true);
    expect(
      issuePaths({
        ...minimal(),
        story: { outcomes: { 'deliver:ready': 'Ready' }, steps: { deliver: { a: 'A' } } },
      })
    ).toEqual(['story.outcomes.deliver:ready', 'story.steps.deliver']);
  });

  test('a story outcome may be worded by whether the item has a change, both words given', () => {
    const outcomes = { 'plan:*': { withChange: 'Planned its PR', withoutChange: 'Planned' } };
    expect(factoryViewSchema.safeParse({ ...minimal(), story: { outcomes } }).success).toBe(true);
    expect(
      issuePaths({ ...minimal(), story: { outcomes: { 'plan:*': { withChange: 'Planned' } } } })
    ).toEqual(['story.outcomes.plan:*']);
  });

  test('a story sentence is plain text of at most 160 characters; said points into a result', () => {
    expect(issuePaths({ ...minimal(), story: { outcomes: { 'plan:*': ' ' } } })).toEqual([
      'story.outcomes.plan:*',
    ]);
    expect(
      issuePaths({ ...minimal(), story: { outcomes: { 'plan:*': 'x'.repeat(161) } } })
    ).toEqual(['story.outcomes.plan:*']);
    expect(
      issuePaths({ ...minimal(), story: { outcomes: { 'plan:*': 'Planned' }, said: ['summary'] } })
    ).toEqual(['story.said.0']);
  });

  test('a parked outcome is accepted when placed, exactly or by workflow:*', () => {
    const parked = { 'plan:park': { label: 'Parked by planning', why: '/why' } };
    expect(
      factoryViewSchema.safeParse({
        ...minimal(),
        placement: { 'plan:planned': 'build', 'plan:park': 'plan' },
        parked,
      }).success
    ).toBe(true);
    expect(
      factoryViewSchema.safeParse({
        ...minimal(),
        placement: { 'plan:*': 'plan' },
        endings: {},
        parked: { 'plan:park': { label: 'Parked' } },
      }).success
    ).toBe(true);
  });

  test('a parked outcome no placement takes, or one also ended, is rejected', () => {
    expect(issuePaths({ ...minimal(), parked: { 'plan:park': { label: 'Parked' } } })).toEqual([
      'parked.plan:park',
    ]);
    expect(
      issuePaths({
        ...minimal(),
        placement: { 'plan:park': 'plan' },
        endings: { 'plan:park': 'Stopped' },
        parked: { 'plan:park': { label: 'Parked' } },
      })
    ).toEqual(['endings.plan:park']);
    expect(
      issuePaths({
        ...minimal(),
        placement: { 'plan:planned': 'build', 'deliver:park': 'plan' },
        parked: { 'deliver:park': { label: 'Parked' } },
      })
    ).toEqual(['placement.deliver:park', 'parked.deliver:park']);
  });

  test('an awaits outcome is accepted when placed, with its why and questions pointers', () => {
    expect(
      factoryViewSchema.safeParse({
        ...minimal(),
        placement: { 'plan:planned': 'build', 'plan:shape': 'plan' },
        awaits: {
          'plan:shape': { label: 'Needs shaping', why: '/why', questions: '/open_questions' },
        },
      }).success
    ).toBe(true);
    expect(
      issuePaths({
        ...minimal(),
        placement: { 'plan:shape': 'plan' },
        awaits: { 'plan:shape': { label: 'Needs shaping', questions: 'open_questions' } },
      })
    ).toEqual(['awaits.plan:shape.questions']);
  });

  test('an awaits outcome unplaced, ended, parked too or of an unlisted workflow is rejected', () => {
    const awaits = { 'plan:shape': { label: 'Needs shaping' } };
    expect(issuePaths({ ...minimal(), awaits })).toEqual(['awaits.plan:shape']);
    expect(
      issuePaths({
        ...minimal(),
        placement: { 'plan:shape': 'plan' },
        endings: { 'plan:shape': 'Stopped' },
        awaits,
      })
    ).toEqual(['endings.plan:shape']);
    expect(
      issuePaths({
        ...minimal(),
        placement: { 'plan:shape': 'plan' },
        parked: { 'plan:shape': { label: 'Parked' } },
        awaits,
      })
    ).toEqual(['awaits.plan:shape']);
    expect(
      issuePaths({
        ...minimal(),
        placement: { 'deliver:shape': 'plan' },
        awaits: { 'deliver:shape': { label: 'Needs shaping' } },
      })
    ).toEqual(['placement.deliver:shape', 'awaits.deliver:shape']);
  });

  test('a retired workflow a stage lists is accepted; one no stage lists, or twice, is not', () => {
    expect(factoryViewSchema.safeParse({ ...minimal(), retired: ['build'] }).success).toBe(true);
    expect(issuePaths({ ...minimal(), retired: ['deliver'] })).toEqual(['retired.0']);
    expect(issuePaths({ ...minimal(), retired: ['build', 'build'] })).toEqual(['retired.1']);
  });

  test('a verdict meaning outside the closed set is rejected', () => {
    const verdicts = { build: { 'rounds.tests': { sound: 'passed' } } };
    expect(issuePaths({ ...minimal(), verdicts })).toEqual(['verdicts.build.rounds.tests.sound']);
  });

  test('a verdicts entry restating a declared return or approval is rejected at its path', () => {
    const view = {
      ...minimal(),
      returns: [{ workflow: 'build', node: 'rounds.verdict', outcome: 'return' }],
      verdicts: { build: { 'rounds.verdict': { return: 'returned', ask: 'asked' } } },
    };
    expect(issuePaths(view)).toEqual(['verdicts.build.rounds.verdict.return']);
  });

  test('a card for an undeclared stage, and a note near nothing, are rejected', () => {
    const view = minimal();
    view.map.cards[1] = { stage: 'nowhere' };
    view.map.notes = [{ text: 'Here', near: 'nowhere' }];
    expect(issuePaths(view)).toEqual(['map.cards.1.stage', 'map.notes.0.near']);
  });

  test('a card written for the old grid still loads; its col and row are ignored', () => {
    const view = minimal();
    view.map.cards = [
      { stage: 'plan', col: 1, row: 1 },
      { stage: 'build', col: 1, row: 1 },
    ];
    expect(factoryViewSchema.safeParse(view).success).toBe(true);
  });

  test('an unknown field is rejected', () => {
    const parsed = factoryViewSchema.safeParse({ ...minimal(), colour: 'red' });
    expect(parsed.success).toBe(false);
  });
});

describe('factoryViewSchema columns', () => {
  type Columns = NonNullable<FactoryView['columns']>;
  const grouped = (columns: Columns): FactoryView => ({ ...minimal(), columns });
  const work = (stages: string[]): Columns[number] => ({
    id: 'work',
    label: 'Plan & build',
    blurb: 'Plan, build',
    stages,
  });
  const merged: Columns[number] = {
    id: 'merged',
    label: 'Merged',
    blurb: 'Merged changes',
    stages: ['landed'],
  };

  test('groups stages into columns, and keeps them in their declared order', () => {
    const parsed = factoryViewSchema.safeParse(grouped([work(['plan', 'build']), merged]));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.columns?.map(column => column.id)).toEqual(['work', 'merged']);
  });

  test('a stage in no column is a finding', () => {
    expect(issuePaths(grouped([work(['plan']), merged]))).toEqual(['columns']);
  });

  test('a stage in two columns is a finding at its second place', () => {
    const view = grouped([work(['plan', 'build']), { ...work(['build']), id: 'again' }, merged]);
    expect(issuePaths(view)).toEqual(['columns.1.stages.0']);
  });

  test('a column naming a stage no stage declares is a finding at its place', () => {
    expect(issuePaths(grouped([work(['plan', 'build', 'biuld']), merged]))).toEqual([
      'columns.0.stages.2',
    ]);
  });

  test('a column id declared twice is a finding', () => {
    expect(issuePaths(grouped([work(['plan']), work(['build']), merged]))).toEqual([
      'columns.1.id',
    ]);
  });

  test('the landed stage sharing its column is a finding', () => {
    expect(
      issuePaths(grouped([work(['plan']), { ...merged, stages: ['build', 'landed'] }]))
    ).toEqual(['columns.1.stages']);
  });
});

describe('shadows', () => {
  type Shadow = NonNullable<FactoryView['shadows']>[number];
  const verdict = (workflow: string, node: string): Extract<Shadow, { reads: 'verdict' }> => ({
    workflow,
    node,
    label: 'Would it start on its own',
    reads: 'verdict',
    pointer: '/admit',
    why: '/why',
    words: { auto: 'would start on its own', ask: 'would ask you first' },
  });
  const drain = {
    workflow: 'discoveries',
    shadow: true,
    filed: '/filed',
    held: '/held',
    dropped: '/dropped',
    entry: { title: '/title' },
  };

  test("the shipped declaration declares the pack's shadow steps, project checks of the retired deliver; the merge gate acts", async () => {
    const parsed = factoryViewSchema.parse(JSON.parse(await readFile(SHIPPED, 'utf8')));
    // stage-check no longer runs the project checks (pack 43bedfe); deliver's old runs did.
    expect(parsed.shadows?.map(shadow => [shadow.workflow, shadow.node, shadow.reads])).toEqual([
      ['triage', 'admit', 'verdict'],
      ['deliver', 'rounds.checks', 'checks'],
      ['discoveries', 'result', 'lists'],
    ]);
    expect(parsed.retired).toEqual(['deliver']);
  });

  test('each way of reading parses; a shadow may name the discoveries workflow', () => {
    const view = minimal();
    view.discoveries = drain;
    view.shadows = [
      verdict('plan', 'admit'),
      {
        workflow: 'build',
        node: 'rounds.checks',
        label: 'Project checks',
        reads: 'checks',
        results: '/results',
        entry: { name: '/name', passed: '/passed', seconds: '/seconds' },
      },
      {
        workflow: 'discoveries',
        node: 'result',
        label: 'What it would file',
        reads: 'lists',
        lists: [{ pointer: '/filed', words: 'would file' }],
      },
    ];
    expect(factoryViewSchema.safeParse(view).error?.issues ?? []).toEqual([]);
  });

  test('a shadow naming a workflow no stage lists is rejected at its workflow', () => {
    const view = minimal();
    view.shadows = [verdict('triage', 'admit')];
    expect(issuePaths(view)).toEqual(['shadows.0.workflow']);
  });

  test('a step declared a shadow twice is rejected at the second', () => {
    const view = minimal();
    view.shadows = [verdict('plan', 'admit'), verdict('plan', 'admit')];
    expect(issuePaths(view)).toEqual(['shadows.1.node']);
  });

  test('a verdict with no words, or another way of reading, is rejected', () => {
    expect(
      issuePaths({ ...minimal(), shadows: [{ ...verdict('plan', 'admit'), words: {} }] })
    ).toEqual(['shadows.0.words']);
    expect(
      issuePaths({ ...minimal(), shadows: [{ ...verdict('plan', 'admit'), reads: 'guess' }] })
    ).toEqual(['shadows.0.reads']);
  });

  test('the discoveries flag and the shadows agree: a disagreeing flag is rejected', () => {
    const flagged = minimal();
    flagged.discoveries = drain;
    expect(issuePaths(flagged)).toEqual(['discoveries.shadow']);
    const real = minimal();
    real.discoveries = { ...drain, shadow: false };
    real.shadows = [{ ...verdict('discoveries', 'result') }];
    expect(issuePaths(real)).toEqual(['discoveries.shadow']);
  });
});
