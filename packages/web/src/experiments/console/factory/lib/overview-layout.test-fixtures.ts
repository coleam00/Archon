/**
 * What is wrong with a view as `layoutOverview` draws it, in world px: an edge it could not
 * route, a line touching a card other than its ends or a group holding neither end, two lines
 * touching, or a label pill touching anything (`pillFaults`). The shipped file's test and the
 * schema conformance test (`scripts/overview-geometry-parity.test.ts`) both judge a drawing by
 * this one check; the conformance test's views carry no labels, so pills, which only the web
 * draws, never enter its verdict.
 */
import type { Box, Point } from './map-layout';
import {
  groupLabelBox,
  layoutOverview,
  type OverviewEdgePath,
  type OverviewFan,
  type OverviewLayout,
} from './overview-layout';
import type { OverviewView } from './overview-nav';

/** Each straight run of a line, as a box with no width or no height. */
function segments(edge: { points: readonly Point[] }): Box[] {
  return edge.points.slice(1).map((end, i) => {
    const start = edge.points[i] as Point;
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
    };
  });
}

/** Whether two boxes share any point, edges included. */
const meets = (a: Box, b: Box): boolean =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** Every fault in the drawing of `view`; empty when it is clean. */
export function drawingFaults(view: OverviewView): string[] {
  const layout = layoutOverview(view);
  const faults: string[] = [];
  const drawn = new Set(layout.edges.map(edge => `${edge.from}->${edge.to}:${edge.kind}`));
  for (const edge of view.edges)
    if (!drawn.has(`${edge.from}->${edge.to}:${edge.kind}`))
      faults.push(`${edge.from}->${edge.to} is not drawn`);
  const groupOf = (id: string): string | undefined => view.cards.find(c => c.id === id)?.group;
  const boxes = [...layout.cards, ...layout.groups];
  layout.edges.forEach((edge, i) => {
    const runs = segments(edge);
    const ends = new Set([edge.from, edge.to, groupOf(edge.from), groupOf(edge.to)]);
    for (const [id, box] of boxes)
      if (!ends.has(id) && runs.some(run => meets(run, box)))
        faults.push(`${edge.from}->${edge.to} hits ${id}`);
    for (const other of layout.edges.slice(i + 1))
      if (runs.some(run => segments(other).some(run2 => meets(run, run2))))
        faults.push(`${edge.from}->${edge.to} meets ${other.from}->${other.to}`);
  });
  return [...faults, ...pillFaults(view, layout)];
}

/**
 * What the label pills touch: a card, a group's label, another pill, or any line, its own and
 * the fans' included. A label never sits on a line (the Visual standard, rule 4).
 */
function pillFaults(view: OverviewView, layout: OverviewLayout): string[] {
  const labels = (view.groups ?? []).flatMap(group => {
    const box = layout.groups.get(group.id);
    return box === undefined
      ? []
      : [[`${group.id} label`, groupLabelBox(box, group.label)] as const];
  });
  const obstacles: (readonly [string, Box])[] = [
    ...layout.cards,
    ...labels,
    ...layout.edges.flatMap(edge =>
      segments(edge).map(run => [`${edge.from}->${edge.to}`, run] as const)
    ),
    ...layout.fans.flatMap(fan => [
      ...segments({ points: fan.bar }).map(run => [`${fan.group} bar`, run] as const),
      ...fan.stubs.map(
        s => [`${fan.group} stub`, segments({ points: [s.from, s.to] })[0] as Box] as const
      ),
    ]),
  ];
  const pills = layout.edges.flatMap(edge =>
    edge.pill === undefined ? [] : [[`${edge.from}->${edge.to} label`, edge.pill] as const]
  );
  const faults: string[] = [];
  pills.forEach(([name, pill], i) => {
    for (const [other, box] of [...obstacles, ...pills.slice(i + 1)])
      if (meets(pill, box)) faults.push(`${name} meets ${other}`);
  });
  return faults;
}

/** Where two meeting boxes overlap. */
function overlap(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}

/** A fan's bar, or one of its stubs with the card it reaches. */
interface FanLine {
  name: string;
  points: Point[];
  card: string | undefined;
}

/**
 * What one line of a fan touches that it should not: a card but its own, or a missed own card;
 * or an edge, unless it is the group edge the fan branches and they share only that edge's end.
 */
function lineFaults(
  layout: OverviewLayout,
  line: FanLine,
  edge: OverviewEdgePath,
  end: Point
): string[] {
  const [run] = segments(line);
  if (run === undefined) return [];
  const faults = [...layout.cards]
    .filter(([id, box]) => id !== line.card && meets(run, box))
    .map(([id]) => `${line.name} hits ${id}`);
  if (line.card !== undefined && !meets(run, layout.cards.get(line.card) as Box))
    faults.push(`${line.name} misses it`);
  const atEnd = (at: Box): boolean => at.x === end.x && at.y === end.y && at.w === 0 && at.h === 0;
  for (const other of layout.edges) {
    const touching = segments(other).filter(r => meets(r, run));
    if (touching.some(r => other !== edge || !atEnd(overlap(r, run))))
      faults.push(`${line.name} meets ${other.from}->${other.to}`);
  }
  return faults;
}

/** What one fan touches that it should not, given the group edge it branches. */
function oneFanFaults(layout: OverviewLayout, fan: OverviewFan): string[] {
  const edge = layout.edges.find(e => (fan.into ? e.to : e.from) === fan.group);
  if (edge === undefined) return [`the fan of ${fan.group} has no edge`];
  const end = (fan.into ? edge.points.at(-1) : edge.points[0]) as Point;
  const onBar = end.x === fan.bar[0].x && end.y >= fan.bar[0].y && end.y <= fan.bar[1].y;
  const lines: FanLine[] = [
    { name: `${fan.group} bar`, points: fan.bar, card: undefined },
    ...fan.stubs.map(s => ({
      name: `${fan.group} stub to ${s.card}`,
      points: [s.from, s.to],
      card: s.card,
    })),
  ];
  return [
    ...(onBar ? [] : [`${edge.from}->${edge.to} does not end on its bar`]),
    ...lines.flatMap(line => lineFaults(layout, line, edge, end)),
  ];
}

/**
 * What the fans of `view` touch that they should not: a stub meets only its own member, a bar
 * no card, and either one meets only the group edge it branches, at that edge's end. The fans
 * are drawn outside `drawingFaults`, which counts any touch as a fault.
 */
export function fanFaults(view: OverviewView): string[] {
  const layout = layoutOverview(view);
  return layout.fans.flatMap(fan => oneFanFaults(layout, fan));
}
