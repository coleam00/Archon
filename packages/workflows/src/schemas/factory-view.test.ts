import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { factoryViewSchema, type FactoryView } from './factory-view';

/** The declaration this repository ships for its own factory, as a project file. */
const SHIPPED = join(
  import.meta.dir,
  '../../../../.archon/packs/Wirasm.archon-software-factory.factory-view.json'
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
type Card = Drilldown['phases'][number]['cards'][number];

const card = (title: string, steps: string[], rest: Partial<Card> = {}): Card => ({
  title,
  text: title,
  icon: 'pencil',
  kind: 'agent',
  covers: [{ workflow: 'build', steps }],
  ...rest,
});

/** Build's story in two phases, the second repeated by its `rounds` loop. */
const drilldown = (patch: Partial<Drilldown> = {}): Drilldown => ({
  phases: [
    { label: 'Build', cards: [card('Write the change', ['build__build'])] },
    { label: 'Check', cards: [card('Code review', ['rounds.review'], { kind: 'check' })] },
  ],
  loop: { label: 'Up to 3 rounds', from: 2, to: 2, workflow: 'build', step: 'rounds' },
  ...patch,
});

/** `minimal()` with build's stage given `drilldown`. */
const withDrilldown = (steps: Drilldown) => ({
  stages: minimal().stages.map(stage =>
    stage.id === 'build' ? { ...stage, drilldown: steps } : stage
  ),
});

type Columns = NonNullable<FactoryView['columns']>;
const work = (stages: string[], id = 'work'): Columns[number] => ({
  id,
  label: 'Plan & build',
  blurb: 'Plan, build',
  stages,
});
const merged = (stages = ['landed']): Columns[number] => ({
  id: 'merged',
  label: 'Merged',
  blurb: 'Merged changes',
  stages,
});

const drain = {
  workflow: 'discoveries',
  shadow: true,
  filed: '/filed',
  held: '/held',
  dropped: '/dropped',
  entry: { title: '/title' },
};
const discoveries = { ...drain, shadow: false, entry: { title: '/title', kind: '/kind' } };
const loop = { workflow: 'build', loop: 'rounds' };
const change = { workflow: 'build', pointer: '/change' };
const point = { workflow: 'build', node: 'rounds.verdict', outcome: 'approve' };

/** A declaration: `minimal()` with these top-level fields replaced. */
const viewWith = (patch: Record<string, unknown>) => ({ ...minimal(), ...patch });

/**
 * Where a rejected declaration fails, as dotted issue paths. The path is what a pack author
 * acts on; the message wording is asserted once, below.
 */
function issuePaths(view: unknown): string[] {
  const parsed = factoryViewSchema.safeParse(view);
  if (parsed.success) throw new Error('expected the declaration to be rejected');
  return parsed.error.issues.map(issue => issue.path.join('.'));
}

test("accepts this repository's shipped declaration", async () => {
  const parsed = factoryViewSchema.safeParse(JSON.parse(await readFile(SHIPPED, 'utf8')));
  expect(parsed.error?.issues ?? []).toEqual([]);
  expect(parsed.data?.pack).toBe('Wirasm/archon-software-factory');
});

// The shipped declaration above uses nearly every field; these are the forms it does not.
test.each<[string, Record<string, unknown>]>([
  ['the minimal one', {}],
  ['one change source, loop-form rounds', { change, rounds: loop }],
  [
    'a card written for the old grid: its col and row are ignored',
    { map: { ...minimal().map, cards: [{ stage: 'plan', col: 1, row: 1 }, { stage: 'build' }] } },
  ],
])('factoryViewSchema accepts %s', (_name, patch) => {
  expect(factoryViewSchema.safeParse(viewWith(patch)).error?.issues ?? []).toEqual([]);
});

describe('a declaration the schema rejects, at the path a pack author fixes', () => {
  const review = card('Code review', ['rounds.review'], { kind: 'check' });
  const covers = [...review.covers, { workflow: 'plan', steps: ['p'] }];
  const phases = drilldown().phases.map((p, i) =>
    i === 1 ? { ...p, cards: [{ ...review, covers }] } : p
  );
  const stages = minimal().stages;
  // One row per rule: the issue paths, then the fields that replace minimal()'s.
  test.each<[string[], Record<string, unknown>]>([
    [['placement.plan:planned'], { placement: { 'plan:planned': 'biuld' } }],
    [['placement.build:'], { placement: { 'build:': 'landed' } }],
    [
      ['stages.0.short'],
      { stages: [{ ...stages[0]!, short: 'x'.repeat(25) }, ...stages.slice(1)] },
    ],
    [['stages.3.id'], { stages: [...stages, { ...stages[0]!, label: 'Again' }] }],
    [
      ['stages.1.drilldown.phases.1.cards.0.covers.1.workflow'],
      withDrilldown(drilldown({ phases })),
    ],
    // Every field that names a workflow takes only one a stage lists; returns stands for them.
    [['returns.0.workflow'], { returns: [{ ...point, workflow: 'deliver' }] }],
    [['change.1.workflow'], { change: [change, change] }],
    [['discoveries.entry.title'], { discoveries: { ...discoveries, entry: { title: 'title' } } }],
    [['answers.build:drop.starts'], { answers: { 'build:drop': { starts: 'x'.repeat(161) } } }],
    [['parked.plan:park'], { parked: { 'plan:park': { label: 'Parked' } } }],
    [
      ['endings.plan:shape'],
      {
        placement: { 'plan:shape': 'plan' },
        endings: { 'plan:shape': 'S' },
        awaits: { 'plan:shape': { label: 'N' } },
      },
    ],
    [
      ['verdicts.build.rounds.tests.sound'],
      { verdicts: { build: { 'rounds.tests': { sound: 'passed' } } } },
    ],
    [
      ['map.cards.1.stage'],
      { map: { ...minimal().map, cards: [{ stage: 'plan' }, { stage: 'nowhere' }] } },
    ],
    [['columns'], { columns: [work(['plan']), merged()] }],
    [['columns.1.stages'], { columns: [work(['plan']), merged(['build', 'landed'])] }],
    [['discoveries.shadow'], { discoveries: drain }],
  ])('at %p', (paths, patch) => {
    expect(issuePaths(viewWith(patch))).toEqual(paths);
  });

  test('an unknown field is rejected, as unknown', () => {
    const issues = factoryViewSchema.safeParse(viewWith({ colour: 'red' })).error?.issues ?? [];
    expect(issues.map(issue => [issue.code, issue.path.join('.')])).toEqual([
      ['unrecognized_keys', ''],
    ]);
  });

  test('a bad rounds source says which entry and which key to fix', () => {
    const said = (patch: Record<string, unknown>): string[] =>
      (factoryViewSchema.safeParse(viewWith(patch)).error?.issues ?? []).map(
        issue => `${issue.path.join('.')}: ${issue.message}`
      );
    const stage = 'a stage-form rounds source { workflow, round, allowance }';
    // A misspelt key is named, not only the key it was meant to be.
    expect(said({ rounds: [loop, { workflow: 'plan', allowance: '/a', rond: '/round' }] })).toEqual(
      [`rounds: entry 1: ${stage} does not take \`rond\``]
    );
  });
});
