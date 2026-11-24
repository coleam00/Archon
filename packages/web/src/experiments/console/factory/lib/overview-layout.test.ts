import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Box } from './map-layout';
import { fitCamera, fittedHeight, type Frame } from './map-camera';
import {
  layoutOverview,
  OVERVIEW_CARD_H,
  OVERVIEW_CARD_W,
  OVERVIEW_FIT_PAD,
  OVERVIEW_FULL_FIT_PAD,
  OVERVIEW_FULL_LEGEND_H,
  OVERVIEW_GROUP_PAD,
  OVERVIEW_MAX_K,
  OVERVIEW_MIN_K,
  OVERVIEW_PAGE_MAX_H,
  OVERVIEW_REPLY_OFFSET,
  OVERVIEW_SMALLEST_PX,
  OVERVIEW_TITLE_PX,
  OVERVIEW_TYPE_FLOOR_PX,
  type OverviewEdgePath,
  parallelGroups,
} from './overview-layout';
import { drawingFaults, fanFaults } from './overview-layout.test-fixtures';
import type { OverviewDeclaration, OverviewView } from './overview-nav';

/** The overview this repository ships, as the server lists it. */
const shipped = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../../../../../.archon/packs/Wirasm.archon-software-factory.factory-overview.json'
    ),
    'utf8'
  )
) as OverviewDeclaration;

/*
 * The map frame at 1440x900, measured in a browser on `bun run dev:console`: on the page it is
 * PAGE_WIDTH wide (the Factory section's wide body, less the views sidebar) and at most
 * OVERVIEW_PAGE_MAX_H tall; full screen it is the whole screen, of which a fit fills all but
 * the legend's band. PROJECTOR is a 1920x1080 screen full screen. Change these when the
 * frame's surroundings change.
 */
const PAGE_WIDTH = 892;
const FULL: Frame = { width: 1440, height: 900 - OVERVIEW_FULL_LEGEND_H };
const PROJECTOR: Frame = { width: 1920, height: 1080 - OVERVIEW_FULL_LEGEND_H };
const TITLE_FLOOR_PX = 14;

const views = Object.entries(shipped.views);
const root = shipped.views[shipped.root] as OverviewView;
const drillDowns = views.filter(([id]) => id !== shipped.root);

/** The scale `view` opens at in `frame`. */
function fittedK(view: OverviewView, frame: Frame, pad: number): number {
  const { bounds } = layoutOverview(view);
  return fitCamera(bounds, frame, pad, OVERVIEW_MIN_K, OVERVIEW_MAX_K).k;
}

/** Whether all of `view` is in `frame` at the scale it opens at. */
function fitsWhole(view: OverviewView, frame: Frame, pad: number): boolean {
  const { bounds } = layoutOverview(view);
  const k = fittedK(view, frame, pad);
  const roomW = frame.width - 2 * pad + 0.01;
  const roomH = frame.height - 2 * pad + 0.01;
  return bounds.w * k <= roomW && bounds.h * k <= roomH;
}

/** The page's frame for a view: as wide as measured, as tall as the fit wants up to the cap. */
function pageFrame(view: OverviewView): Frame {
  const { bounds } = layoutOverview(view);
  const height = Math.min(
    fittedHeight(bounds, PAGE_WIDTH, OVERVIEW_FIT_PAD, OVERVIEW_MIN_K, OVERVIEW_MAX_K),
    OVERVIEW_PAGE_MAX_H
  );
  return { width: PAGE_WIDTH, height };
}

const laneLines = (edges: OverviewEdgePath[]): OverviewEdgePath[] =>
  edges.filter(edge => edge.kind === 'loops-back' && edge.points.length === 4);
const edgeNamed = (edges: OverviewEdgePath[], from: string, to: string): OverviewEdgePath => {
  const edge = edges.find(e => e.from === from && e.to === to);
  if (edge === undefined) throw new Error(`no edge ${from}->${to}`);
  return edge;
};
const pillOf = (edge: OverviewEdgePath): Box => {
  if (edge.pill === undefined) throw new Error(`${edge.from}->${edge.to} has no pill`);
  return edge.pill;
};

