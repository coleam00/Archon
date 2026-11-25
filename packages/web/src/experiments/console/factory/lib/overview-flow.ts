/**
 * The How it works flow: one loop of dots along the lines a view already draws. Dots leave
 * every input together and reach the first card at once; one dot then carries the work along
 * the forward line, pausing a beat on each card while the card glows; where a line goes back
 * to an input (found work becoming new work) a second dot leaves at the same moment; the loop
 * rests, then starts again. It is read from the kinds of cards and lines, never from ids, so
 * any pack's view gets the same flow. Times are ms within one period.
 */
import type { Point } from './map-layout';
import type { OverviewLayout } from './overview-layout';
import type { OverviewView } from './overview-nav';

/**
 * One factor on every duration of the loop: a dot's travel, its rest on a card and the pause
 * between loops (owner change 1 of 2026-11-21 made the loop 1.5 times faster). A later change of
 * tempo is this one edit; the values below are the loop at tempo 1.
 */
export const FLOW_TEMPO = 2 / 3;

/** How fast a dot travels, and the least and most one leg takes: a hop between neighbours is short, the lane under the boxes long. */
const FLOW_SPEED = 0.12;
const FLOW_MIN_TRAVEL = 400;
const FLOW_MAX_TRAVEL = 3000;
/** The beat a dot rests on a card, while the card glows. */
const FLOW_DWELL_BASE = 900;
/** The pause after the last dot arrives, before the loop starts again. */
const FLOW_REST_BASE = 1500;

/** The beat a dot rests on a card at the loop's tempo. */
export const FLOW_DWELL = FLOW_DWELL_BASE * FLOW_TEMPO;

export interface FlowMove {
  from: string;
  to: string;
  points: Point[];
  start: number;
  end: number;
}

interface FlowGlow {
  card: string;
  start: number;
  end: number;
}

export interface OverviewFlow {
  period: number;
  moves: FlowMove[];
  glows: FlowGlow[];
}

const length = (points: readonly Point[]): number =>
  points.slice(1).reduce((sum, p, i) => {
    const prev = points[i] as Point;
    return sum + Math.hypot(p.x - prev.x, p.y - prev.y);
  }, 0);

const travelAtTempo1 = (points: readonly Point[]): number =>
  Math.min(FLOW_MAX_TRAVEL, Math.max(FLOW_MIN_TRAVEL, Math.round(length(points) / FLOW_SPEED)));

/** Points with no two in a row the same: a zero-length run has no direction to round a bend by. */
function distinct(points: readonly Point[]): Point[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    return prev === undefined || prev.x !== p.x || prev.y !== p.y;
  });
}

/**
 * The flow of `view` as `layout` draws it, or undefined when the view has no single place work
 * starts: exactly one forward (`feeds`) line must leave an input card, or a group of input
 * cards, that nothing feeds. Two or none would leave the dots no one path to follow.
 */
export function overviewFlow(
  view: OverviewView,
  layout: OverviewLayout,
  tempo = FLOW_TEMPO
): OverviewFlow | undefined {
  // The factor applies after the clamps, so they scale with every other duration.
  const travel = (points: readonly Point[]): number => travelAtTempo1(points) * tempo;
  const dwell = FLOW_DWELL_BASE * tempo;
  const kindOf = new Map(view.cards.map(card => [card.id, card.kind]));
  const isInput = (id: string): boolean => {
    if (kindOf.has(id)) return kindOf.get(id) === 'input';
    const members = view.cards.filter(card => card.group === id);
    return members.length > 0 && members.every(card => card.kind === 'input');
  };
  const feeds = layout.edges.filter(edge => edge.kind === 'feeds');
  const fed = new Set(feeds.map(edge => edge.to));
  const starts = feeds.filter(edge => isInput(edge.from) && !fed.has(edge.from));
  const start = starts[0];
  if (start === undefined || starts.length > 1 || !layout.cards.has(start.to)) return undefined;

  // Every input leaves at once and arrives at once, so the dots meet on the first card.
  const legs = inputLegs(start, layout);
  let t = Math.max(...legs.map(leg => travel(leg.points)));
  const moves: FlowMove[] = legs.map(leg => ({
    from: leg.from,
    to: start.to,
    points: leg.points,
    start: 0,
    end: t,
  }));
  const glows: FlowGlow[] = [];

  const visited = new Set<string>();
  let cur: string | undefined = start.to;
  while (cur !== undefined) {
    const card: string = cur;
    visited.add(card);
    glows.push({ card, start: t, end: t + dwell });
    t += dwell;
    for (const back of layout.edges) {
      if (back.kind !== 'loops-back' || back.from !== card || kindOf.get(back.to) !== 'input')
        continue;
      const end = t + travel(back.points);
      moves.push({ ...pick(back), start: t, end });
      glows.push({ card: back.to, start: end, end: end + dwell });
    }
    const out = feeds.filter(edge => edge.from === card);
    const next = out[0];
    cur = undefined;
    if (next === undefined || out.length > 1) break;
    if (!layout.cards.has(next.to) || visited.has(next.to)) break;
    const end = t + travel(next.points);
    moves.push({ ...pick(next), start: t, end });
    t = end;
    cur = next.to;
  }

  const last = Math.max(...moves.map(move => move.end), ...glows.map(glow => glow.end));
  return { period: last + FLOW_REST_BASE * tempo, moves, glows };
}

/**
 * One leg per input: from each member of an input group, along its stub of the group's fan, down
 * the bar to the line's row and on along the line; from an input card, along the line.
 */
function inputLegs(
  start: OverviewLayout['edges'][number],
  layout: OverviewLayout
): { from: string; points: Point[] }[] {
  const fan = layout.fans.find(f => f.group === start.from && !f.into);
  if (fan === undefined) return [{ from: start.from, points: start.points }];
  return fan.stubs.map(stub => ({
    from: stub.card,
    points: distinct([
      stub.from,
      stub.to,
      { x: stub.to.x, y: (start.points[0] as Point).y },
      ...start.points.slice(1),
    ]),
  }));
}

const pick = (edge: OverviewLayout['edges'][number]) => ({
  from: edge.from,
  to: edge.to,
  points: edge.points,
});
