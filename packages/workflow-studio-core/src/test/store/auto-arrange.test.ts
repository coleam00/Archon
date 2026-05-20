import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';
import { useUndoStore, resetCoalesceState } from '../../store/undo-store';

const makeNode = (id: string, deps: string[] = []) => ({
  id,
  variant: 'bash' as const,
  data: {},
  base: { depends_on: deps },
  unknown: {},
});

describe('autoArrangeSelection', () => {
  beforeEach(() => {
    resetCoalesceState();
    useBuilderStore.setState({
      nodes: [makeNode('a'), makeNode('b', ['a']), makeNode('c', ['a'])],
      selectedNodeIds: ['a', 'b', 'c'],
      primarySelectionId: 'c',
      positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 } },
    });
    useUndoStore.setState({ past: [], future: [] });
  });
  afterEach(() => {
    useBuilderStore.setState({
      nodes: [],
      selectedNodeIds: [],
      primarySelectionId: null,
      positions: {},
    });
    useUndoStore.setState({ past: [], future: [] });
  });

  it('autoArrangeSelection updates positions for selected nodes', () => {
    useBuilderStore.getState().autoArrangeSelection();
    const { positions } = useBuilderStore.getState();
    // Positions should be non-trivially different after layout (dagre spreads them out)
    expect(positions['a']).toBeDefined();
    expect(positions['b']).toBeDefined();
    expect(positions['c']).toBeDefined();
    // b and c should not be at exactly the same position as a
    expect(
      positions['b'].x !== 0 ||
        positions['b'].y !== 0 ||
        positions['a'].x !== positions['b'].x ||
        positions['a'].y !== positions['b'].y
    ).toBe(true);
  });

  it('autoArrangeSelection pushes an undo snapshot', () => {
    useBuilderStore.getState().autoArrangeSelection();
    expect(useUndoStore.getState().past.length).toBeGreaterThanOrEqual(1);
  });

  it('autoArrangeSelection is a no-op when nothing selected', () => {
    useBuilderStore.getState().clearSelection();
    useUndoStore.setState({ past: [], future: [] });
    useBuilderStore.getState().autoArrangeSelection();
    expect(useUndoStore.getState().past).toHaveLength(0);
  });
});
