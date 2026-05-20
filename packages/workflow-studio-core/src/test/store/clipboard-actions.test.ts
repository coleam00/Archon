import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';
import { useUndoStore, resetCoalesceState } from '../../store/undo-store';

const makeNode = (id: string, deps: string[] = []) => ({
  id,
  variant: 'bash' as const,
  data: { cmd: 'test' },
  base: { depends_on: deps },
  unknown: {},
});

describe('copySelection + pasteClipboard', () => {
  beforeEach(() => {
    resetCoalesceState();
    useBuilderStore.setState({
      nodes: [makeNode('a', []), makeNode('b', ['a'])],
      selectedNodeIds: ['a', 'b'],
      primarySelectionId: 'b',
      positions: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    });
    useUndoStore.setState({ past: [], future: [] });
  });
  afterEach(() => {
    useBuilderStore.setState({
      nodes: [],
      selectedNodeIds: [],
      primarySelectionId: null,
      positions: {},
      clipboard: null,
    });
    useUndoStore.setState({ past: [], future: [] });
  });

  it('copySelection stores selected nodes in clipboard', async () => {
    await useBuilderStore.getState().copySelection();
    // clipboard now has nodes a and b
    await useBuilderStore.getState().pasteClipboard();
    const { nodes } = useBuilderStore.getState();
    expect(nodes).toHaveLength(4); // original 2 + pasted 2
  });

  it('pasted nodes get new IDs (no ID collision)', async () => {
    await useBuilderStore.getState().copySelection();
    await useBuilderStore.getState().pasteClipboard();
    const { nodes } = useBuilderStore.getState();
    const ids = nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.includes('a')).toBe(true); // originals still present
    expect(ids.includes('b')).toBe(true);
  });

  it('pasted nodes depends_on references are remapped to new ids', async () => {
    await useBuilderStore.getState().copySelection();
    await useBuilderStore.getState().pasteClipboard();
    const { nodes } = useBuilderStore.getState();
    // find pasted 'b' clone — it should depend on pasted 'a' clone, not original 'a'
    const origIds = new Set(['a', 'b']);
    const pastedNodes = nodes.filter(n => !origIds.has(n.id));
    const pastedB = pastedNodes.find(n => (n.base?.depends_on?.length ?? 0) > 0);
    if (pastedB) {
      const dep = pastedB.base.depends_on[0];
      expect(origIds.has(dep)).toBe(false); // points to new id, not 'a'
    }
  });

  it('paste pushes an undo snapshot', async () => {
    await useBuilderStore.getState().copySelection();
    await useBuilderStore.getState().pasteClipboard();
    expect(useUndoStore.getState().past.length).toBeGreaterThanOrEqual(1);
  });
});

describe('cutSelection', () => {
  beforeEach(() => {
    resetCoalesceState();
    useBuilderStore.setState({
      nodes: [makeNode('a'), makeNode('b')],
      selectedNodeIds: ['a'],
      primarySelectionId: 'a',
      positions: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    });
    useUndoStore.setState({ past: [], future: [] });
  });
  afterEach(() => {
    useBuilderStore.setState({
      nodes: [],
      selectedNodeIds: [],
      primarySelectionId: null,
      positions: {},
      clipboard: null,
    });
    useUndoStore.setState({ past: [], future: [] });
  });

  it('cutSelection copies then removes selected nodes', async () => {
    await useBuilderStore.getState().cutSelection();
    expect(useBuilderStore.getState().nodes).toHaveLength(1); // only 'b' remains
    expect(useBuilderStore.getState().nodes[0].id).toBe('b');
  });

  it('cutSelection then paste restores node with new id', async () => {
    await useBuilderStore.getState().cutSelection();
    await useBuilderStore.getState().pasteClipboard();
    expect(useBuilderStore.getState().nodes).toHaveLength(2); // b + pasted a-copy
  });
});
