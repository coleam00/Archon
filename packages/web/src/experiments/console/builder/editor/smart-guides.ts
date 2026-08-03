/**
 * Smart-guide (helper-line) snap math. A port of React Flow's canonical
 * "helper lines" example crossed with the standalone studio's
 * `smart-guides.ts`: compare the dragged rect's left/centerX/right and
 * top/centerY/bottom against every stationary rect within `threshold`,
 * return the matching guide coordinates plus the snapped position.
 *
 * Pure math — the `SmartGuides` overlay renders the result; this module is
 * unit-tested without a DOM.
 */
import type { XYPosition } from '../flow/types';

/** A rect in flow coordinates (top-left anchored, like xyflow nodes). */
export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuideResult {
  /** X coordinates of vertical guide lines to draw. */
  vertical: number[];
  /** Y coordinates of horizontal guide lines to draw. */
  horizontal: number[];
  /** The dragged rect's position after snapping (unchanged when no match). */
  snap: XYPosition;
}

export const GUIDE_THRESHOLD = 6;

interface Candidate {
  /** Guide-line coordinate to draw. */
  guide: number;
  /** Snapped top-left coordinate for the dragged rect. */
  snapTo: number;
  /** Distance between the dragged edge and the candidate. */
  distance: number;
}

function best(candidates: readonly Candidate[]): Candidate | undefined {
  let winner: Candidate | undefined;
  for (const c of candidates) {
    if (winner === undefined || c.distance < winner.distance) winner = c;
  }
  return winner;
}

/**
 * Compute guide lines + snap position for `dragged` against `others`.
 * Edge-to-edge (left/right against left/right, top/bottom against top/bottom)
 * and center-to-center alignments are considered; the closest candidate per
 * axis wins the snap, and every guide coordinate within `threshold` is
 * returned for rendering (deduped).
 */
export function computeGuides(
  dragged: Rect,
  others: readonly Rect[],
  threshold: number = GUIDE_THRESHOLD
): GuideResult {
  const dLeft = dragged.x;
  const dRight = dragged.x + dragged.width;
  const dCenterX = dragged.x + dragged.width / 2;
  const dTop = dragged.y;
  const dBottom = dragged.y + dragged.height;
  const dCenterY = dragged.y + dragged.height / 2;

  const xCandidates: Candidate[] = [];
  const yCandidates: Candidate[] = [];

  for (const s of others) {
    if (s.id === dragged.id) continue;
    const sLeft = s.x;
    const sRight = s.x + s.width;
    const sCenterX = s.x + s.width / 2;
    const sTop = s.y;
    const sBottom = s.y + s.height;
    const sCenterY = s.y + s.height / 2;

    const xPairs: [number, number][] = [
      // [dragged edge, stationary edge] — snapTo is the dragged rect's new x.
      [dLeft, sLeft],
      [dLeft, sRight],
      [dRight, sLeft],
      [dRight, sRight],
      [dCenterX, sCenterX],
    ];
    for (const [dEdge, sEdge] of xPairs) {
      const distance = Math.abs(dEdge - sEdge);
      if (distance <= threshold) {
        xCandidates.push({ guide: sEdge, snapTo: dragged.x + (sEdge - dEdge), distance });
      }
    }

    const yPairs: [number, number][] = [
      [dTop, sTop],
      [dTop, sBottom],
      [dBottom, sTop],
      [dBottom, sBottom],
      [dCenterY, sCenterY],
    ];
    for (const [dEdge, sEdge] of yPairs) {
      const distance = Math.abs(dEdge - sEdge);
      if (distance <= threshold) {
        yCandidates.push({ guide: sEdge, snapTo: dragged.y + (sEdge - dEdge), distance });
      }
    }
  }

  const bestX = best(xCandidates);
  const bestY = best(yCandidates);

  return {
    vertical: [...new Set(xCandidates.map(c => c.guide))],
    horizontal: [...new Set(yCandidates.map(c => c.guide))],
    snap: {
      x: bestX !== undefined ? bestX.snapTo : dragged.x,
      y: bestY !== undefined ? bestY.snapTo : dragged.y,
    },
  };
}