describe('the shipped overview, drawn', () => {
  test.each(views)(
    'view %s: no line or label runs through a card, a foreign group, another line or label',
    (_, view) => {
      expect(drawingFaults(view)).toEqual([]);
    }
  );

  test('the root sends work back four ways in one lane, each labelled where it rises into its target', () => {
    const lanes = laneLines(layoutOverview(root).edges);
    expect(lanes.map(edge => `${edge.from}->${edge.to}`).sort()).toEqual([
      'build->plan',
      'checks->build',
      'ci->build',
      'ci->found',
    ]);
    for (const edge of lanes) {
      // The target's riser, and the source's: the pill sits beside the first, toward the second.
      const riser = edge.points[2]?.x ?? Number.NaN;
      const source = edge.points[1]?.x ?? Number.NaN;
      const pill = pillOf(edge);
      const near = source > riser ? pill.x - riser : riser - (pill.x + pill.w);
      expect(near).toBeGreaterThan(0);
      expect(near).toBeLessThanOrEqual(8);
    }
    expect(edgeNamed(lanes, 'ci', 'found').shadow).toBe(true);
  });

  test('an answer to an ask runs beside the ask, each pill on its own side', () => {
    const { edges } = layoutOverview(root);
    const asks = edgeNamed(edges, 'plan', 'you');
    const reply = edgeNamed(edges, 'you', 'plan');
    const x = (edge: OverviewEdgePath): number => edge.points[0]?.x ?? Number.NaN;
    expect(x(reply) - x(asks)).toBe(2 * OVERVIEW_REPLY_OFFSET);
    expect(pillOf(asks).x + pillOf(asks).w).toBeLessThan(x(asks));
    expect(pillOf(reply).x).toBeGreaterThan(x(reply));
  });

  test('the checks drill-down sends the verdict back to Build, or to Plan for a replan', () => {
    const { edges } = layoutOverview(shipped.views.checks as OverviewView);
    expect(laneLines(edges).map(edge => [edge.from, edge.to, edge.label])).toEqual([
      ['checks-verdict', 'checks-build', 'sent back to fix'],
      ['checks-verdict', 'checks-plan', 'replan'],
    ]);
  });

  test('cards are in the card language: at least 176 px wide and wider than tall', () => {
    expect(OVERVIEW_CARD_W).toBeGreaterThanOrEqual(176);
    expect(OVERVIEW_CARD_W).toBeGreaterThan(OVERVIEW_CARD_H);
  });

  test.each(views)(
    'view %s opens at a zoom that draws its smallest text at the type floor, on the page and full screen',
    (_, view) => {
      for (const k of [
        fittedK(view, pageFrame(view), OVERVIEW_FIT_PAD),
        fittedK(view, FULL, OVERVIEW_FULL_FIT_PAD),
      ]) {
        expect(k).toBeGreaterThanOrEqual(OVERVIEW_MIN_K);
        expect(OVERVIEW_SMALLEST_PX * k).toBeGreaterThanOrEqual(OVERVIEW_TYPE_FLOOR_PX);
        expect(OVERVIEW_TITLE_PX * k).toBeGreaterThanOrEqual(TITLE_FLOOR_PX);
      }
    }
  );

  test.each(drillDowns)('drill-down %s fits whole on the page and full screen', (_, view) => {
    expect(fitsWhole(view, pageFrame(view), OVERVIEW_FIT_PAD)).toBe(true);
    expect(fitsWhole(view, FULL, OVERVIEW_FULL_FIT_PAD)).toBe(true);
  });

  test('the root fits whole full screen at 1920x1080; at 1440x900 it opens at the floor and pans', () => {
    expect(fitsWhole(root, PROJECTOR, OVERVIEW_FULL_FIT_PAD)).toBe(true);
    expect(fitsWhole(root, FULL, OVERVIEW_FULL_FIT_PAD)).toBe(false);
    expect(fittedK(root, FULL, OVERVIEW_FULL_FIT_PAD)).toBe(OVERVIEW_MIN_K);
  });

  test('the root is whole in height on the page, its deepest lane in the frame', () => {
    const { bounds } = layoutOverview(root);
    expect(bounds.h + 2 * OVERVIEW_FIT_PAD).toBeLessThanOrEqual(pageFrame(root).height);
  });
});

