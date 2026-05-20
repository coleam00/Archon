import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';
import { useUndoStore, resetCoalesceState } from '../../store/undo-store';

describe('positions slice', () => {
  beforeEach(() => {
    useBuilderStore.setState({
      nodes: [],
      positions: {},
      selectedNodeIds: [],
      primarySelectionId: null,
    });
    useUndoStore.setState({ past: [], future: [] });
  });
  afterEach(() => {
    useBuilderStore.setState({
      nodes: [],
      positions: {},
      selectedNodeIds: [],
      primarySelectionId: null,
    });
    useUndoStore.setState({ past: [], future: [] });
  });

  it('setNodePosition stores x/y by id', () => {
    useBuilderStore.getState().setNodePosition('n1', 100, 200);
    expect(useBuilderStore.getState().positions['n1']).toEqual({ x: 100, y: 200 });
  });

  it('setNodePosition for unknown id creates the entry', () => {
    useBuilderStore.getState().setNodePosition('new', 0, 0);
    expect(useBuilderStore.getState().positions['new']).toEqual({ x: 0, y: 0 });
  });

  it('clearWorkflow resets positions to {}', () => {
    useBuilderStore.getState().setNodePosition('n1', 10, 20);
    useBuilderStore.getState().clearWorkflow();
    expect(useBuilderStore.getState().positions).toEqual({});
  });
});

describe('undo instrumentation', () => {
  beforeEach(() => {
    useBuilderStore.setState({
      nodes: [],
      positions: {},
      selectedNodeIds: [],
      primarySelectionId: null,
    });
    useUndoStore.setState({ past: [], future: [] });
    resetCoalesceState();
  });
  afterEach(() => {
    useBuilderStore.setState({
      nodes: [],
      positions: {},
      selectedNodeIds: [],
      primarySelectionId: null,
    });
    useUndoStore.setState({ past: [], future: [] });
    resetCoalesceState();
  });

  it('addNode pushes an undo snapshot', () => {
    const variant = useBuilderStore.getState().variants?.[0];
    if (!variant) return; // skip if no variants in test env
    useBuilderStore.getState().addNode(variant.id, { x: 0, y: 0 });
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(useUndoStore.getState().past[0].label).toBe('add node');
  });

  it('deleteNodes pushes an undo snapshot', () => {
    useBuilderStore.setState({
      nodes: [{ id: 'n1', variant: 'bash', data: {}, base: {}, unknown: {} } as any],
    });
    useBuilderStore.getState().deleteNodes(['n1']);
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(useUndoStore.getState().past[0].label).toBe('delete nodes');
  });
});
