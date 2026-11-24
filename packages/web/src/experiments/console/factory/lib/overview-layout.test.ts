import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitCamera, fittedHeight, type Frame } from './map-camera';
import {
  layoutOverview,
  OVERVIEW_FIT_PAD,
  OVERVIEW_MAX_K,
  OVERVIEW_MIN_K,
  OVERVIEW_PAGE_MAX_H,
  OVERVIEW_SMALLEST_PX,
  OVERVIEW_TYPE_FLOOR_PX,
  type OverviewEdgePath,
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
 * The map frame on the page at 1440x900, measured in a browser on `bun run dev:console`:
 * PAGE_WIDTH wide and at most OVERVIEW_PAGE_MAX_H tall.
 */
const PAGE_WIDTH = 892;

const views = Object.entries(shipped.views);
const root = shipped.views[shipped.root] as OverviewView;

function fittedK(view: OverviewView, frame: Frame, pad: number): number {
  return fitCamera(layoutOverview(view).bounds, frame, pad, OVERVIEW_MIN_K, OVERVIEW_MAX_K).k;
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

describe('the shipped overview, drawn', () => {
  test.each(views)(
    'view %s: no line, label, stub or bar runs through a card, a foreign group or another line',
    (_, view) => {
      expect(drawingFaults(view)).toEqual([]);
      expect(fanFaults(view)).toEqual([]);
    }
  );

  test('the root sends work back four ways in one lane; the checks drill-down to Build or Plan', () => {
    const lanes = laneLines(layoutOverview(root).edges);
    expect(lanes.map(edge => `${edge.from}->${edge.to}`).sort()).toEqual([
      'build->plan',
      'checks->build',
      'ci->build',
      'ci->found',
    ]);
    expect(lanes.find(edge => edge.to === 'found')?.shadow).toBe(true);
    const checks = layoutOverview(shipped.views.checks as OverviewView).edges;
    expect(laneLines(checks).map(edge => [edge.from, edge.to, edge.label])).toEqual([
      ['checks-verdict', 'checks-build', 'sent back to fix'],
      ['checks-verdict', 'checks-plan', 'replan'],
    ]);
  });

  test.each(views)(
    'view %s opens on the page at a zoom that draws its smallest text at the type floor',
    (_, view) => {
      const k = fittedK(view, pageFrame(view), OVERVIEW_FIT_PAD);
      expect(OVERVIEW_SMALLEST_PX * k).toBeGreaterThanOrEqual(OVERVIEW_TYPE_FLOOR_PX);
    }
  );
});

const fannedGroups = (view: OverviewView): string[] => [
  ...new Set(layoutOverview(view).fans.map(fan => fan.group)),
];

describe('a group drawn as parallel work fans its line out to each member', () => {
  test('the shipped file fans two: the root inputs and the three checks', () => {
    expect(views.flatMap(([, view]) => fannedGroups(view)).sort()).toEqual([
      'checks-three',
      'inputs',
    ]);
    const checks = layoutOverview(shipped.views.checks as OverviewView);
    expect(checks.fans.map(f => [f.group, f.side, f.into, f.stubs.length])).toEqual([
      ['checks-three', 'left', true, 3],
      ['checks-three', 'right', false, 3],
    ]);
  });
});
