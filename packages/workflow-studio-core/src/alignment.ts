interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Pos {
  x: number;
  y: number;
}
type Result = Record<string, Pos>;

export function alignLeft(rects: Record<string, Rect>): Result {
  const minX = Math.min(...Object.values(rects).map(r => r.x));
  return Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, { x: minX, y: r.y }]));
}

export function alignRight(rects: Record<string, Rect>): Result {
  const maxRight = Math.max(...Object.values(rects).map(r => r.x + r.w));
  return Object.fromEntries(
    Object.entries(rects).map(([id, r]) => [id, { x: maxRight - r.w, y: r.y }])
  );
}

export function alignTop(rects: Record<string, Rect>): Result {
  const minY = Math.min(...Object.values(rects).map(r => r.y));
  return Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, { x: r.x, y: minY }]));
}

export function alignBottom(rects: Record<string, Rect>): Result {
  const maxBottom = Math.max(...Object.values(rects).map(r => r.y + r.h));
  return Object.fromEntries(
    Object.entries(rects).map(([id, r]) => [id, { x: r.x, y: maxBottom - r.h }])
  );
}

export function alignCenterH(rects: Record<string, Rect>): Result {
  const minY = Math.min(...Object.values(rects).map(r => r.y));
  const maxY = Math.max(...Object.values(rects).map(r => r.y + r.h));
  const centerY = (minY + maxY) / 2;
  return Object.fromEntries(
    Object.entries(rects).map(([id, r]) => [id, { x: r.x, y: centerY - r.h / 2 }])
  );
}

export function alignCenterV(rects: Record<string, Rect>): Result {
  const minX = Math.min(...Object.values(rects).map(r => r.x));
  const maxX = Math.max(...Object.values(rects).map(r => r.x + r.w));
  const centerX = (minX + maxX) / 2;
  return Object.fromEntries(
    Object.entries(rects).map(([id, r]) => [id, { x: centerX - r.w / 2, y: r.y }])
  );
}

export function distributeH(rects: Record<string, Rect>): Result {
  const entries = Object.entries(rects).sort(([, a], [, b]) => a.x - b.x);
  if (entries.length < 3)
    return Object.fromEntries(entries.map(([id, r]) => [id, { x: r.x, y: r.y }]));
  const first = entries[0][1];
  const last = entries[entries.length - 1][1];
  const totalSpan = last.x + last.w - first.x;
  const totalWidth = entries.reduce((s, [, r]) => s + r.w, 0);
  const gap = (totalSpan - totalWidth) / (entries.length - 1);
  let cursor = first.x;
  return Object.fromEntries(
    entries.map(([id, r]) => {
      const x = cursor;
      cursor += r.w + gap;
      return [id, { x, y: r.y }];
    })
  );
}

export function distributeV(rects: Record<string, Rect>): Result {
  const entries = Object.entries(rects).sort(([, a], [, b]) => a.y - b.y);
  if (entries.length < 3)
    return Object.fromEntries(entries.map(([id, r]) => [id, { x: r.x, y: r.y }]));
  const first = entries[0][1];
  const last = entries[entries.length - 1][1];
  const totalSpan = last.y + last.h - first.y;
  const totalHeight = entries.reduce((s, [, r]) => s + r.h, 0);
  const gap = (totalSpan - totalHeight) / (entries.length - 1);
  let cursor = first.y;
  return Object.fromEntries(
    entries.map(([id, r]) => {
      const y = cursor;
      cursor += r.h + gap;
      return [id, { x: r.x, y }];
    })
  );
}
