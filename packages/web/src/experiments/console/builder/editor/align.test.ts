import { describe, test, expect } from 'bun:test';
import {
  align,
  alignBottom,
  alignCenterH,
  alignCenterV,
  alignLeft,
  alignRight,
  alignTop,
  autoArrange,
  distributeH,
  distributeV,
  type NodeRect,
} from './align';

function rect(id: string, x: number, y: number, width = 100, height = 50): NodeRect {
  return { id, position: { x, y }, width, height };
}

const TRIO: NodeRect[] = [rect('a', 0, 0), rect('b', 250, 40), rect('c', 600, 90)];

describe('align kernels', () => {
  test('alignLeft moves everything to the minimum x, preserving y', () => {
    const out = alignLeft(TRIO);
    expect(out.get('a')).toEqual({ x: 0, y: 0 });
    expect(out.get('b')).toEqual({ x: 0, y: 40 });
    expect(out.get('c')).toEqual({ x: 0, y: 90 });
  });

  test('alignRight aligns right edges to the maximum right', () => {
    const out = alignRight(TRIO);
    // max right = 600 + 100 = 700; every rect's x = 700 - width.
    expect(out.get('a')?.x).toBe(600);
    expect(out.get('b')?.x).toBe(600);
    expect(out.get('c')?.x).toBe(600);
  });

  test('alignTop / alignBottom mirror left/right on the y axis', () => {
    const top = alignTop(TRIO);
    expect([top.get('a')?.y, top.get('b')?.y, top.get('c')?.y]).toEqual([0, 0, 0]);
    const bottom = alignBottom(TRIO);
    // max bottom = 90 + 50 = 140; y = 140 - height.
    expect([bottom.get('a')?.y, bottom.get('b')?.y, bottom.get('c')?.y]).toEqual([90, 90, 90]);
  });

  test('alignCenterH centers on the shared horizontal centerline (same y)', () => {
    const out = alignCenterH([rect('a', 0, 0), rect('b', 200, 100)]);
    // span 0..150, centerY = 75, each y = 75 - 25 = 50.
    expect(out.get('a')?.y).toBe(50);
    expect(out.get('b')?.y).toBe(50);
    expect(out.get('a')?.x).toBe(0);
  });

  test('alignCenterV centers on the shared vertical centerline (same x)', () => {
    const out = alignCenterV([rect('a', 0, 0), rect('b', 200, 100)]);
    // span 0..300, centerX = 150, each x = 150 - 50 = 100.
    expect(out.get('a')?.x).toBe(100);
    expect(out.get('b')?.x).toBe(100);
    expect(out.get('b')?.y).toBe(100);
  });

  test('align() dispatches every mode', () => {
    for (const mode of ['left', 'right', 'top', 'bottom', 'centerH', 'centerV'] as const) {
      expect(align(mode, TRIO).size).toBe(3);
    }
  });
});

describe('distribute kernels', () => {
  test('distributeH spaces gaps evenly, anchoring first and last', () => {
    const out = distributeH(TRIO);
    // span = (600+100) - 0 = 700; widths total 300; gap = (700-300)/2 = 200.
    expect(out.get('a')?.x).toBe(0);
    expect(out.get('b')?.x).toBe(300);
    expect(out.get('c')?.x).toBe(600);
    // y untouched.
    expect(out.get('b')?.y).toBe(40);
  });

  test('distributeV spaces gaps evenly on the y axis', () => {
    const out = distributeV([rect('a', 0, 0), rect('b', 10, 30), rect('c', 20, 400)]);
    // span = 450 - 0 = 450; heights total 150; gap = (450-150)/2 = 150.
    expect(out.get('a')?.y).toBe(0);
    expect(out.get('b')?.y).toBe(200);
    expect(out.get('c')?.y).toBe(400);
  });

  test('fewer than three rects is the identity', () => {
    const out = distributeH([rect('a', 5, 6), rect('b', 70, 80)]);
    expect(out.get('a')).toEqual({ x: 5, y: 6 });
    expect(out.get('b')).toEqual({ x: 70, y: 80 });
  });
});

describe('autoArrange', () => {
  test('delegates to dagre and returns a position per node', () => {
    const out = autoArrange(['a', 'b'], [{ source: 'a', target: 'b' }]);
    expect(out.size).toBe(2);
    const a = out.get('a');
    const b = out.get('b');
    if (a && b) expect(b.y).toBeGreaterThan(a.y);
  });
});
