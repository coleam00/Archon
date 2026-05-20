import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';
import { useUndoStore, resetCoalesceState } from '../../store/undo-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeNode = (id: string, deps: string[] = [], variant: 'bash' | 'command' = 'bash') => ({
  id,
  variant,
  data: { cmd: 'echo test' },
  base: deps.length ? { depends_on: deps } : {},
  unknown: {},
});

const resetStores = () => {
  useBuilderStore.setState({
    nodes: [],
    selectedNodeIds: [],
    primarySelectionId: null,
    positions: {},
    clipboard: null,
    workflow: null,
    baselineYaml: null,
  });
  useUndoStore.setState({ past: [], future: [] });
  resetCoalesceState();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase-8 integration round-trips', () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  // -------------------------------------------------------------------------
  // Test 1: copy → paste → undo → redo round-trip
  // -------------------------------------------------------------------------
  it('copy → paste → undo → redo round-trip', async () => {
    // Set up 2 nodes: b depends_on a
    useBuilderStore.setState({
      nodes: [makeNode('a'), makeNode('b', ['a'])],
      selectedNodeIds: ['a', 'b'],
      primarySelectionId: 'b',
      positions: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    });

    // copy then paste → 4 nodes
    await useBuilderStore.getState().copySelection();
    expect(useBuilderStore.getState().clipboard).not.toBeNull();
    await useBuilderStore.getState().pasteClipboard();
    expect(useBuilderStore.getState().nodes).toHaveLength(4);

    // undo → 2 nodes (paste undone)
    useBuilderStore.getState().applyUndo();
    expect(useBuilderStore.getState().nodes).toHaveLength(2);
    expect(useUndoStore.getState().past).toHaveLength(0);

    // redo → 4 nodes (paste redone)
    useBuilderStore.getState().applyRedo();
    expect(useBuilderStore.getState().nodes).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // Test 2: multi-select sequence
  // -------------------------------------------------------------------------
  it('multi-select sequence', () => {
    useBuilderStore.setState({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      selectedNodeIds: [],
      primarySelectionId: null,
      positions: {},
    });

    // setSelection(['a', 'b']) → selectedNodeIds = ['a', 'b'], primarySelectionId = 'b'
    useBuilderStore.getState().setSelection(['a', 'b']);
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);
    expect(useBuilderStore.getState().primarySelectionId).toBe('b');

    // addToSelection('c') → length 3, primary = 'c'
    useBuilderStore.getState().addToSelection('c');
    expect(useBuilderStore.getState().selectedNodeIds).toHaveLength(3);
    expect(useBuilderStore.getState().primarySelectionId).toBe('c');

    // removeFromSelection('b') → length 2, primary = 'c'
    useBuilderStore.getState().removeFromSelection('b');
    expect(useBuilderStore.getState().selectedNodeIds).toHaveLength(2);
    expect(useBuilderStore.getState().primarySelectionId).toBe('c');
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'c']);

    // clearSelection() → empty
    useBuilderStore.getState().clearSelection();
    expect(useBuilderStore.getState().selectedNodeIds).toHaveLength(0);
    expect(useBuilderStore.getState().primarySelectionId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3: auto-arrange preserves nodes outside selection
  // -------------------------------------------------------------------------
  it('auto-arrange preserves nodes outside selection', () => {
    useBuilderStore.setState({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      selectedNodeIds: ['a', 'b'],
      primarySelectionId: 'b',
      positions: {
        a: { x: 0, y: 0 },
        b: { x: 100, y: 0 },
        c: { x: 999, y: 888 },
      },
    });

    useBuilderStore.getState().autoArrangeSelection();

    // node c position must be unchanged
    const positions = useBuilderStore.getState().positions;
    expect(positions['c']).toEqual({ x: 999, y: 888 });
  });

  // -------------------------------------------------------------------------
  // Test 4: loadWorkflow clears undo stack
  // -------------------------------------------------------------------------
  it('loadWorkflow clears undo stack', () => {
    // Push a snapshot to undo stack
    useUndoStore.getState().push({
      label: 'some action',
      workflow: null,
      nodes: [makeNode('x')],
      positions: { x: { x: 0, y: 0 } },
    });
    expect(useUndoStore.getState().past).toHaveLength(1);

    // Call loadWorkflow
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'test', description: '', base: {}, unknown: {} },
      nodes: [makeNode('alpha')],
    });

    // undo stack should be empty
    expect(useUndoStore.getState().past).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: convertVariant undo/redo
  // -------------------------------------------------------------------------
  it('convertVariant undo/redo', () => {
    useBuilderStore.setState({
      nodes: [makeNode('node1', [], 'bash')],
      selectedNodeIds: [],
      primarySelectionId: null,
      positions: {},
    });

    // node starts as 'bash'
    expect(useBuilderStore.getState().nodes[0].variant).toBe('bash');

    // convertVariant → 'command'
    resetCoalesceState(); // ensure snapshot is pushed
    useBuilderStore.getState().convertVariant('node1', 'command');
    expect(useBuilderStore.getState().nodes[0].variant).toBe('command');
    expect(useUndoStore.getState().past.length).toBeGreaterThanOrEqual(1);

    // applyUndo → variant = 'bash'
    useBuilderStore.getState().applyUndo();
    expect(useBuilderStore.getState().nodes[0].variant).toBe('bash');

    // applyRedo → variant = 'command'
    useBuilderStore.getState().applyRedo();
    expect(useBuilderStore.getState().nodes[0].variant).toBe('command');
  });

  // -------------------------------------------------------------------------
  // Test 6: align → undo restores positions
  // -------------------------------------------------------------------------
  it('align → undo restores positions', () => {
    useBuilderStore.setState({
      nodes: [makeNode('p'), makeNode('q')],
      selectedNodeIds: ['p', 'q'],
      primarySelectionId: 'q',
      positions: {
        p: { x: 50, y: 10 },
        q: { x: 200, y: 20 },
      },
    });

    // alignSelection('left') → both at leftmost x (50)
    useBuilderStore.getState().alignSelection('left');
    const posAfterAlign = useBuilderStore.getState().positions;
    expect(posAfterAlign['p'].x).toBe(50);
    expect(posAfterAlign['q'].x).toBe(50);
    expect(posAfterAlign['p'].y).toBe(10);
    expect(posAfterAlign['q'].y).toBe(20);

    // applyUndo → positions restored
    useBuilderStore.getState().applyUndo();
    const posAfterUndo = useBuilderStore.getState().positions;
    expect(posAfterUndo['p']).toEqual({ x: 50, y: 10 });
    expect(posAfterUndo['q']).toEqual({ x: 200, y: 20 });
  });
});
