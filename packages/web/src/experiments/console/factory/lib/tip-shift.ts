/** A box's horizontal extent on screen (px). */
export interface Span {
  left: number;
  right: number;
}

/** The room a tip keeps from the frame's edges (screen px). */
const TIP_EDGE = 8;

/**
 * How far (screen px) a tip must move sideways to sit inside the frame it is drawn in, `TIP_EDGE`
 * from either edge: 0 when it already does. Its left edge wins when the tip is wider than the
 * frame, so its words start in view.
 */
export function tipShift(tip: Span, frame: Span): number {
  if (tip.left < frame.left + TIP_EDGE) return frame.left + TIP_EDGE - tip.left;
  if (tip.right > frame.right - TIP_EDGE)
    return Math.max(frame.right - TIP_EDGE - tip.right, frame.left + TIP_EDGE - tip.left);
  return 0;
}
