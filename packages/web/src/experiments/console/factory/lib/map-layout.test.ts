import { describe, expect, test } from 'bun:test';
import { layoutMap, type Box, type MapLayout } from './map-layout';
import type { SendBackRoute } from './map-send-backs';
import { testArrows, testView } from '../curated.test-fixtures';
import {
  boxesMeet,
  crosses,
  enters,
  overlaps,
  segments,
  type Segment,
} from './map-geometry.test-fixtures';
import type { CuratedView } from './curated-view';
import type { MapArrow } from './graph-structure';

type Declaration = CuratedView;
type Columns = Declaration['columns'];
/** A test view with the arrows the graph would draw for it. */
type Seeded = Declaration & { arrows: MapArrow[] };

/**
 * The test view with `stages` in this order, `columns` as given (by default one card per
 * stage), and the arrows standing for the graph's.
 */
function declaration(
  stages: readonly string[],
  { arrows = [] }: { arrows?: MapArrow[] } = {},
  columns: Columns | undefined = undefined
): Seeded {
  return {
    ...testView,
    stages: stages.map(id => ({ id, label: id, blurb: id, workflows: [id] })),
    columns: columns ?? stages.map(id => ({ id, label: id, blurb: id, stages: [id] })),
    landed: { stage: stages.at(-1) ?? '' },
    arrows,
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

/** Every send-back route on the map: the map draws them all, always. */
const allRoutes = (layout: MapLayout): SendBackRoute[] =>
  [...layout.sendBacks.values()].flatMap(card => card.routes);

const routesOf = (layout: MapLayout, card: string) => layout.sendBacks.get(card)?.routes ?? [];

/** Every line the map draws: the forward lines and every send-back route, each with its route. */
function lines(layout: MapLayout): { s: Segment; route?: SendBackRoute }[] {
  return [
    ...layout.arrows.flatMap(arrow => segments(arrow.d).map(s => ({ s }))),
    ...allRoutes(layout).flatMap(route => segments(route.d).map(s => ({ s, route }))),
  ];
}

/**
 * Whether two send-backs interleave: each leaves from inside the other's stretch of the row,
 * neither spanning the other (say 3 to 1 and 4 to 2). Drawn as U shapes under the row, those
 * two cannot help crossing; any other two never do.
 */
function interleave(p: SendBackRoute | undefined, q: SendBackRoute | undefined): boolean {
  if (p === undefined || q === undefined || p === q) return false;
  const span = (r: SendBackRoute): [number, number] => [
    r.points.at(-1)?.x ?? 0,
    r.points[0]?.x ?? 0,
  ];
  const [[a, b], [c, d]] = [span(p), span(q)];
  return (a < c && c < b && b < d) || (c < a && a < d && d < b);
}

/** Every pill the map draws: the forward pills and every send-back's. */
const pills = (layout: MapLayout): Box[] => [
  ...layout.arrows.flatMap(arrow => (arrow.pill === undefined ? [] : [arrow.pill])),
  ...allRoutes(layout).flatMap(route => (route.pill === undefined ? [] : [route.pill.box])),
];

/**
 * The done-when of the map's geometry: one row, and nothing crossing a card, a line or a pill,
 * with every send-back drawn at once, as the map draws them.
 */
function expectClean(layout: MapLayout): void {
  for (const box of layout.cards.map(card => card.box)) expect(box.y).toBe(0);
  expectCleanDrawn(layout);
  expectSendBacksUnderRow(layout);
}

/** Nothing crosses or meets anything else, every send-back drawn. */
function expectCleanDrawn(layout: MapLayout): void {
  const boxes = layout.cards.map(card => card.box);
  const drawn = lines(layout);
  const all = drawn.map(line => line.s);
  for (const s of all) for (const box of boxes) expect(enters(box, s)).toBe(false);
  drawn.forEach((p, i) =>
    drawn.forEach((q, j) => {
      if (!interleave(p.route, q.route)) expect(crosses(p.s, q.s)).toBe(false);
      // No two lines drawn on top of each other: each send-back on its own line.
      if (i !== j) expect(overlaps(p.s, q.s)).toBe(false);
    })
  );
  const legs = allRoutes(layout).flatMap(route => [route.points[0]?.x, route.points.at(-1)?.x]);
  expect(new Set(legs).size).toBe(legs.length);
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
  }
}

/**
 * The bounds hug the cards and forward pills; every send-back lies under them, within the
 * row's span, in `sendBackExtent`, where the frame grows to hold them, each pill near its own
 * leg (the owner's ruling on #289), not slid along the row.
 */
function expectSendBacksUnderRow(layout: MapLayout): void {
  const bottom = Math.max(...layout.cards.map(card => card.box.y + card.box.h));
  const pillsAbove = layout.arrows.flatMap(arrow => (arrow.pill === undefined ? [] : [arrow.pill]));
  expect(layout.bounds.y + layout.bounds.h).toBe(
    Math.max(bottom, ...pillsAbove.map(pill => pill.y + pill.h))
  );
  for (const route of allRoutes(layout)) expect(legGap(route)).toBeLessThanOrEqual(120);
  const extent = layout.sendBackExtent;
  if (extent === undefined) {
    expect(layout.sendBacks.size).toBe(0);
    return;
  }
  for (const { extent: mine } of layout.sendBacks.values()) {
    expect(mine.y).toBeGreaterThanOrEqual(extent.y);
    expect(mine.y + mine.h).toBeLessThanOrEqual(extent.y + extent.h);
  }
  expect(extent.y).toBeGreaterThanOrEqual(bottom);
  expect(extent.x).toBeGreaterThanOrEqual(layout.bounds.x);
  expect(extent.x + extent.w).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.w);
}

