import { describe, expect, test } from 'bun:test';
import { layoutMap, type Box, type MapLayout } from './map-layout';
import { shippedArrows, shippedView } from '../curated.test-fixtures';
import {
  boxesMeet,
  crosses,
  enters,
  pointSegments,
  segments,
  type Segment,
} from './map-geometry.test-fixtures';
import type { CuratedView } from './curated-view';

type Declaration = CuratedView;
type MapBlock = Declaration['map'];
type Columns = Declaration['columns'];

/**
 * The shipped view with `stages` in this order, each given a card, `columns` as given (by
 * default one card per stage), and `map`'s arrows.
 */
function declaration(
  stages: readonly string[],
  map: Partial<MapBlock> = {},
  columns: Columns | undefined = undefined
): Declaration {
  return {
    ...shippedView,
    stages: stages.map(id => ({ id, label: id, blurb: id, workflows: [id] })),
    columns: columns ?? stages.map(id => ({ id, label: id, blurb: id, stages: [id] })),
    landed: { stage: stages.at(-1) ?? '' },
    map: { cards: stages.map(stage => ({ stage })), arrows: [], ...map },
  };
}

const column = (id: string, stages: string[]): Columns[number] => ({
  id,
  label: id.toUpperCase(),
  blurb: id,
  stages,
});

/**
 * Seven stages in five columns, with every kind of arrow the rules sort: hand-offs inside a
 * card (not drawn), between neighbours, one skipping a card, send-backs from several cards
 * into two stages of one card, and one inside a card into its own stage.
 */
const seeded = declaration(
  ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
  {
    arrows: [
      { from: 's1', to: 's2', label: 'ready' },
      { from: 's2', to: 's3', label: 'go' },
      { from: 's3', to: 's4', label: 'built' },
      { from: 's3', to: 's6', label: 'fast' },
      { from: 's4', to: 's5', label: 'approved' },
      { from: 's5', to: 's6', label: 'ready' },
      { from: 's6', to: 's7', label: 'merged' },
      { from: 's4', to: 's3', label: 'returned' },
      { from: 's5', to: 's3', label: 'returned' },
      { from: 's5', to: 's1', label: 'redo' },
      { from: 's4', to: 's2', label: 'rework' },
      { from: 's2', to: 's2', label: 'answers' },
    ],
  },
  [
    column('a', ['s1', 's2']),
    column('b', ['s3']),
    column('c', ['s4', 's5']),
    column('d', ['s6']),
    column('e', ['s7']),
  ]
);

/** Every line the layout draws: forward lines, each send-back's route, and the lane's strokes. */
function lines(layout: MapLayout): Segment[] {
  return [
    ...layout.arrows.flatMap(arrow => segments(arrow.d)),
    ...layout.feedback.paths.flatMap(path => segments(path.d)),
    ...layout.feedback.strokes.flatMap(stroke => pointSegments(stroke.points)),
  ];
}

const pills = (layout: MapLayout): Box[] => [
  ...layout.arrows.flatMap(arrow => (arrow.pill === undefined ? [] : [arrow.pill])),
  ...layout.feedback.pills.map(pill => pill.box),
];

/** The done-when of the map's geometry: one row, and nothing crossing a card, a line or a pill. */
function expectClean(layout: MapLayout): void {
  const boxes = layout.cards.map(card => card.box);
  for (const box of boxes) expect(box.y).toBe(0);
  const all = lines(layout);
  for (const s of all) for (const box of boxes) expect(enters(box, s)).toBe(false);
  for (const p of all) for (const q of all) expect(crosses(p, q)).toBe(false);
  const placed = pills(layout);
  placed.forEach((pill, i) => {
    for (const box of boxes) expect(boxesMeet(pill, box)).toBe(false);
    for (const s of all) expect(enters(pill, s)).toBe(false);
    placed.forEach((other, j) => {
      if (i !== j) expect(boxesMeet(pill, other)).toBe(false);
    });
  });
  const { bounds } = layout;
  for (const box of [...boxes, ...placed]) {
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    expect(box.y + box.h).toBeLessThanOrEqual(bounds.y + bounds.h);
  }
}

/** The layout of a test declaration, its `map.arrows` standing for the arrows the graph draws. */
const lay = (view: Declaration): MapLayout => layoutMap(view, view.map.arrows);

const arrowBetween = (layout: MapLayout, from: string, to: string) =>
  layout.arrows.find(arrow => arrow.from === from && arrow.to === to);

