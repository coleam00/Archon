import type { Box } from './map-layout';

/** A straight, axis-aligned piece of a map path. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A path of M, H and V commands as its straight segments. */
export function segments(d: string): Segment[] {
  const out: Segment[] = [];
  let x = 0;
  let y = 0;
  for (const command of d.split(' ')) {
    const [kind, rest] = [command[0], command.slice(1)];
    if (kind === 'M') {
      [x, y] = rest.split(',').map(Number) as [number, number];
      continue;
    }
    const next = Number(rest);
    const [nx, ny] = kind === 'H' ? [next, y] : [x, next];
    out.push({ x1: x, y1: y, x2: nx, y2: ny });
    [x, y] = [nx, ny];
  }
  return out;
}

const horizontal = (s: Segment): boolean => s.y1 === s.y2;

/** Whether an axis-aligned segment enters the box's interior, shrunk by half a pixel. */
export function enters(box: Box, s: Segment): boolean {
  const [l, r, t, b] = [box.x + 0.5, box.x + box.w - 0.5, box.y + 0.5, box.y + box.h - 0.5];
  const [sl, sr] = [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
  const [st, sb] = [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
  return sl <= r && sr >= l && st <= b && sb >= t;
}

const strictlyBetween = (v: number, a: number, b: number): boolean =>
  v > Math.min(a, b) && v < Math.max(a, b);

/**
 * Whether two axis-aligned segments cross: one runs through the other's interior. Collinear
 * overlap is one line, not a crossing, and an end on the other (a corner, a join) is not one.
 */
export function crosses(p: Segment, q: Segment): boolean {
  if (horizontal(p) === horizontal(q)) return false;
  const [h, v] = horizontal(p) ? [p, q] : [q, p];
  return strictlyBetween(v.x1, h.x1, h.x2) && strictlyBetween(h.y1, v.y1, v.y2);
}

/**
 * Whether two segments on one line share more than a point: two routes drawn on top of each
 * other along a run, which `crosses` does not count.
 */
export function overlaps(p: Segment, q: Segment): boolean {
  const [ph, qh] = [horizontal(p), horizontal(q)];
  if (ph !== qh) return false;
  if (ph ? p.y1 !== q.y1 : p.x1 !== q.x1) return false;
  const span = (s: Segment): [number, number] =>
    ph
      ? [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)]
      : [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
  const [[a, b], [c, d]] = [span(p), span(q)];
  return Math.min(b, d) - Math.max(a, c) > 0;
}

/** Whether two boxes overlap, edges touching not counted. */
export const boxesMeet = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
