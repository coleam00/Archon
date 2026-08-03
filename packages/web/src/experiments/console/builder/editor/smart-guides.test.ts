import { describe, test, expect } from 'bun:test';
import { computeGuides, GUIDE_THRESHOLD, type Rect } from './smart-guides';

function r(id: string, x: number, y: number, width = 100, height = 50): Rect {
  return { id, x, y, width, height };
}

describe('computeGuides', () => {
  test('no candidates outside the threshold — position unchanged', () => {
    const dragged = r('d', 0, 0);
    const result = computeGuides(dragged, [r('s', 500, 500)], GUIDE_THRESHOLD);
    expect(result.vertical).toEqual([]);
    expect(result.horizontal).toEqual([]);
    expect(result.snap).toEqual({ x: 0, y: 0 });
  });

  test('left edges within threshold snap exactly and emit a vertical guide', () => {
    const dragged = r('d', 104, 300);
    const result = computeGuides(dragged, [r('s', 100, 0)], 6);
    expect(result.vertical).toContain(100);
    expect(result.snap.x).toBe(100);
    // y has no candidate — untouched.
    expect(result.snap.y).toBe(300);
  });

  test('right edge aligning to a left edge snaps x to (edge - width)', () => {
    // dragged right = 204; stationary left = 200 → snap right edge onto it.
    const dragged = r('d', 104, 300);
    const result = computeGuides(dragged, [r('s', 200, 0)], 6);
    expect(result.vertical).toContain(200);
    expect(result.snap.x).toBe(100);
  });

  test('center-to-center alignment snaps both axes', () => {
    // stationary center = (150, 125); dragged center currently (153, 122).
    const dragged = r('d', 103, 97);
    const result = computeGuides(dragged, [r('s', 100, 100)], 6);
    expect(result.vertical).toContain(150);
    expect(result.horizontal).toContain(125);
    expect(result.snap).toEqual({ x: 100, y: 100 });
  });

  test('top/bottom edge candidates emit horizontal guides', () => {
    // dragged top = 148; stationary bottom = 150 → within threshold.
    const dragged = r('d', 500, 148);
    const result = computeGuides(dragged, [r('s', 0, 100)], 6);
    expect(result.horizontal).toContain(150);
    expect(result.snap.y).toBe(150);
  });

  test('the closest candidate wins the snap', () => {
    // Two stationary rects: left edges at 95 (distance 5) and 102 (distance 2).
    const dragged = r('d', 100, 0);
    const result = computeGuides(dragged, [r('far', 95, 200), r('near', 102, 400)], 6);
    expect(result.snap.x).toBe(102);
    // Both guides still render.
    expect(result.vertical).toEqual(expect.arrayContaining([95, 102]));
  });

  test('threshold is inclusive and respected', () => {
    const dragged = r('d', 100, 0);
    const at = computeGuides(dragged, [r('s', 106, 200)], 6);
    expect(at.snap.x).toBe(106);
    const beyond = computeGuides(dragged, [r('s', 107, 200)], 6);
    expect(beyond.snap.x).toBe(100);
    expect(beyond.vertical).toEqual([]);
  });

  test('the dragged rect never matches against itself', () => {
    const dragged = r('d', 100, 100);
    const result = computeGuides(dragged, [dragged], 6);
    expect(result.vertical).toEqual([]);
    expect(result.horizontal).toEqual([]);
  });

  test('duplicate guide coordinates are deduped', () => {
    const dragged = r('d', 100, 0);
    // Two rects perfectly aligned with the dragged one: left/right/center
    // coordinates each match twice but emit one guide apiece.
    const result = computeGuides(dragged, [r('s1', 100, 200), r('s2', 100, 400)], 6);
    expect(result.vertical.length).toBe(new Set(result.vertical).size);
    expect([...result.vertical].sort((a, b) => a - b)).toEqual([100, 150, 200]);
  });
});
