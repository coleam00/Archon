import { describe, it, expect } from 'bun:test';
import {
  makeOnNodesChange,
  makeOnConnect,
  makeOnEdgesDelete,
  makeOnNodesDelete,
} from '../../../components/canvas/canvasHandlers';
import type { UsePositionPersistence } from '../../../hooks/usePositionPersistence';

const stubPositions = (): UsePositionPersistence & { _calls: unknown[][] } => {
  const map = new Map<string, { x: number; y: number }>();
  const calls: unknown[][] = [];
  return {
    positions: map,
    setPosition: (id, pos) => {
      calls.push(['setPosition', id, pos]);
      map.set(id, pos);
    },
    setMany: entries => {
      calls.push(['setMany', entries]);
      for (const [id, p] of entries) map.set(id, p);
    },
    reset: () => {
      calls.push(['reset']);
      map.clear();
    },
    _calls: calls,
  } as UsePositionPersistence & { _calls: unknown[][] };
};

describe('makeOnNodesChange', () => {
  it('persists ONLY for position changes with dragging === false', () => {
    const positions = stubPositions();
    const onChange = makeOnNodesChange(positions);

    onChange([
      // mid-drag: should NOT persist
      { type: 'position', id: 'a', dragging: true, position: { x: 5, y: 5 } } as any,
      // selection / dimensions: should NOT persist
      { type: 'select', id: 'a', selected: true } as any,
      { type: 'dimensions', id: 'a', dimensions: { width: 180, height: 80 } } as any,
      // drag end: SHOULD persist
      { type: 'position', id: 'a', dragging: false, position: { x: 10, y: 20 } } as any,
    ]);

    const setPositionCalls = positions._calls.filter(c => c[0] === 'setPosition');
    expect(setPositionCalls).toHaveLength(1);
    expect(setPositionCalls[0]).toEqual(['setPosition', 'a', { x: 10, y: 20 }]);
  });

  it('skips position changes that lack a position object', () => {
    const positions = stubPositions();
    const onChange = makeOnNodesChange(positions);
    onChange([{ type: 'position', id: 'a', dragging: false } as any]);
    expect(positions._calls.filter(c => c[0] === 'setPosition')).toHaveLength(0);
  });
});

describe('makeOnConnect', () => {
  it('calls store.connect with source/target when both present', () => {
    const calls: unknown[] = [];
    const onConnect = makeOnConnect((s, t) => calls.push([s, t]));
    onConnect({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null } as any);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('ignores self-connections and missing endpoints', () => {
    const calls: unknown[] = [];
    const onConnect = makeOnConnect((s, t) => calls.push([s, t]));
    onConnect({ source: 'a', target: 'a' } as any); // self
    onConnect({ source: null, target: 'b' } as any); // missing source
    onConnect({ source: 'a', target: null } as any); // missing target
    expect(calls).toEqual([]);
  });
});

describe('makeOnEdgesDelete', () => {
  it('calls store.disconnect once per edge', () => {
    const calls: unknown[] = [];
    const onDelete = makeOnEdgesDelete((s, t) => calls.push([s, t]));
    onDelete([
      { id: 'a->b', source: 'a', target: 'b' } as any,
      { id: 'a->c', source: 'a', target: 'c' } as any,
    ]);
    expect(calls).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
  });
});

describe('makeOnNodesDelete', () => {
  it('calls store.deleteNodes with the array of ids', () => {
    const calls: unknown[] = [];
    const onDelete = makeOnNodesDelete(ids => calls.push(ids));
    onDelete([{ id: 'a' } as any, { id: 'b' } as any]);
    expect(calls).toEqual([['a', 'b']]);
  });
});
