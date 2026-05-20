import { describe, expect, it } from 'bun:test';
import { transitiveUpstream } from '../../../components/when/transitiveUpstream';

describe('transitiveUpstream', () => {
  const nodes = [
    { id: 'a', base: { depends_on: [] } },
    { id: 'b', base: { depends_on: ['a'] } },
    { id: 'c', base: { depends_on: ['b'] } },
    { id: 'd', base: { depends_on: ['a', 'c'] } },
    { id: 'e', base: { depends_on: [] } },
  ];

  it('returns ancestors via depends_on', () => {
    expect(new Set(transitiveUpstream('d', nodes))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns empty for a root node', () => {
    expect(transitiveUpstream('a', nodes)).toEqual([]);
  });

  it('does not include the node itself', () => {
    expect(transitiveUpstream('c', nodes)).not.toContain('c');
  });

  it('handles missing depends_on (treats as empty)', () => {
    expect(transitiveUpstream('e', [{ id: 'e', base: {} }])).toEqual([]);
  });

  it('does not loop forever on cyclic depends_on (defensive)', () => {
    const cyclic = [
      { id: 'x', base: { depends_on: ['y'] } },
      { id: 'y', base: { depends_on: ['x'] } },
    ];
    expect(() => transitiveUpstream('x', cyclic)).not.toThrow();
  });
});
