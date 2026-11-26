import { describe, expect, test } from 'bun:test';
import { readFactoryView } from './factory-view-read';

/** A file that reads whole: a summary and a How it works root. */
function file(): Record<string, unknown> {
  return {
    version: 1,
    summary: 'Work comes in, gets built, lands.',
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
  expect(r.view?.summary).toBe('Work comes in, gets built, lands.');
});

describe('a key the schema does not know is dropped, and the rest reads', () => {
  test("an older file's words and declarations: the pack's workflows carry them now", () => {
    const r = read(f => {
      f.title = 'Factory';
      f.stages = { make: { label: 'Make', blurb: 'Makes it.' } };
      f.rounds = { workflow: 'make', round: '/round', allowance: '/allowance' };
    });
    expect(listed(r)).toEqual(['unknown title', 'unknown stages', 'unknown rounds']);
    expect(r.view).not.toBeNull();
    expect(Object.keys(r.view ?? {})).toEqual(['version', 'summary', 'howItWorks']);
  });

  test("each old key's message says where it moved or that it was removed; an invented key is just unknown", () => {
    const old = [
      'title',
      'stages',
      'outcomes',
      'answers',
      'words',
      'retired',
      'rounds',
      'returns',
      'approves',
      'change',
      'merged',
    ];
    const r = read(f => {
      for (const key of old) f[key] = {};
      f.colour = 'blue';
    });
    const said = Object.fromEntries(r.problems.map(p => [String(p.path[0]), p.message]));
    // Every top-level key the shipped pre-#277 file had has a stated fate.
    for (const key of old) expect(said[key]).toMatch(/any more: (moved|removed): /);
    expect(said.title).toContain('removed: nothing reads it; delete it');
    expect(said.title).not.toContain('display:');
    expect(said.stages).toContain("its workflow's display: block");
    expect(said.words).toContain("the pack document's front matter (`words`)");
    expect(said.merged).toContain("the pack document's front matter (`exit`)");
    expect(said.colour).toBe('is not a key a view file has');
  });

  test('a misspelt key inside the picture keeps the picture', () => {
    const r = read(f => {
      (f.howItWorks as Record<string, unknown>).captoin = 'Typo';
    });
    expect(listed(r)).toEqual(['unknown howItWorks.captoin']);
    expect(r.view?.howItWorks.caption).toBe('x');
  });
});

describe('a file whose envelope does not read has no view', () => {
  test.each<[string, (f: Record<string, unknown>) => void]>([
    ['a wrong version', f => void (f.version = 2)],
    ['no summary', f => void delete f.summary],
    ['no How it works', f => void delete f.howItWorks],
  ])('%s', (_name, edit) => {
    const r = read(edit);
    expect(r.view).toBeNull();
    expect(r.problems.map(problem => problem.kind)).toEqual(['unreadable']);
  });
});
