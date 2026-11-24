import { describe, expect, test } from 'bun:test';
import { layoutMap, mapCards, PILL_MAX_LINES, type Box, type MapLayout } from './map-layout';
import { shippedView } from '../item-detail.test-fixtures';
import {
  boxesMeet,
  crosses,
  enters,
  pointSegments,
  segments,
  type Segment,
} from './map-geometry.test-fixtures';
import { CARD_H, CARD_W, GAP_MIN, LANE, PILL_LINE } from './map-sizes';
import { PILL_H } from './overview-layout';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
type MapBlock = Declaration['map'];
type Columns = NonNullable<Declaration['columns']>;

/**
 * The shipped declaration with `stages` in this order, each given a card, `columns` as given
 * (none by default: one card per stage), and `map`'s arrows.
 */
function declaration(
  stages: readonly string[],
  map: Partial<MapBlock> = {},
  columns: Columns | undefined = undefined
): Declaration {
  return {
    ...shippedView,
    stages: stages.map(id => ({ id, label: id, blurb: id, group: 'build', workflows: [id] })),
    columns,
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

const arrowBetween = (layout: MapLayout, from: string, to: string) =>
  layout.arrows.find(arrow => arrow.from === from && arrow.to === to);

describe('the shipped map', () => {
  const layout = layoutMap(shippedView);

  test("five cards, the board's columns in order, each holding its stages", () => {
    expect(layout.cards.map(card => [card.label, card.stages])).toEqual([
      ['Intake', ['order', 'triage']],
      ['Plan & build', ['plan', 'build']],
      ['Checks & review', ['checks', 'host']],
      ['Ready to merge', ['ready']],
      ['Merged', ['landed']],
    ]);
    expect(layout.cards.map(card => card.tone)).toEqual([
      'intake',
      'build',
      'check',
      'land',
      'merged',
    ]);
  });

  test('cards are the standard size and sit one row, left to right', () => {
    let right = Number.NEGATIVE_INFINITY;
    for (const { box } of layout.cards) {
      expect(box).toMatchObject({ y: 0, w: CARD_W, h: CARD_H });
      expect(box.w).toBeGreaterThanOrEqual(176);
      expect(box.h).toBeLessThanOrEqual(box.w);
      expect(box.x - right).toBeGreaterThanOrEqual(
        right === Number.NEGATIVE_INFINITY ? 0 : GAP_MIN
      );
      right = box.x + box.w;
    }
  });

  test('every shipped short line fits one row of a card of several stages', () => {
    // A row's text is the card's width inside its 12 px padding; 6.5 px is a generous mean
    // character width at 12 px Geist (the browser shows 27 characters in 158 px).
    const row = CARD_W - 24;
    for (const stage of shippedView.stages)
      expect((stage.short?.length ?? 0) * 6.5).toBeLessThanOrEqual(row);
  });

  test('a forward hand-off only between neighbours, straight, its pill above the line', () => {
    expect(
      layout.arrows.map(arrow => [arrow.from, arrow.to, arrow.lines.join(' '), arrow.outcomes])
    ).toEqual([
      ['intake', 'plan-build', 'build, narrow', ['build', 'narrow']],
      // Build to CI and review ("fixed for CI") skips Checks, but not a card: Plan & build and
      // Checks & review are neighbours, so it joins the one pill between them.
      // Build to Ready to merge (a drop or reshape answer starts close) skips a card, so it is
      // worded on this pill with its target. Three outcomes are past the two lines a pill holds.
      [
        'plan-build',
        'checks-review',
        'built +2',
        ['built', 'fixed for CI', 'drop or reshape → Ready to merge'],
      ],
      ['checks-review', 'ready', 'ready, drop or reshape', ['ready', 'drop or reshape']],
      ['ready', 'merged', 'merged', ['merged']],
    ]);
    for (const arrow of layout.arrows) {
      const [s] = segments(arrow.d);
      expect(segments(arrow.d)).toHaveLength(1);
      expect(s?.y1).toBe(CARD_H / 2);
      expect(s?.y2).toBe(CARD_H / 2);
      const pill = arrow.pill as Box;
      expect(pill.y + pill.h).toBeLessThan(CARD_H / 2);
    }
  });

  test('one lane under the row: one pill per target stage, the self hand-offs on it too', () => {
    expect(layout.feedback.pills.map(pill => [pill.stage, pill.text])).toEqual([
      ['order', 'pieces, broke the branch'],
      ['triage', 'split'],
      ['plan', 'replan, answers'],
      ['build', 'returned, sent back, answers'],
      ['ready', 'land, drop or reshape'],
    ]);
    const laneY = CARD_H + LANE;
    for (const path of layout.feedback.paths) {
      const s = segments(path.d);
      expect(s.map(seg => seg.y2)).toContain(laneY);
    }
  });

  test('nothing crosses a card, a line or a pill, and the bounds hold every pill', () => {
    expectClean(layout);
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
    layoutMap(declaration(['s1', 's2'], { arrows: [{ from: 's1', to: 's2', label }] })).arrows[0];

  test('up to two outcomes, one per line; past that, the first and how many more', () => {
    expect(pillFor('a')?.lines).toEqual(['a']);
    expect(pillFor('a, b')?.lines).toEqual(['a,', 'b']);
    expect(pillFor('a, b, c')?.lines).toEqual(['a +2']);
    expect(pillFor('a, b, c, d')).toMatchObject({
      lines: ['a +3'],
      outcomes: ['a', 'b', 'c', 'd'],
    });
  });

  test('no pill on the shipped map is taller than two lines', () => {
    expect(PILL_MAX_LINES).toBe(2);
    for (const arrow of layoutMap(shippedView).arrows) {
      expect(arrow.lines.length).toBeLessThanOrEqual(PILL_MAX_LINES);
      expect(arrow.pill?.h ?? 0).toBeLessThanOrEqual(PILL_H + PILL_LINE * (PILL_MAX_LINES - 1));
    }
  });
});

describe('the rules for arrows between card groups', () => {
  const layout = layoutMap(seeded);

  test('a hand-off inside a card is not drawn; one between neighbours is', () => {
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

  test('with no neighbour hand-off declared, the folded one is drawn alone', () => {
    const view = declaration(
      ['s1', 's2', 's3'],
      { arrows: [{ from: 's1', to: 's3', label: 'skip' }] },
      undefined
    );
    const only = layoutMap(view);
    expect(only.arrows.map(arrow => [arrow.from, arrow.to, arrow.lines])).toEqual([
      ['s1', 's2', ['skip → s3']],
    ]);
    expectClean(only);
  });

  test("a long send-back label into the first card's first stage stays within the row", () => {
    const view = declaration(['s1', 's2', 's3'], {
      arrows: [
        { from: 's1', to: 's2', label: 'go' },
        { from: 's3', to: 's1', label: 'pieces, broke the branch, and a long one more' },
      ],
    });
    const only = layoutMap(view);
    const [pill] = only.feedback.pills;
    expect(pill?.box.x).toBe(0);
    expect(only.bounds.x).toBe(0);
    expectClean(only);
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

  test('nothing crosses a card, a line or a pill', () => {
    expectClean(layout);
  });
});

describe('every view is one row and clean', () => {
  for (let n = 1; n <= 12; n++) {
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
      const layout = layoutMap(declaration(stages, { arrows }));
      expect(layout.cards).toHaveLength(n);
      expectClean(layout);
    });
    test(`${n.toString()} stages, in columns of two`, () => {
      const columns = Array.from({ length: Math.ceil(n / 2) }, (_, i) =>
        column(`c${i.toString()}`, stages.slice(2 * i, 2 * i + 2))
      );
      const layout = layoutMap(declaration(stages, { arrows }, columns));
      expect(layout.cards).toHaveLength(columns.length);
      expectClean(layout);
    });
  }
});

describe('declarations the schema allows', () => {
  test('a view with no columns draws one card per stage', () => {
    const layout = layoutMap(declaration(['p', 'q', 'r']));
    expect(layout.cards.map(card => card.stages)).toEqual([['p'], ['q'], ['r']]);
  });

  test('no cards: no boxes, no arrows, empty bounds', () => {
    const layout = layoutMap({ ...seeded, map: { cards: [], arrows: seeded.map.arrows } });
    expect(layout.cards).toEqual([]);
    expect(layout.arrows).toEqual([]);
    expect(layout.feedback.paths).toEqual([]);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  test('a stage with no card leaves its column, and a column with none is not drawn', () => {
    const view = {
      ...seeded,
      map: { ...seeded.map, cards: seeded.map.cards.filter(c => !['s1', 's6'].includes(c.stage)) },
    };
    expect(mapCards(view).map(card => [card.id, card.stages])).toEqual([
      ['a', ['s2']],
      ['b', ['s3']],
      ['c', ['s4', 's5']],
      ['e', ['s7']],
    ]);
    const layout = layoutMap(view);
    expect(layout.feedback.paths.some(path => path.to === 's1')).toBe(false);
    expectClean(layout);
  });

  test('a card of three stages grows taller, and wider to stay wider than tall', () => {
    const view = declaration(['p', 'q', 'r', 's'], {}, [
      column('x', ['p', 'q', 'r']),
      column('y', ['s']),
    ]);
    const [first] = layoutMap(view).cards;
    expect(first?.box.h).toBeGreaterThan(CARD_H);
    expect(first?.box.w).toBeGreaterThanOrEqual(first?.box.h ?? 0);
  });
});
