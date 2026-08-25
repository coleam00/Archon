import { describe, expect, it } from 'bun:test';
import { selectInitialNode } from './select-initial-node';

describe('selectInitialNode', () => {
  it('returns null for undefined nodes', () => {
    expect(selectInitialNode(undefined)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(selectInitialNode([])).toBeNull();
  });

  it('returns first node when none are running', () => {
    const nodes = [
      { nodeId: 'a', status: 'completed' as const },
      { nodeId: 'b', status: 'pending' as const },
    ];
    expect(selectInitialNode(nodes)).toBe('a');
  });

  it('prefers running node over first node', () => {
    const nodes = [
      { nodeId: 'a', status: 'completed' as const },
      { nodeId: 'b', status: 'running' as const },
    ];
    expect(selectInitialNode(nodes)).toBe('b');
  });

  it('prefers a queued node over completed work', () => {
    const nodes = [
      { nodeId: 'a', status: 'completed' as const },
      { nodeId: 'b', status: 'queued' as const },
    ];
    expect(selectInitialNode(nodes)).toBe('b');
  });

  it('returns first running node when multiple are running', () => {
    const nodes = [
      { nodeId: 'a', status: 'running' as const },
      { nodeId: 'b', status: 'running' as const },
    ];
    expect(selectInitialNode(nodes)).toBe('a');
  });
});
