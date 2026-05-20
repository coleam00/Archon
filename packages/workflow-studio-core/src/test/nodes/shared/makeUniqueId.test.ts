import { describe, it, expect } from 'bun:test';
import { makeUniqueId } from '../../../nodes/shared/makeUniqueId';

describe('makeUniqueId', () => {
  it('returns the hint unchanged when free', () => {
    expect(makeUniqueId('classify', new Set())).toBe('classify');
    expect(makeUniqueId('classify', new Set(['other']))).toBe('classify');
  });

  it('appends -2 on first collision', () => {
    expect(makeUniqueId('classify', new Set(['classify']))).toBe('classify-2');
  });

  it('keeps incrementing past existing -N suffixes', () => {
    expect(makeUniqueId('x', new Set(['x', 'x-2', 'x-3']))).toBe('x-4');
  });

  it('does not collide with sibling roots that share a prefix', () => {
    expect(makeUniqueId('foo', new Set(['foo-bar', 'foo-bar-2']))).toBe('foo');
    // 'foo-bar' must not block 'foo' itself.
  });

  it('handles non-numeric suffixes that look like our scheme', () => {
    expect(makeUniqueId('x', new Set(['x', 'x-banana']))).toBe('x-2');
  });
});
