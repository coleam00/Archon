/**
 * The map's two loops of dots, each on one timeline:
 *
 * - The forward flow: one dot along every forward hand-off, left to right, back to back with a
 *   beat on each card between them, so the map reads as one flow from the first card to the
 *   last. Where a card has no hand-off on, the dot carries on with the next hand-off there is.
 * - A card's branches: while its send-backs show, one smaller dot along each of them, all
 *   leaving the card at once, so its ways back read as branches of the flow.
 *
 * Times are ms within one period.
 */
import type { Point } from './map-layout';

/**
 * One factor on every duration of a loop: a dot's travel, its rest on a card and the pause
 * between loops (owner change 1 of 2026-11-21 made the loop 1.5 times faster). A later change of
 * tempo is this one edit; the values below are the loop at tempo 1.
 */
const FLOW_TEMPO = 2 / 3;

/** How fast a dot travels, and the least and most one leg takes: a hop between neighbours is short, the lane under the boxes long. */
const FLOW_SPEED = 0.12;
const FLOW_MIN_TRAVEL = 400;
const FLOW_MAX_TRAVEL = 3000;
/** The beat a dot rests on a card, at tempo 1. */
const FLOW_DWELL_BASE = 900;
/** The pause after the last dot arrives, before the loop starts again, at tempo 1. */
const FLOW_REST_BASE = 1500;

/** One dot's leg: along `points` from `start` to `end`, ms within its loop's period. */
export interface FlowMove {
  from: string;
  to: string;
  points: Point[];
  start: number;
  end: number;
}

const length = (points: readonly Point[]): number =>
  points.slice(1).reduce((sum, p, i) => {
    const prev = points[i] as Point;
    return sum + Math.hypot(p.x - prev.x, p.y - prev.y);
  }, 0);

/**
 * How long a dot takes along `points` at `tempo`, in ms. The factor applies after the clamps, so
 * they scale with every other duration.
 */
const travelMs = (points: readonly Point[], tempo = FLOW_TEMPO): number =>
  Math.min(FLOW_MAX_TRAVEL, Math.max(FLOW_MIN_TRAVEL, Math.round(length(points) / FLOW_SPEED))) *
  tempo;

const flowRestMs = (tempo: number): number => FLOW_REST_BASE * tempo;

export interface MapFlowLoop {
  period: number;
  moves: FlowMove[];
}

interface Leg {
  from: string;
  to: string;
  points: Point[];
}

const loopOf = (moves: FlowMove[], tempo: number): MapFlowLoop | undefined => {
  if (moves.length === 0) return undefined;
  return { period: Math.max(...moves.map(move => move.end)) + flowRestMs(tempo), moves };
};

/** The forward flow along `legs` (the forward hand-offs, left to right); none without one. */
export function mapFlow(legs: readonly Leg[], tempo = FLOW_TEMPO): MapFlowLoop | undefined {
  const dwell = FLOW_DWELL_BASE * tempo;
  let t = 0;
  const moves = legs.map((leg, i): FlowMove => {
    if (i > 0) t += dwell;
    const start = t;
    t += travelMs(leg.points, tempo);
    return { from: leg.from, to: leg.to, points: leg.points, start, end: t };
  });
  return loopOf(moves, tempo);
}

/** A card's branches along `legs` (its send-backs' routes), all leaving at once; none without one. */
export function branchFlow(legs: readonly Leg[], tempo = FLOW_TEMPO): MapFlowLoop | undefined {
  return loopOf(
    legs.map((leg): FlowMove => ({ ...leg, start: 0, end: travelMs(leg.points, tempo) })),
    tempo
  );
}
