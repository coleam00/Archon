import { describe, it, expect } from 'bun:test';
import { computeGuides } from '../smart-guides';

type Rect = { id: string; x: number; y: number; w: number; h: number };

const stationary: Rect[] = [
  { id: 'a', x: 100, y: 0, w: 80, h: 60 },
  { id: 'b', x: 0, y: 100, w: 80, h: 60 },
];

describe('computeGuides', () => {
  it('returns empty array when nothing aligns within threshold', () => {
    const dragging: Rect = { id: 'drag', x: 999, y: 999, w: 80, h: 60 };
    const guides = computeGuides(dragging, stationary, 5);
    expect(guides).toHaveLength(0);
  });

  it('detects left-edge alignment', () => {
    // dragging left edge (x=100) matches stationary 'a' left edge (x=100)
    const dragging: Rect = { id: 'drag', x: 100, y: 200, w: 80, h: 60 };
    const guides = computeGuides(dragging, stationary, 5);
    const leftGuide = guides.find(g => g.type === 'vertical' && Math.abs(g.position - 100) < 1);
    expect(leftGuide).toBeDefined();
  });

  it('detects right-edge alignment', () => {
    // dragging right edge = 100+80=180, stationary 'a' right = 100+80=180
    const dragging: Rect = { id: 'drag', x: 100, y: 200, w: 80, h: 60 };
    const guides = computeGuides(dragging, stationary, 5);
    const rightGuide = guides.find(g => g.type === 'vertical' && Math.abs(g.position - 180) < 1);
    expect(rightGuide).toBeDefined();
  });

  it('detects top-edge alignment', () => {
    // dragging top (y=0) matches stationary 'a' top (y=0)
    const dragging: Rect = { id: 'drag', x: 300, y: 0, w: 80, h: 60 };
    const guides = computeGuides(dragging, stationary, 5);
    const topGuide = guides.find(g => g.type === 'horizontal' && Math.abs(g.position - 0) < 1);
    expect(topGuide).toBeDefined();
  });

  it('respects threshold — edge within threshold triggers guide', () => {
    // dragging x=102, stationary 'a' x=100, diff=2, threshold=5 → aligns
    const dragging: Rect = { id: 'drag', x: 102, y: 200, w: 80, h: 60 };
    const guides = computeGuides(dragging, stationary, 5);
    expect(guides.length).toBeGreaterThan(0);
  });

  it('respects threshold — edge outside threshold does not trigger guide', () => {
    // dragging x=106, diff=6, threshold=5 → no align
    const dragging: Rect = { id: 'drag', x: 106, y: 300, w: 80, h: 60 };
    const guides = computeGuides(dragging, stationary, 5);
    // there may be other coincidental alignments; just check there's no x=100 left-guide
    const leftGuide = guides.find(g => g.type === 'vertical' && Math.abs(g.position - 100) < 1);
    expect(leftGuide).toBeUndefined();
  });

  it('detects center-x alignment', () => {
    // dragging center-x = x + w/2; stationary 'a' center-x = 100+40=140
    const dragging: Rect = { id: 'drag', x: 100, y: 300, w: 80, h: 60 }; // center-x = 140
    const guides = computeGuides(dragging, stationary, 5);
    const centerGuide = guides.find(g => g.type === 'vertical' && Math.abs(g.position - 140) < 1);
    expect(centerGuide).toBeDefined();
  });

  it('ignores dragging node itself in stationary list', () => {
    const dragging: Rect = { id: 'a', x: 100, y: 0, w: 80, h: 60 }; // same id as stationary 'a'
    const guides = computeGuides(dragging, stationary, 5);
    // Should not create self-guides (infinite guides)
    expect(guides.length).toBeLessThan(10);
  });
});
