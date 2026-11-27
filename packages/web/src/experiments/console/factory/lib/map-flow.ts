/**
 * The map's two loops of dots, each on one timeline, timed as How it works times its own
 * (`overview-flow.ts`: the same speed, tempo and rest), so the map reads as the same flow.
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
import { FLOW_DWELL, FLOW_TEMPO, flowRestMs, travelMs, type FlowMove } from './overview-flow';

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
  const dwell = (FLOW_DWELL / FLOW_TEMPO) * tempo;
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
