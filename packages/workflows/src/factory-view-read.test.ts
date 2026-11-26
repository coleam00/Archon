import { describe, expect, test } from 'bun:test';
import { readFactoryView } from './factory-view-read';

/** A file that reads whole: two stages, one outcome, and a How it works root. */
function file(): Record<string, unknown> {
  return {
    version: 1,
    title: 'Factory',
    summary: 'Work comes in, gets built, lands.',
    stages: {
      make: { label: 'Make', blurb: 'Makes it.' },
      land: { label: 'Land', blurb: 'Lands it.' },
    },
    outcomes: { 'make:done': { label: 'made' } },
    rounds: { workflow: 'make', round: '/round', allowance: '/allowance' },
    howItWorks: {
      title: 'How it works',
      caption: 'x',
      root: 'top',
      views: {
        top: {
          cards: [
            { id: 'a', title: 'a', text: 'a', icon: 'hammer', kind: 'stage', col: 1, row: 1 },
            { id: 'b', title: 'b', text: 'b', icon: 'hammer', kind: 'stage', col: 2, row: 1 },
          ],
          edges: [{ from: 'b', to: 'a', kind: 'loops-back' }],
        },
      },
    },
  };
}

const read = (edit: (f: Record<string, unknown>) => void) => {
  const f = file();
  edit(f);
  return readFactoryView(f);
};

const listed = (r: ReturnType<typeof readFactoryView>): string[] =>
  r.problems.map(problem => `${problem.kind} ${problem.path.join('.')}`);

test('a whole file reads with no problem', () => {
  const r = read(() => undefined);
  expect(r.problems).toEqual([]);
  expect(Object.keys(r.view?.stages ?? {})).toEqual(['make', 'land']);
});

describe('a key the schema does not know is dropped, and the rest reads', () => {
  test("an older file's hand-placed `map`", () => {
    const r = read(f => void (f.map = { cards: [{ id: 'make', stages: ['make'] }] }));
    expect(listed(r)).toEqual(['unknown map']);
    expect(r.view).not.toBeNull();
    expect(r.view && 'map' in r.view).toBe(false);
  });

  test('a misspelt key inside a stage keeps the stage', () => {
    const r = read(f => {
      (f.stages as Record<string, Record<string, unknown>>).make!.lable = 'Typo';
    });
    expect(listed(r)).toEqual(['unknown stages.make.lable']);
    expect(r.view?.stages.make).toEqual({ label: 'Make', blurb: 'Makes it.' });
  });
});

describe('an entry that fails its schema drops alone', () => {
  test('an over-long label drops only its stage', () => {
    const r = read(f => {
      (f.stages as Record<string, Record<string, unknown>>).make!.label = 'x'.repeat(81);
    });
    expect(listed(r)).toEqual(['invalid stages.make.label']);
    expect(Object.keys(r.view?.stages ?? {})).toEqual(['land']);
  });

  test('a bad outcome key drops only that outcome', () => {
    const r = read(f => void (f.outcomes = { 'make:done': { label: 'made' }, nocolon: {} }));
    expect(listed(r)).toEqual(['invalid outcomes.nocolon']);
    expect(Object.keys(r.view?.outcomes ?? {})).toEqual(['make:done']);
  });

  test('a list entry drops alone, and one of a one-or-list source keeps its form', () => {
    const r = read(f => {
      f.rounds = [
        { workflow: 'make', round: '/round', allowance: '/allowance' },
        { workflow: 'x' },
      ];
    });
    expect(listed(r)).toEqual(['invalid rounds.1']);
    expect(r.view?.rounds).toEqual([
      { workflow: 'make', round: '/round', allowance: '/allowance' },
    ]);
    expect(read(() => undefined).view?.rounds).toEqual({
      workflow: 'make',
      round: '/round',
      allowance: '/allowance',
    });
  });

  test("an older file's groups are an unknown key: the pack's document declares them, and the file still draws", () => {
    const r = read(
      f => void (f.groups = [{ name: 'Build', blurb: 'x', stages: ['make', 'land'] }])
    );
    expect(listed(r)).toEqual(['unknown groups']);
    expect(r.view).not.toBeNull();
    expect(r.view && 'groups' in r.view).toBe(false);
    expect(Object.keys(r.view?.stages ?? {})).toEqual(['make', 'land']);
  });
});

describe('a file whose envelope does not read has no view', () => {
  test.each<[string, (f: Record<string, unknown>) => void]>([
    ['a wrong version', f => void (f.version = 2)],
    ['no title', f => void delete f.title],
    ['stages that are not an object', f => void (f.stages = [])],
    ['no How it works', f => void delete f.howItWorks],
  ])('%s', (_name, edit) => {
    const r = read(edit);
    expect(r.view).toBeNull();
    expect(r.problems.map(problem => problem.kind)).toEqual(['unreadable']);
  });
});
