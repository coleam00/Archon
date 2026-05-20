import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { useUndoStore, withUndo, resetCoalesceState } from '../../store/undo-store';

const snap = (label: string) => ({
  label,
  workflow: null,
  nodes: [],
  positions: {},
});

describe('useUndoStore', () => {
  beforeEach(() => useUndoStore.setState({ past: [], future: [] }));
  afterEach(() => useUndoStore.setState({ past: [], future: [] }));

  it('push adds to past and clears future', () => {
    useUndoStore.getState().push(snap('add node'));
    useUndoStore.getState().push(snap('update node'));
    expect(useUndoStore.getState().past).toHaveLength(2);
    expect(useUndoStore.getState().future).toHaveLength(0);
  });

  it('undo moves head to future', () => {
    useUndoStore.getState().push(snap('a'));
    useUndoStore.getState().push(snap('b'));
    const result = useUndoStore.getState().undo();
    expect(result?.label).toBe('b');
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(useUndoStore.getState().future).toHaveLength(1);
  });

  it('redo moves future head back to past', () => {
    useUndoStore.getState().push(snap('a'));
    useUndoStore.getState().push(snap('b'));
    useUndoStore.getState().undo();
    const result = useUndoStore.getState().redo();
    expect(result?.label).toBe('b');
    expect(useUndoStore.getState().past).toHaveLength(2);
  });

  it('push after undo discards future', () => {
    useUndoStore.getState().push(snap('a'));
    useUndoStore.getState().push(snap('b'));
    useUndoStore.getState().undo();
    useUndoStore.getState().push(snap('c'));
    expect(useUndoStore.getState().future).toHaveLength(0);
    expect(useUndoStore.getState().past).toHaveLength(2);
  });

  it('caps stack at 50 entries', () => {
    for (let i = 0; i < 60; i++) useUndoStore.getState().push(snap(`s${i}`));
    expect(useUndoStore.getState().past).toHaveLength(50);
  });

  it('returns null when undo/redo on empty stack', () => {
    expect(useUndoStore.getState().undo()).toBeNull();
    expect(useUndoStore.getState().redo()).toBeNull();
  });
});

describe('withUndo', () => {
  beforeEach(() => {
    useUndoStore.setState({ past: [], future: [] });
    resetCoalesceState();
  });
  afterEach(() => {
    useUndoStore.setState({ past: [], future: [] });
    resetCoalesceState();
  });

  it('synchronously pushes a snapshot when called', () => {
    withUndo('test', snap('test'));
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(useUndoStore.getState().past[0].label).toBe('test');
  });

  it('does not push again within 400ms coalesce window for same label', () => {
    withUndo('typing', snap('typing'));
    withUndo('typing', snap('typing2'));
    expect(useUndoStore.getState().past).toHaveLength(1);
  });

  it('pushes again for different label', () => {
    withUndo('a', snap('a'));
    withUndo('b', snap('b'));
    expect(useUndoStore.getState().past).toHaveLength(2);
  });
});
