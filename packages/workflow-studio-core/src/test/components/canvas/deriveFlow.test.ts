import { describe, it, expect } from 'bun:test';
import { deriveFlow } from '../../../components/canvas/deriveFlow';
import type { BuilderNode } from '../../../nodes/shared/types';

const node = (over: Partial<BuilderNode>): BuilderNode => ({
  id: 'x',
  variant: 'command',
  data: {},
  base: {},
  unknown: {},
  ...over,
});

describe('deriveFlow', () => {
  // 1. Rewritten: type === variant id (was 'dag').
  it("emits one rfNode per store node, type === each node's variant id", () => {
    const { rfNodes } = deriveFlow(
      [
        node({ id: 'a', variant: 'command' }),
        node({ id: 'b', variant: 'loop', data: { loop: {} } }),
      ],
      new Map()
    );
    expect(rfNodes).toHaveLength(2);
    expect(rfNodes.find(n => n.id === 'a')?.type).toBe('command');
    expect(rfNodes.find(n => n.id === 'b')?.type).toBe('loop');
  });

  // 2. Rewritten: full BuilderNode pass-through on rfNode.data.node.
  it('passes the full BuilderNode through on rfNode.data.node', () => {
    const src = node({
      id: 'a',
      variant: 'loop',
      data: { loop: { max_iterations: 5, prompt: 'p', until: 'COMPLETE' } },
    });
    const { rfNodes } = deriveFlow([src], new Map());
    expect(rfNodes[0].data.node).toBe(src); // identity, not deep-clone — pure projection
    expect(rfNodes[0].data.storeId).toBe('a');
  });

  // 3-6. Copied verbatim from Phase 2 Task 32 — bodies unchanged.
  it('uses position map when present, defaults to {x:0,y:0} otherwise', () => {
    const { rfNodes } = deriveFlow(
      [node({ id: 'a' }), node({ id: 'b' })],
      new Map([['a', { x: 100, y: 200 }]])
    );
    expect(rfNodes.find(n => n.id === 'a')?.position).toEqual({ x: 100, y: 200 });
    expect(rfNodes.find(n => n.id === 'b')?.position).toEqual({ x: 0, y: 0 });
  });

  it('emits one edge per depends_on entry with id "<source>-><target>"', () => {
    const { rfEdges } = deriveFlow(
      [
        node({ id: 'a' }),
        node({ id: 'b', base: { depends_on: ['a'] } }),
        node({ id: 'c', base: { depends_on: ['a', 'b'] } }),
      ],
      new Map()
    );
    expect(rfEdges.map(e => e.id).sort()).toEqual(['a->b', 'a->c', 'b->c']);
    expect(rfEdges.every(e => e.type === 'smoothstep')).toBe(true);
  });

  it('marks edges as dashed-purple when the TARGET has a when: string', () => {
    const { rfEdges } = deriveFlow(
      [
        node({ id: 'a' }),
        node({ id: 'b', base: { depends_on: ['a'], when: "$a.output == 'go'" } }),
      ],
      new Map()
    );
    const e = rfEdges.find(e => e.id === 'a->b')!;
    expect(e.style?.strokeDasharray).toBeDefined();
    expect(e.style?.stroke).toBe('var(--studio-when)');
  });

  it('skips depends_on entries whose source is missing (defensive)', () => {
    const { rfEdges } = deriveFlow([node({ id: 'b', base: { depends_on: ['ghost'] } })], new Map());
    expect(rfEdges).toHaveLength(0);
  });
});
