import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, act } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from '../../components/Canvas';
import { useBuilderStore } from '../../store/builder-store';
import { PositionProvider } from '../../hooks/PositionContext';
import type { UsePositionPersistence } from '../../hooks/usePositionPersistence';

beforeEach(() => {
  useBuilderStore.getState().clearWorkflow();
  globalThis.localStorage?.clear();
});

// Bun:test runs all spec files sequentially in one process — without explicit
// cleanup, rendered DOM bleeds into the next file's tests.
afterEach(() => {
  cleanup();
});

const stubPositionsHook = (): UsePositionPersistence & { _calls: unknown[][] } => {
  const map = new Map<string, { x: number; y: number }>();
  const calls: unknown[][] = [];
  return {
    positions: map,
    setPosition: (id, pos) => {
      calls.push(['setPosition', id, pos]);
      map.set(id, pos);
    },
    setMany: entries => {
      const arr = Array.from(entries);
      calls.push(['setMany', arr]);
      for (const [id, p] of arr) map.set(id, p);
    },
    reset: () => {
      calls.push(['reset']);
      map.clear();
    },
    _calls: calls,
  } as UsePositionPersistence & { _calls: unknown[][] };
};

const seedTwoNodes = () => {
  useBuilderStore.getState().loadWorkflow({
    meta: { name: 'w', description: 'd', base: {}, unknown: {} },
    nodes: [
      { id: 'a', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} },
      {
        id: 'b',
        variant: 'command',
        data: { command: 'bar' },
        base: { depends_on: ['a'] },
        unknown: {},
      },
    ],
  });
};

describe('Canvas', () => {
  it('renders one node per store node, dispatched by variant', () => {
    seedTwoNodes();
    const positions = stubPositionsHook();
    const { container } = render(
      <PositionProvider value={positions}>
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </PositionProvider>
    );
    // Each command node's NodeShell tags itself with data-variant="command".
    // React Flow renders each node twice (visible + hidden measurement); accept ≥2.
    expect(container.querySelectorAll('[data-variant="command"]').length).toBeGreaterThan(0);
    // React Flow tags each rendered node with data-id; both store ids should appear.
    expect(container.querySelector('[data-id="a"]')).toBeDefined();
    expect(container.querySelector('[data-id="b"]')).toBeDefined();
  });

  it('seeds dagre positions for nodes missing from the persistence map', () => {
    seedTwoNodes();
    const positions = stubPositionsHook();
    render(
      <PositionProvider value={positions}>
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </PositionProvider>
    );
    const setManyCall = positions._calls.find(c => c[0] === 'setMany');
    expect(setManyCall).toBeDefined();
    const entries = setManyCall![1] as [string, { x: number; y: number }][];
    expect(entries.map(([id]) => id).sort()).toEqual(['a', 'b']);
  });

  it('does not re-seed nodes that already have a persisted position', () => {
    seedTwoNodes();
    const positions = stubPositionsHook();
    positions.positions.set('a', { x: 999, y: 999 });
    render(
      <PositionProvider value={positions}>
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </PositionProvider>
    );
    const setManyCall = positions._calls.find(c => c[0] === 'setMany');
    if (setManyCall) {
      const entries = setManyCall[1] as [string, { x: number; y: number }][];
      const ids = entries.map(([id]) => id);
      expect(ids).not.toContain('a');
      expect(ids).toContain('b');
    }
  });

  it('re-renders the per-variant Renderer when inspector edits the BuilderNode data', () => {
    seedTwoNodes();
    const positions = stubPositionsHook();
    positions.positions.set('a', { x: 0, y: 0 });
    positions.positions.set('b', { x: 100, y: 100 });
    const { container } = render(
      <PositionProvider value={positions}>
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </PositionProvider>
    );
    // Sanity: the command-variant label is the data.command value when present.
    expect(container.textContent).toContain('foo');

    act(() => {
      useBuilderStore.getState().updateNodeData('a', { command: 'renamed-cmd' });
    });

    // Without the canvas-rehydrate-on-data-change fix, rfNodes still holds a
    // stale `data.node` reference and the Renderer keeps painting "foo".
    expect(container.textContent).toContain('renamed-cmd');
    expect(container.textContent).not.toContain('foo');
  });

  it('re-renders the canvas when a node is renamed via store.renameNode', () => {
    seedTwoNodes();
    const positions = stubPositionsHook();
    positions.positions.set('a', { x: 0, y: 0 });
    positions.positions.set('b', { x: 100, y: 100 });
    const { container } = render(
      <PositionProvider value={positions}>
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </PositionProvider>
    );
    expect(container.querySelector('[data-id="a"]')).toBeDefined();

    act(() => {
      useBuilderStore.getState().renameNode('a', 'aprime');
    });

    expect(container.querySelector('[data-id="aprime"]')).toBeDefined();
    expect(container.querySelector('[data-id="a"]')).toBeNull();
  });
});