/** A small view: a card, a group of `members` in column 2, a card after it, joined by `edges`. */
function grouped(
  members: { id: string; col: number; row: number }[],
  edges: OverviewView['edges']
): OverviewView {
  const card = (id: string, col: number, row: number, group?: string) => ({
    id,
    title: id,
    text: id,
    icon: 'flag' as const,
    kind: 'check' as const,
    col,
    row,
    ...(group === undefined ? {} : { group }),
  });
  return {
    cards: [
      card('before', 1, 2),
      ...members.map(m => card(m.id, m.col, m.row, 'g')),
      card('after', 4, 2),
    ],
    groups: [{ id: 'g', label: 'G' }],
    edges,
  } as OverviewView;
}

const THREE = [
  { id: 'a', col: 2, row: 1 },
  { id: 'b', col: 2, row: 2 },
  { id: 'c', col: 2, row: 3 },
];
const THROUGH: OverviewView['edges'] = [
  { from: 'before', to: 'g', kind: 'feeds' },
  { from: 'g', to: 'after', kind: 'feeds' },
];

describe('parallel groups', () => {
  test('the shipped file has two: the root inputs and the three checks', () => {
    const found = views.flatMap(([, view]) => [...parallelGroups(view)]);
    expect(found.sort()).toEqual(['checks-three', 'inputs']);
  });

  test('a group stacked in one column, met only along rows, is parallel', () => {
    expect([...parallelGroups(grouped(THREE, THROUGH))]).toEqual(['g']);
  });

  test('a group across two columns is not', () => {
    const wide = [
      { id: 'a', col: 2, row: 2 },
      { id: 'b', col: 3, row: 2 },
    ];
    expect(parallelGroups(grouped(wide, THROUGH)).size).toBe(0);
  });

  test('a lane line rising into a member keeps the group parallel, and meets no fan', () => {
    const edges = [...THROUGH, { from: 'after', to: 'c', kind: 'loops-back' as const }];
    const view = grouped(THREE, edges);
    expect([...parallelGroups(view)]).toEqual(['g']);
    expect(fanFaults(view)).toEqual([]);
    expect(drawingFaults(view)).toEqual([]);
  });

  test('a group one of whose members a forward line names is not', () => {
    const edges = [...THROUGH, { from: 'a', to: 'after', kind: 'calls' as const }];
    expect(parallelGroups(grouped(THREE, edges)).size).toBe(0);
  });

  test('a group met along a column is not', () => {
    const view = grouped(THREE, [{ from: 'g', to: 'below', kind: 'feeds' }]);
    view.cards.push({
      ...(view.cards[0] as OverviewView['cards'][number]),
      id: 'below',
      col: 2,
      row: 4,
    });
    expect(parallelGroups(view).size).toBe(0);
  });

  test('a line between two parallel groups fans at both ends', () => {
    const view = grouped(THREE, [{ from: 'g', to: 'h', kind: 'feeds' }]);
    view.groups?.push({ id: 'h', label: 'H' });
    for (const row of [1, 2, 3])
      view.cards.push({
        ...(view.cards[0] as OverviewView['cards'][number]),
        id: `h${row}`,
        col: 3,
        row,
        group: 'h',
      });
    const layout = layoutOverview(view);
    expect(layout.fans.map(f => [f.group, f.side, f.into])).toEqual([
      ['g', 'right', false],
      ['h', 'left', true],
    ]);
    expect(fanFaults(view)).toEqual([]);
  });

  test('the checks drill-down fans into and out of each of its three checks', () => {
    const layout = layoutOverview(shipped.views.checks as OverviewView);
    expect(layout.fans.map(f => [f.group, f.side, f.into, f.stubs.length])).toEqual([
      ['checks-three', 'left', true, 3],
      ['checks-three', 'right', false, 3],
    ]);
    for (const fan of layout.fans)
      for (const stub of fan.stubs)
        expect(Math.abs(stub.to.x - stub.from.x)).toBe(OVERVIEW_GROUP_PAD);
  });

  test.each(views)(
    'view %s: a stub meets only its own card and the edge it branches at that edge end, a bar no card and only that edge',
    (_, view) => {
      expect(fanFaults(view)).toEqual([]);
    }
  );
});
