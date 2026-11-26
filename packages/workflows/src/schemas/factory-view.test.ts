import { describe, expect, test } from 'bun:test';
import { type FactoryView, factoryViewSchema } from './factory-view';

type Picture = FactoryView['howItWorks']['views'][string];
type Card = Picture['cards'][number];

const card = (id: string, col: number, row: number, extra: Partial<Card> = {}): Card => ({
  id,
  title: id,
  text: `The ${id} card.`,
  icon: 'hammer',
  kind: 'stage',
  col,
  row,
  ...extra,
});

/** A summary, and a How it works root of three cards with one drill-down. */
function valid(): FactoryView {
  return {
    version: 1,
    summary: 'Work comes in, gets built, lands.',
    howItWorks: {
      title: 'How it works',
      caption: 'Work comes in, gets built, lands.',
      root: 'top',
      views: {
        top: {
          cards: [card('in', 1, 1), card('make-it', 2, 1, { opens: 'inner' }), card('check', 3, 1)],
          edges: [
            { from: 'in', to: 'make-it', kind: 'feeds' },
            { from: 'make-it', to: 'check', kind: 'feeds' },
            { from: 'check', to: 'make-it', kind: 'loops-back', label: 'back' },
          ],
        },
        inner: {
          cards: [card('write', 1, 1), card('test', 2, 1)],
          edges: [{ from: 'write', to: 'test', kind: 'feeds' }],
        },
      },
    },
  };
}

/** Each issue `view` is refused for, as its path and the names quoted in its message. */
function issues(view: unknown): string[] {
  const parsed = factoryViewSchema.safeParse(view);
  return (parsed.error?.issues ?? []).map(issue => {
    const named = [...issue.message.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    return [issue.path.join('.'), ...named].join(' ');
  });
}

function edited(edit: (view: FactoryView) => unknown): unknown {
  const view = valid();
  return edit(view) ?? view;
}

const top = (v: FactoryView): Picture => v.howItWorks.views.top as Picture;

test('accepts the valid view', () => {
  expect(issues(valid())).toEqual([]);
});

describe('factoryViewSchema rejects', () => {
  test.each<[string, (v: FactoryView) => unknown]>([
    ['placement, which the server computes', v => ({ ...v, placement: { 'make:done': 'make' } })],
    ['verdicts, which the web words from outcomes', v => ({ ...v, verdicts: {} })],
    ['a hand-placed map, which the graph lays out', v => ({ ...v, map: { cards: [] } })],
    [
      "stage words, which the pack's workflows carry in display:",
      v => ({ ...v, stages: { make: { label: 'Make' } } }),
    ],
    ["progress declarations, which the pack's workflows carry", v => ({ ...v, rounds: [] })],
  ])('a removed field: %s', (_name, edit) => {
    expect(
      factoryViewSchema.safeParse(edited(edit)).error?.issues.map(issue => issue.code)
    ).toEqual(['unrecognized_keys']);
  });

  // One row per rule: what is refused, the change to `valid()`, and its issues. A row marked
  // `some` checks only that its issue is among them: a broken layout often breaks more than one.
  test.each<[string, (v: FactoryView) => unknown, string[], 'some'?]>([
    [
      'a How it works root naming no view',
      v => ({ ...v, howItWorks: { ...v.howItWorks, root: 'nope' } }),
      ['howItWorks.root nope'],
    ],
    [
      'a How it works root without a loops-back edge',
      v => void top(v).edges.pop(),
      ['howItWorks.views.top.edges'],
    ],
    [
      'an edge that runs through a card',
      v => void top(v).edges.push({ from: 'in', to: 'check', kind: 'calls' }),
      ['howItWorks.views.top.edges.3 make-it'],
      'some',
    ],
  ])('%s', (...[_name, edit, expected, some]) => {
    const found = issues(edited(edit));
    if (some === undefined) expect(found).toEqual(expected);
    else expect(found).toEqual(expect.arrayContaining(expected));
  });
});
