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
      { nodeId: 'a', status: 'completed' },
      { nodeId: 'b', status: 'pending' },
    ];
    expect(selectInitialNode(nodes)).toBe('a');
  });

  it('prefers running node over first node', () => {
    const nodes = [
      { nodeId: 'a', status: 'completed' },
      { nodeId: 'b', status: 'running' },
    ];
    expect(selectInitialNode(nodes)).toBe('b');
  });

  it('returns first running node when multiple are running', () => {
    const nodes = [
      { nodeId: 'a', status: 'running' },
      { nodeId: 'b', status: 'running' },
    ];
    expect(selectInitialNode(nodes)).toBe('a');
  });
});
