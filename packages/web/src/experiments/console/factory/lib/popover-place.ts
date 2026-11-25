interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Room between the card and the popover, and between the popover and the window's edge. */
const GAP = 8;
const MARGIN = 16;

/**
 * Where the popover sits for a card at `anchor`: right of it when it fits, else left of it,
 * its top level with the card's and kept inside the window with `MARGIN` to spare.
 */
export function popoverPlace(
  anchor: Rect,
  box: { width: number; height: number },
  viewport: { width: number; height: number }
): { top: number; left: number } {
  const right = anchor.right + GAP;
  const left =
    right + box.width + MARGIN <= viewport.width
      ? right
      : Math.max(MARGIN, anchor.left - GAP - box.width);
  const lowest = Math.max(MARGIN, viewport.height - MARGIN - box.height);
  return { top: Math.min(Math.max(MARGIN, anchor.top), lowest), left };
}