describe('the shipped map', () => {
  const layout = layoutMap(shippedView, shippedArrows);

  test("five cards, the pack's groups in order, each holding its stages", () => {
    expect(layout.cards.map(card => [card.label, card.stages])).toEqual([
      ['Intake', ['order', 'triage', 'link']],
      ['Plan and build', ['plan', 'build']],
      ['Checks', ['checks', 'host']],
      ['Ready to merge', ['ready']],
      ['Merged', ['landed']],
    ]);
  });

  test('nothing crosses a card, a line or a pill, and the bounds hold every pill', () => {
    expectClean(layout);
  });

  test('a forward hand-off only between neighbours, straight, its pill above the line', () => {
    expect(
      layout.arrows.map(arrow => [arrow.from, arrow.to, arrow.lines.join(' '), arrow.outcomes])
    ).toEqual([
      ['intake', 'plan-and-build', 'placed, kept whole', ['placed', 'kept whole']],
      // Build to CI and review ("fixed for CI") skips Checks, but not a card: Plan & build and
      // Checks & review are neighbours, so it joins the one pill between them.
      // Build to Ready to merge (a drop or reshape answer starts close) skips a card, so it is
      // worded on this pill with its target. Three outcomes are past the two lines a pill holds.
      [
        'plan-and-build',
        'checks',
        'built +2',
        ['built', 'fixed for CI', 'drop or reshape → Ready to merge'],
      ],
      ['checks', 'ready', 'ready, drop or reshape', ['ready', 'drop or reshape']],
      ['ready', 'landed', 'merged', ['merged']],
    ]);
    for (const arrow of layout.arrows) {
      const [s] = segments(arrow.d);
      expect(segments(arrow.d)).toHaveLength(1);
      expect(s?.y1).toBe(s?.y2);
      expect((arrow.pill as Box).y + (arrow.pill as Box).h).toBeLessThan(s?.y1 ?? 0);
    }
  });

  test('one lane under the row: one pill per target stage, the self hand-offs on it too', () => {
    expect(layout.feedback.pills.map(pill => [pill.stage, pill.text])).toEqual([
      ['order', 'pieces, broke the branch'],
      ['triage', 'split'],
      ['link', 'answers'],
      ['plan', 'replan, answers'],
      ['build', 'returned, sent back, answers'],
      ['ready', 'land, drop or reshape'],
    ]);
    const bottom = Math.max(...layout.cards.map(card => card.box.y + card.box.h));
    for (const path of layout.feedback.paths)
      expect(Math.max(...segments(path.d).map(seg => seg.y2))).toBeGreaterThan(bottom);
  });

  test("every lane pill is within the row's span: the map opens at the first card", () => {
    const first = layout.cards[0]?.box as Box;
    const last = layout.cards.at(-1)?.box as Box;
    for (const pill of layout.feedback.pills) {
      expect(pill.box.x).toBeGreaterThanOrEqual(first.x);
      expect(pill.box.x + pill.box.w).toBeLessThanOrEqual(last.x + last.w);
    }
    expect(layout.bounds.x).toBe(first.x);
  });
});

describe('a forward pill holds at most two lines', () => {
  /** The one pill between s1 and s2 when their hand-off reads `label`. */
  const pillFor = (label: string): MapLayout['arrows'][number] | undefined =>
    lay(declaration(['s1', 's2'], { arrows: [{ from: 's1', to: 's2', label }] })).arrows[0];

  test('up to two outcomes, one per line; past that, the first and how many more', () => {
    expect(pillFor('a')?.lines).toEqual(['a']);
    expect(pillFor('a, b')?.lines).toEqual(['a,', 'b']);
    expect(pillFor('a, b, c')?.lines).toEqual(['a +2']);
    expect(pillFor('a, b, c, d')).toMatchObject({
      lines: ['a +3'],
      outcomes: ['a', 'b', 'c', 'd'],
    });
  });
});

describe('the rules for arrows between card groups', () => {
  const layout = lay(seeded);

  test('a hand-off inside a card is not drawn; one between neighbours is; nothing crosses', () => {
    expectClean(layout);
    expect(layout.arrows.map(arrow => [arrow.from, arrow.to])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
    ]);
  });

  test("a hand-off that skips cards folds into the next neighbour's label", () => {
    expect(arrowBetween(layout, 'b', 'c')?.lines).toEqual(['built,', 'fast → D']);
    expect(layout.arrows.some(arrow => arrow.from === 'b' && arrow.to === 'd')).toBe(false);
  });

  test('send-backs go by card order; one inside a card into its own stage too', () => {
    expect(layout.feedback.paths.map(path => [path.from, path.to])).toEqual([
      ['c', 's3'],
      ['c', 's3'],
      ['c', 's1'],
      ['c', 's2'],
      ['a', 's2'],
    ]);
  });
});

describe('every view is one row and clean', () => {
  // A few representative sizes: one card, a common factory, and a long one.
  for (const n of [1, 5, 12]) {
    const stages = Array.from({ length: n }, (_, i) => `s${(i + 1).toString()}`);
    const arrows = [
      ...stages
        .slice(1)
        .map((to, i) => ({ from: stages[i] ?? '', to, label: `next ${i.toString()}` })),
      ...stages
        .slice(2)
        .map((from, i) => ({ from, to: stages[i] ?? '', label: `back ${i.toString()}` })),
      ...stages.slice(3).map((to, i) => ({ from: stages[i] ?? '', to, label: 'skip' })),
      { from: stages.at(-1) ?? '', to: stages.at(-1) ?? '', label: 'again' },
    ];
    test(`${n.toString()} stages, one card each`, () => {
      const layout = lay(declaration(stages, { arrows }));
      expect(layout.cards).toHaveLength(n);
      expectClean(layout);
    });
    test(`${n.toString()} stages, in columns of two`, () => {
      const columns = Array.from({ length: Math.ceil(n / 2) }, (_, i) =>
        column(`c${i.toString()}`, stages.slice(2 * i, 2 * i + 2))
      );
      const layout = lay(declaration(stages, { arrows }, columns));
      expect(layout.cards).toHaveLength(columns.length);
      expectClean(layout);
    });
  }
});
