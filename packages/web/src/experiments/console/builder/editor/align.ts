/**
 * Alignment / distribution / auto-arrange kernels. Ported from the standalone
 * studio's `alignment.ts`. Pure geometry over `{ id, position, width, height }`
 * rectangles — every function returns *new positions only* and mutates nothing.
 *
 * Naming follows the studio: `alignCenterH` aligns along the horizontal
 * centerline (same center *y*); `alignCenterV` along the vertical centerline
 * (same center *x*).
 */
import { layoutWithDagre } from '../flow/layout';
import type { XYPosition } from '../flow/types';

/** A positioned node rectangle in flow coordinates. */
export interface NodeRect {
  id: string;
  position: XYPosition;
  width: number;
  height: number;
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV';

function toPositions(
  rects: readonly NodeRect[],
  pos: (r: NodeRect) => XYPosition
): Map<string, XYPosition> {
  return new Map(rects.map(r => [r.id, pos(r)]));
}

export function alignLeft(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const minX = Math.min(...rects.map(r => r.position.x));
  return toPositions(rects, r => ({ x: minX, y: r.position.y }));
}

export function alignRight(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const maxRight = Math.max(...rects.map(r => r.position.x + r.width));
  return toPositions(rects, r => ({ x: maxRight - r.width, y: r.position.y }));
}

export function alignTop(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const minY = Math.min(...rects.map(r => r.position.y));
  return toPositions(rects, r => ({ x: r.position.x, y: minY }));
}

export function alignBottom(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const maxBottom = Math.max(...rects.map(r => r.position.y + r.height));
  return toPositions(rects, r => ({ x: r.position.x, y: maxBottom - r.height }));
}

/** Same center y for every rect (align along the horizontal centerline). */
export function alignCenterH(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const minY = Math.min(...rects.map(r => r.position.y));
  const maxY = Math.max(...rects.map(r => r.position.y + r.height));
  const centerY = (minY + maxY) / 2;
  return toPositions(rects, r => ({ x: r.position.x, y: centerY - r.height / 2 }));
}

/** Same center x for every rect (align along the vertical centerline). */
export function alignCenterV(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const minX = Math.min(...rects.map(r => r.position.x));
  const maxX = Math.max(...rects.map(r => r.position.x + r.width));
  const centerX = (minX + maxX) / 2;
  return toPositions(rects, r => ({ x: centerX - r.width / 2, y: r.position.y }));
}

/** Dispatch table for the six alignment modes. */
export function align(mode: AlignMode, rects: readonly NodeRect[]): Map<string, XYPosition> {
  switch (mode) {
    case 'left':
      return alignLeft(rects);
    case 'right':
      return alignRight(rects);
    case 'top':
      return alignTop(rects);
    case 'bottom':
      return alignBottom(rects);
    case 'centerH':
      return alignCenterH(rects);
    case 'centerV':
      return alignCenterV(rects);
  }
}

/**
 * Even horizontal gaps between rects, keeping the leftmost and rightmost in
 * place. Fewer than three rects have nothing to distribute (identity).
 */
export function distributeH(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const sorted = [...rects].sort((a, b) => a.position.x - b.position.x);
  if (sorted.length < 3) return toPositions(sorted, r => ({ ...r.position }));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalSpan = last.position.x + last.width - first.position.x;
  const totalWidth = sorted.reduce((s, r) => s + r.width, 0);
  const gap = (totalSpan - totalWidth) / (sorted.length - 1);
  let cursor = first.position.x;
  const out = new Map<string, XYPosition>();
  for (const r of sorted) {
    out.set(r.id, { x: cursor, y: r.position.y });
    cursor += r.width + gap;
  }
  return out;
}

/** Even vertical gaps, keeping the topmost and bottommost in place. */
export function distributeV(rects: readonly NodeRect[]): Map<string, XYPosition> {
  const sorted = [...rects].sort((a, b) => a.position.y - b.position.y);
  if (sorted.length < 3) return toPositions(sorted, r => ({ ...r.position }));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalSpan = last.position.y + last.height - first.position.y;
  const totalHeight = sorted.reduce((s, r) => s + r.height, 0);
  const gap = (totalSpan - totalHeight) / (sorted.length - 1);
  let cursor = first.position.y;
  const out = new Map<string, XYPosition>();
  for (const r of sorted) {
    out.set(r.id, { x: r.position.x, y: cursor });
    cursor += r.height + gap;
  }
  return out;
}

/** Re-layout the whole graph with dagre (delegates to `flow/layout`). */
export function autoArrange(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[]
): Map<string, XYPosition> {
  return layoutWithDagre(nodeIds, edges);
}
