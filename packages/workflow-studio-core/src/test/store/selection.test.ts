import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';

describe('selection slice', () => {
  beforeEach(() => {
    useBuilderStore.setState({ nodes: [], selectedNodeIds: [], primarySelectionId: null } as any);
  });
  afterEach(() => {
    useBuilderStore.setState({ nodes: [], selectedNodeIds: [], primarySelectionId: null } as any);
  });

  it('setSelection replaces the array and sets primary to the last id', () => {
    useBuilderStore.getState().setSelection(['a', 'b']);
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);
    expect(useBuilderStore.getState().primarySelectionId).toBe('b');
  });

  it('addToSelection appends and updates primary; ignores duplicates', () => {
    useBuilderStore.getState().setSelection(['a']);
    useBuilderStore.getState().addToSelection('b');
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);
    useBuilderStore.getState().addToSelection('b');
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);
  });

  it('removeFromSelection drops the id and re-picks primary from the tail', () => {
    useBuilderStore.getState().setSelection(['a', 'b', 'c']);
    useBuilderStore.getState().removeFromSelection('c');
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);
    expect(useBuilderStore.getState().primarySelectionId).toBe('b');
  });

  it('clearSelection empties both', () => {
    useBuilderStore.getState().setSelection(['a']);
    useBuilderStore.getState().clearSelection();
    expect(useBuilderStore.getState().selectedNodeIds).toEqual([]);
    expect(useBuilderStore.getState().primarySelectionId).toBe(null);
  });

  it('selectAll selects every node id in store order', () => {
    useBuilderStore.setState({
      nodes: [
        { id: 'a', variant: 'bash', data: {}, base: {}, unknown: {} } as any,
        { id: 'b', variant: 'bash', data: {}, base: {}, unknown: {} } as any,
      ],
    });
    useBuilderStore.getState().selectAll();
    expect(useBuilderStore.getState().selectedNodeIds).toEqual(['a', 'b']);
    expect(useBuilderStore.getState().primarySelectionId).toBe('b');
  });
});
