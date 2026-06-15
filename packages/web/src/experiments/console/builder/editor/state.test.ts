import { describe, test, expect } from 'bun:test';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition, toWorkflowDefinition } from '../model';
import { edgeId } from '../flow/to-flow';
import { createEditorState, editorReducer, NODE_ID_PATTERN, type EditorState } from './state';

function mixedState(): EditorState {
  return createEditorState(fromWorkflowDefinition(FIXTURES.mixed).workflow);
}

function select(
  state: EditorState,
  nodeIds: readonly string[],
  edgeIds: readonly string[] = []
): EditorState {
  return editorReducer(state, {
    type: 'set-selection',
    nodeIds: new Set(nodeIds),
    edgeIds: new Set(edgeIds),
  });
}

describe('remove-selection', () => {
  test('removes nodes and selected edges atomically — one undo restores everything', () => {
    const initial = mixedState();
    const original = toWorkflowDefinition(initial.workflow);

    // Select the 'fix' node plus the classify->report edge.
    const selected = select(initial, ['fix'], [edgeId('classify', 'report')]);
    const removed = editorReducer(selected, { type: 'remove-selection', at: 1000 });

    expect(removed.workflow.nodes.map(n => n.id)).toEqual(['classify', 'report']);
    // 'report' lost 'fix' (node removal) AND 'classify' (edge selection).
    expect(removed.workflow.nodes.find(n => n.id === 'report')?.base.depends_on).toBeUndefined();
    expect(removed.positions.has('fix')).toBe(false);
    expect(removed.history.past.length).toBe(1);

    const undone = editorReducer(removed, { type: 'undo' });
    expect(toWorkflowDefinition(undone.workflow)).toEqual(original);
    expect(undone.positions.has('fix')).toBe(true);
  });

  test('edge-only selection removes exactly that dependency', () => {
    const selected = select(mixedState(), [], [edgeId('classify', 'fix')]);
    const removed = editorReducer(selected, { type: 'remove-selection', at: 1000 });

    expect(removed.workflow.nodes.map(n => n.id)).toEqual(['classify', 'fix', 'report']);
    expect(removed.workflow.nodes.find(n => n.id === 'fix')?.base.depends_on).toBeUndefined();
    expect(removed.workflow.nodes.find(n => n.id === 'report')?.base.depends_on).toEqual([
      'classify',
      'fix',
    ]);
  });

  test('empty selection is a no-op with no history entry', () => {
    const initial = mixedState();
    const result = editorReducer(initial, { type: 'remove-selection', at: 1000 });
    expect(result).toBe(initial);
  });
});

describe('apply-selection (canvas select deltas)', () => {
  test('merges node and edge select deltas into the selection sets', () => {
    let state = mixedState();
    state = editorReducer(state, {
      type: 'apply-selection',
      nodes: [{ id: 'classify', selected: true }],
      edges: [{ id: edgeId('classify', 'fix'), selected: true }],
    });
    expect([...state.selectedNodes]).toEqual(['classify']);
    expect([...state.selectedEdges]).toEqual([edgeId('classify', 'fix')]);
  });

  test('an edge select delta makes the edge deletable via remove-selection', () => {
    let state = mixedState();
    // Click the connector — the only way to select an edge.
    state = editorReducer(state, {
      type: 'apply-selection',
      nodes: [],
      edges: [{ id: edgeId('classify', 'fix'), selected: true }],
    });
    expect(state.selectedEdges.size).toBe(1);
    const removed = editorReducer(state, { type: 'remove-selection', at: 1000 });
    expect(removed.workflow.nodes.find(n => n.id === 'fix')?.base.depends_on).toBeUndefined();
    // The other dependency edge is untouched.
    expect(removed.workflow.nodes.find(n => n.id === 'report')?.base.depends_on).toEqual([
      'classify',
      'fix',
    ]);
  });

  test('select:false deltas remove ids; a no-op delta returns the same state', () => {
    let state = mixedState();
    state = editorReducer(state, {
      type: 'apply-selection',
      nodes: [
        { id: 'classify', selected: true },
        { id: 'fix', selected: true },
      ],
      edges: [],
    });
    state = editorReducer(state, {
      type: 'apply-selection',
      nodes: [{ id: 'classify', selected: false }],
      edges: [],
    });
    expect([...state.selectedNodes]).toEqual(['fix']);

    const same = editorReducer(state, {
      type: 'apply-selection',
      nodes: [{ id: 'classify', selected: false }],
      edges: [],
    });
    expect(same).toBe(state);
  });
});

describe('rename-node id validation', () => {
  test('rejects ids outside the engine grammar', () => {
    const initial = mixedState();
    for (const bad of ['a->b', '1abc', 'a b', 'a.b', 'a/b', '$x']) {
      const result = editorReducer(initial, {
        type: 'rename-node',
        id: 'fix',
        nextId: bad,
        at: 1000,
      });
      expect(result).toBe(initial);
      expect(NODE_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  test('accepts a valid id and rewires dependents', () => {
    const renamed = editorReducer(mixedState(), {
      type: 'rename-node',
      id: 'fix',
      nextId: 'implement_fix-2',
      at: 1000,
    });
    expect(renamed.workflow.nodes.map(n => n.id)).toEqual([
      'classify',
      'implement_fix-2',
      'report',
    ]);
    expect(renamed.workflow.nodes.find(n => n.id === 'report')?.base.depends_on).toEqual([
      'classify',
      'implement_fix-2',
    ]);
  });
});

describe('align with measured sizes', () => {
  test('measured heights override the fixed fallback', () => {
    let state = mixedState();
    state = {
      ...state,
      positions: new Map([
        ['classify', { x: 0, y: 0 }],
        ['fix', { x: 300, y: 50 }],
        ['report', { x: 600, y: 100 }],
      ]),
    };
    state = select(state, ['classify', 'fix']);

    const aligned = editorReducer(state, {
      type: 'align',
      mode: 'bottom',
      sizes: new Map([
        ['classify', { width: 180, height: 80 }],
        ['fix', { width: 180, height: 120 }], // taller than the fallback
      ]),
      at: 1000,
    });

    // max bottom = max(0+80, 50+120) = 170; each y = 170 - height.
    expect(aligned.positions.get('classify')?.y).toBe(90);
    expect(aligned.positions.get('fix')?.y).toBe(50);
  });
});
