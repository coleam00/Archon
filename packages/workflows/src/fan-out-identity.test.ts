import { describe, test, expect } from 'bun:test';
import {
  buildInstanceSnapshots,
  composeFanOutScopeSegment,
  composeInstanceIdentity,
} from './fan-out-identity';

describe('fan-out-identity (#2512)', () => {
  test('identity is content-derived, not position-derived', () => {
    const [a] = buildInstanceSnapshots(['x']);
    const reordered = buildInstanceSnapshots([{ nested: true }, 'x']);
    expect(a?.identity).toBeDefined();
    // Same value at a different ordinal keeps its identity.
    expect(reordered.map(s => s.identity)).toContain(a?.identity);
  });

  test('distinct values yield distinct identities', () => {
    const snaps = buildInstanceSnapshots(['alpha', 'beta', 1, true, null, { k: 1 }]);
    const identities = new Set(snaps.map(s => s.identity));
    expect(identities.size).toBe(snaps.length);
  });

  test('byte-identical duplicates get occurrence ordinals', () => {
    const three = buildInstanceSnapshots(['dup', 'dup', 'dup']);
    expect(three[0]?.identity).not.toBe(three[1]?.identity);
    expect(three[0]?.identity).not.toBe(three[2]?.identity);
    // Removing a duplicate copy renumbers survivors — safe, because byte-identical
    // items are observationally interchangeable.
    const two = buildInstanceSnapshots(['dup', 'dup']);
    expect(two[0]?.identity).toBe(three[0]?.identity);
    expect(two[1]?.identity).toBe(three[1]?.identity);
  });

  test('object identity follows JSON serialization (key order matters)', () => {
    expect(composeInstanceIdentity({ a: 1, b: 2 }, 0)).toBe(
      composeInstanceIdentity({ a: 1, b: 2 }, 0)
    );
    expect(composeInstanceIdentity({ a: 1 }, 0)).not.toBe(composeInstanceIdentity({ a: 2 }, 0));
  });

  test('snapshots preserve input order in ordinals', () => {
    const snaps = buildInstanceSnapshots([3, 1, 2]);
    expect(snaps.map(s => s.ordinal)).toEqual([0, 1, 2]);
    expect(snaps.map(s => s.item)).toEqual([3, 1, 2]);
  });

  test('snapshots freeze the complete resolved input map for each item', () => {
    const snaps = buildInstanceSnapshots(['a', 'b'], { seed: 7 }, 'file');
    expect(snaps.map(snapshot => snapshot.inputs)).toEqual([
      { seed: 7, file: 'a' },
      { seed: 7, file: 'b' },
    ]);
  });

  test('scope identity separates enclosing loop iterations without ambiguous concatenation', () => {
    const first = composeFanOutScopeSegment('fan', [{ groupId: 'group1', iteration: 2 }]);
    const second = composeFanOutScopeSegment('fan', [{ groupId: 'group', iteration: 12 }]);
    expect(first).not.toBe(second);
    expect(composeFanOutScopeSegment('fan', [])).toContain('root');
  });
});
