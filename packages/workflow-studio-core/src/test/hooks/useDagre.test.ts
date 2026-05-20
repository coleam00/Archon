import { describe, it, expect } from 'bun:test';
import { layoutWithDagre } from '../../hooks/useDagre';

describe('layoutWithDagre', () => {
  it('returns one position per node id', () => {
    const positions = layoutWithDagre(
      [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 0, y: 0 } },
      ],
      [{ id: 'a->b', source: 'a', target: 'b' }]
    );
    expect(positions.size).toBe(2);
    expect(positions.has('a')).toBe(true);
    expect(positions.has('b')).toBe(true);
  });

  it('lays out top-to-bottom: parent above child given rankdir TB', () => {
    const positions = layoutWithDagre(
      [
        { id: 'parent', position: { x: 0, y: 0 } },
        { id: 'child', position: { x: 0, y: 0 } },
      ],
      [{ id: 'p->c', source: 'parent', target: 'child' }]
    );
    expect(positions.get('parent')!.y).toBeLessThan(positions.get('child')!.y);
  });

  it('separates siblings horizontally given nodesep 40', () => {
    const positions = layoutWithDagre(
      [
        { id: 'root', position: { x: 0, y: 0 } },
        { id: 'left', position: { x: 0, y: 0 } },
        { id: 'right', position: { x: 0, y: 0 } },
      ],
      [
        { id: 'r->l', source: 'root', target: 'left' },
        { id: 'r->r', source: 'root', target: 'right' },
      ]
    );
    expect(positions.get('left')!.x).not.toEqual(positions.get('right')!.x);
  });

  it('handles disconnected nodes (no edges)', () => {
    const positions = layoutWithDagre(
      [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 0, y: 0 } },
      ],
      []
    );
    expect(positions.size).toBe(2);
  });

  it('returns empty map for empty input', () => {
    expect(layoutWithDagre([], []).size).toBe(0);
  });
});
