import { describe, it, expect } from 'bun:test';
import {
  alignLeft,
  alignRight,
  alignTop,
  alignBottom,
  alignCenterH,
  alignCenterV,
} from '../alignment';

type Rect = { x: number; y: number; w: number; h: number };

const rects: Record<string, Rect> = {
  a: { x: 10, y: 30, w: 60, h: 40 },
  b: { x: 50, y: 10, w: 80, h: 60 },
  c: { x: 30, y: 50, w: 50, h: 30 },
};

describe('alignLeft', () => {
  it('aligns all to leftmost x', () => {
    const result = alignLeft(rects);
    expect(result.a.x).toBe(10);
    expect(result.b.x).toBe(10);
    expect(result.c.x).toBe(10);
  });
});

describe('alignRight', () => {
  it('aligns all to rightmost right edge', () => {
    const result = alignRight(rects);
    const rightEdge = Math.max(...Object.values(rects).map(r => r.x + r.w));
    Object.entries(result).forEach(([id, pos]) => {
      expect(pos.x + rects[id].w).toBe(rightEdge);
    });
  });
});

describe('alignTop', () => {
  it('aligns all to topmost y', () => {
    const result = alignTop(rects);
    expect(result.a.y).toBe(10);
    expect(result.b.y).toBe(10);
    expect(result.c.y).toBe(10);
  });
});

describe('alignBottom', () => {
  it('aligns all to bottommost bottom edge', () => {
    const result = alignBottom(rects);
    const bottomEdge = Math.max(...Object.values(rects).map(r => r.y + r.h));
    Object.entries(result).forEach(([id, pos]) => {
      expect(pos.y + rects[id].h).toBe(bottomEdge);
    });
  });
});

describe('alignCenterH', () => {
  it('centers all on the horizontal midpoint of the bounding box', () => {
    const result = alignCenterH(rects);
    const centerY =
      (Math.min(...Object.values(rects).map(r => r.y)) +
        Math.max(...Object.values(rects).map(r => r.y + r.h))) /
      2;
    Object.entries(result).forEach(([id, pos]) => {
      expect(pos.y + rects[id].h / 2).toBeCloseTo(centerY, 1);
    });
  });
});

describe('alignCenterV', () => {
  it('centers all on the vertical midpoint of the bounding box', () => {
    const result = alignCenterV(rects);
    const centerX =
      (Math.min(...Object.values(rects).map(r => r.x)) +
        Math.max(...Object.values(rects).map(r => r.x + r.w))) /
      2;
    Object.entries(result).forEach(([id, pos]) => {
      expect(pos.x + rects[id].w / 2).toBeCloseTo(centerX, 1);
    });
  });
});

describe('single node', () => {
  it('single-node align is a no-op', () => {
    const single = { a: rects.a };
    const result = alignLeft(single);
    expect(result.a.x).toBe(rects.a.x);
  });
});

import { distributeH, distributeV } from '../alignment';

describe('distributeH', () => {
  it('equalizes horizontal gaps', () => {
    const rectsH = {
      a: { x: 0, y: 0, w: 20, h: 20 },
      b: { x: 100, y: 0, w: 20, h: 20 },
      c: { x: 60, y: 0, w: 20, h: 20 },
    };
    const result = distributeH(rectsH);
    // sorted by x: a(0), c(60), b(100)
    // total span: 0 to 120 = 120; each item w=20; gap = (120 - 3*20) / 2 = 30
    // a stays at 0, c moves to 50 (0+20+30), b moves to 100 (50+20+30)
    const sorted = Object.entries(result).sort(([, pa], [, pb]) => pa.x - pb.x);
    const gaps = sorted.slice(1).map(([id, p], i) => {
      const prev = sorted[i];
      return p.x - (prev[1].x + rectsH[prev[0] as keyof typeof rectsH].w);
    });
    // all gaps equal
    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(0.01);
  });
});

describe('distributeV', () => {
  it('equalizes vertical gaps', () => {
    const rectsV = {
      a: { x: 0, y: 0, w: 20, h: 20 },
      b: { x: 0, y: 100, w: 20, h: 20 },
      c: { x: 0, y: 60, w: 20, h: 20 },
    };
    const result = distributeV(rectsV);
    const sorted = Object.entries(result).sort(([, pa], [, pb]) => pa.y - pb.y);
    const gaps = sorted.slice(1).map(([id, p], i) => {
      const prev = sorted[i];
      return p.y - (prev[1].y + rectsV[prev[0] as keyof typeof rectsV].h);
    });
    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(0.01);
  });
});
