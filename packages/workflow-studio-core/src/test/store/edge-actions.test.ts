import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';
import { useUndoStore, resetCoalesceState } from '../../store/undo-store';

const makeNode = (id: string, depends_on?: string[]) => ({
  id,
  variant: 'bash' as const,
  data: {},
  base: depends_on ? { depends_on } : {},
  unknown: {},
});

const reset = (): void => {
  useBuilderStore.setState({
    nodes: [],
    positions: {},
    selectedNodeIds: [],
    primarySelectionId: null,
    selectedEdgeId: null,
    hoveredEdgeId: null,
  });
  useUndoStore.setState({ past: [], future: [] });
  resetCoalesceState();
};

describe('edge actions', () => {
  beforeEach(reset);
  afterEach(reset);

  describe('connect / disconnect', () => {
    it('disconnect removes a dep and deletes the depends_on key entirely when emptied', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });

      useBuilderStore.getState().disconnect('a', 'b');

      const b = useBuilderStore.getState().nodes.find(n => n.id === 'b')!;
      expect(b.base).not.toHaveProperty('depends_on');
    });

    it('disconnect preserves depends_on with remaining entries', () => {
      useBuilderStore.setState({
        nodes: [makeNode('a'), makeNode('b'), makeNode('c', ['a', 'b'])],
      });

      useBuilderStore.getState().disconnect('a', 'c');

      const c = useBuilderStore.getState().nodes.find(n => n.id === 'c')!;
      expect(c.base.depends_on).toEqual(['b']);
    });

    it('disconnect is a no-op (no undo push) when the edge does not exist', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b')] });

      useBuilderStore.getState().disconnect('a', 'b');

      expect(useUndoStore.getState().past).toHaveLength(0);
    });

    it('connect adds a dep and pushes an undo snapshot', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b')] });

      useBuilderStore.getState().connect('a', 'b');

      const b = useBuilderStore.getState().nodes.find(n => n.id === 'b')!;
      expect(b.base.depends_on).toEqual(['a']);
      expect(useUndoStore.getState().past).toHaveLength(1);
      expect(useUndoStore.getState().past[0].label).toBe('connect edge');
    });

    it('connect is a no-op (no undo push) when the edge already exists', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });

      useBuilderStore.getState().connect('a', 'b');

      expect(useUndoStore.getState().past).toHaveLength(0);
    });

    it('disconnect → applyUndo round-trip restores the depends_on array', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });

      useBuilderStore.getState().disconnect('a', 'b');
      expect(useBuilderStore.getState().nodes.find(n => n.id === 'b')!.base).not.toHaveProperty(
        'depends_on'
      );

      useBuilderStore.getState().applyUndo();
      expect(useBuilderStore.getState().nodes.find(n => n.id === 'b')!.base.depends_on).toEqual([
        'a',
      ]);
    });
  });

  describe('setSelectedEdge — mutual exclusivity with node selection', () => {
    it('selecting an edge clears node selection', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });
      useBuilderStore.getState().setSelection(['a', 'b']);
      expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);

      useBuilderStore.getState().setSelectedEdge('a->b');

      expect(useBuilderStore.getState().selectedEdgeId).toBe('a->b');
      expect(useBuilderStore.getState().selectedNodeIds).toEqual([]);
      expect(useBuilderStore.getState().primarySelectionId).toBeNull();
    });

    it('selecting a node clears edge selection', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });
      useBuilderStore.getState().setSelectedEdge('a->b');

      useBuilderStore.getState().setSelection(['a']);

      expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a']);
      expect(useBuilderStore.getState().selectedEdgeId).toBeNull();
    });

    it('addToSelection (shift-click) also clears edge selection', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });
      useBuilderStore.getState().setSelectedEdge('a->b');

      useBuilderStore.getState().addToSelection('a');

      expect(useBuilderStore.getState().selectedEdgeId).toBeNull();
    });

    it('clearSelection clears both nodes and edge', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });
      useBuilderStore.getState().setSelection(['a']);
      useBuilderStore.getState().setSelectedEdge('a->b');

      useBuilderStore.getState().clearSelection();

      expect(useBuilderStore.getState().selectedNodeIds).toEqual([]);
      expect(useBuilderStore.getState().selectedEdgeId).toBeNull();
    });

    it('setHoveredEdge stores and clears the hovered id', () => {
      useBuilderStore.getState().setHoveredEdge('a->b');
      expect(useBuilderStore.getState().hoveredEdgeId).toBe('a->b');
      useBuilderStore.getState().setHoveredEdge(null);
      expect(useBuilderStore.getState().hoveredEdgeId).toBeNull();
    });

    it('setHoveredEdge does NOT clear node selection (independent state)', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });
      useBuilderStore.getState().setSelection(['a']);

      useBuilderStore.getState().setHoveredEdge('a->b');

      expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a']);
      expect(useBuilderStore.getState().hoveredEdgeId).toBe('a->b');
    });

    it('setSelectedEdge(null) clears edge but does not touch node selection', () => {
      useBuilderStore.setState({ nodes: [makeNode('a'), makeNode('b', ['a'])] });
      useBuilderStore.getState().setSelection(['a']);
      useBuilderStore.setState({ selectedEdgeId: 'a->b' }); // bypass mutual-exclusion guard

      useBuilderStore.getState().setSelectedEdge(null);

      expect(useBuilderStore.getState().selectedEdgeId).toBeNull();
      expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a']);
    });
  });
});