/** How far a route's pill sits from its target leg, sideways; 0 for no pill or one over it. */
function legGap(route: SendBackRoute): number {
  const pill = route.pill?.box;
  const leg = route.points.at(-1)?.x ?? Number.NaN;
  return pill === undefined ? 0 : Math.max(0, pill.x - leg, leg - (pill.x + pill.w));
}

/** The layout of a test declaration, its `arrows` standing for the arrows the graph draws. */
const lay = (view: Seeded): MapLayout => layoutMap(view, view.arrows);

const arrowBetween = (layout: MapLayout, from: string, to: string) =>
  layout.arrows.find(arrow => arrow.from === from && arrow.to === to);

describe('a pack map', () => {
  const layout = layoutMap(testView, testArrows);

  test('nothing crosses a card, a line or a pill, and the bounds hold every pill', () => {
    // Something to cross: forward pills, send-back routes and their pills are all laid out.
    expect(layout.arrows.length).toBeGreaterThan(0);
    expect(layout.sendBacks.size).toBeGreaterThan(0);
    expectClean(layout);
  });

  test('a forward hand-off only between neighbours, straight, its pill above the line', () => {
    expect(
      layout.arrows.map(arrow => [arrow.from, arrow.to, arrow.lines.join(' '), arrow.outcomes])
    ).toEqual([
      // Triage's drop and reshape answers go to close, in Landing, which skips cards, so they
      // are worded on this pill with their target.
      [
        'intake',
        'plan-and-build',
        'placed +3',
        ['placed', 'dropped by you → Landing', 'needs shaping → Landing', 'kept whole'],
      ],
      // Build to Checks and to CI and review joins one pill; its drop and reshape skip a card.
      [
        'plan-and-build',
        'checks',
        'built +3',
        ['built', 'fixed for CI', 'dropped by you → Landing', 'needs shaping → Landing'],
      ],
      // Checks and CI and review both send a drop answer to close: it is listed once.
      ['checks', 'landing', 'ready, dropped by you', ['ready', 'dropped by you']],
      ['landing', 'landed', 'merged', ['merged']],
    ]);
    for (const arrow of layout.arrows) {
      const [s] = segments(arrow.d);
      expect(segments(arrow.d)).toHaveLength(1);
      expect(s?.y1).toBe(s?.y2);
      expect((arrow.pill as Box).y + (arrow.pill as Box).h).toBeLessThan(s?.y1 ?? 0);
    }
  });

  test('the send-backs are one route per pair of cards, into an earlier card, under the row', () => {
    const pairs = [...layout.sendBacks].flatMap(([card, { routes }]) =>
      routes.map(route => `${card}:${route.from}>${route.to}`)
    );
    expect(pairs).toEqual([...new Set(pairs)]);
    // Checks' two stages both send back into Plan and build: one route, its words merged.
    // Inside a card (Intake's own retries, Plan and build's build back to plan) nothing is drawn.
    expect(routesOf(layout, 'checks').map(route => route.to)).toEqual(['plan-and-build']);
    expect(layout.sendBacks.has('intake')).toBe(false);
    expect(layout.sendBacks.has('plan-and-build')).toBe(false);
    for (const { routes } of layout.sendBacks.values())
      for (const route of routes) {
        expect(route.to).not.toBe(route.from);
        expect(route.pill?.lines[0]).toMatch(/^Back to /);
      }
    const bottom = Math.max(...layout.cards.map(card => card.box.y + card.box.h));
    for (const { routes } of layout.sendBacks.values())
      for (const route of routes)
        expect(Math.max(...segments(route.d).map(seg => seg.y2))).toBeGreaterThan(bottom);
  });

  test('two routes into one card end on their own legs and run on their own tracks, nested', () => {
    const into = allRoutes(layout)
      .filter(route => route.to === 'plan-and-build')
      .sort((p, q) => (p.points.at(-1)?.x ?? 0) - (q.points.at(-1)?.x ?? 0));
    expect(into.map(route => route.from).sort()).toEqual(['checks', 'landing']);
    const [left, right] = into;
    const track = (route: SendBackRoute): number => route.points[1]?.y ?? 0;
    const leg = (route: SendBackRoute): number => route.points.at(-1)?.x ?? 0;
    // Sorted by target leg: the route from the further card ends leftmost and runs deeper.
    expect(left?.from).toBe('landing');
    expect(leg(left as SendBackRoute)).toBeLessThan(leg(right as SendBackRoute));
    expect(track(left as SendBackRoute)).toBeGreaterThan(track(right as SendBackRoute));
    const tracks = allRoutes(layout).map(track);
    expect(new Set(tracks).size).toBe(tracks.length);
    // The pack's routes all nest: no two interleave, so `expectClean` lets none cross.
    const every = allRoutes(layout);
    for (const p of every) for (const q of every) expect(interleave(p, q)).toBe(false);
  });

  test("every send-back pill is within the row's span: the map opens at the first card", () => {
    const first = layout.cards[0]?.box as Box;
    const last = layout.cards.at(-1)?.box as Box;
    for (const { routes } of layout.sendBacks.values())
      for (const route of routes) {
        const pill = route.pill?.box;
        if (pill === undefined) continue;
        expect(pill.x).toBeGreaterThanOrEqual(first.x);
        expect(pill.x + pill.w).toBeLessThanOrEqual(last.x + last.w);
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

  test('send-backs go by card order, one route per pair of cards; none inside a card', () => {
    // s4 and s5, both on card c, return to s3 (card b) and to s1 and s2 (card a): two routes,
    // their words merged, each once. Sorted by target leg, left to right. s2 into itself, inside
    // card a, is a retry: not drawn, so card a has no send-backs.
    const routes = layout.sendBacks.get('c')?.routes ?? [];
    expect(routes.map(route => [route.from, route.to, route.words])).toEqual([
      ['c', 'a', ['redo', 'rework']],
      ['c', 'b', ['returned']],
    ]);
    expect(routes.map(route => route.pill?.lines)).toEqual([
      ['Back to A:', 'redo, rework'],
      ['Back to B:', 'C sent it back'],
    ]);
    expect([...layout.sendBacks.keys()]).toEqual(['c']);
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
