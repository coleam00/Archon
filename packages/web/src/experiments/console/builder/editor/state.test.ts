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

describe('add-node', () => {
  test('adds a registry-seeded node, selects it, positions it, and records history', () => {
    const initial = mixedState();
    const next = editorReducer(initial, {
      type: 'add-node',
      variant: 'bash',
      position: { x: 120, y: 240 },
      at: 1000,
    });
    // First bash node gets the `bash-1` slot (no existing bash-N ids).
    const added = next.workflow.nodes.find(n => n.id === 'bash-1');
    expect(added?.variant).toBe('bash');
    expect(next.positions.get('bash-1')).toEqual({ x: 120, y: 240 });
    expect([...next.selectedNodes]).toEqual(['bash-1']);
    expect(next.selectedEdges.size).toBe(0);
    expect(next.history.past.length).toBe(1);
  });

  test('skips taken ids when minting the unique id', () => {
    let state = mixedState();
    state = editorReducer(state, {
      type: 'add-node',
      variant: 'prompt',
      position: { x: 0, y: 0 },
      at: 1000,
    });
    state = editorReducer(state, {
      type: 'add-node',
      variant: 'prompt',
      position: { x: 0, y: 0 },
      at: 2000,
    });
    expect(state.workflow.nodes.some(n => n.id === 'prompt-1')).toBe(true);
    expect(state.workflow.nodes.some(n => n.id === 'prompt-2')).toBe(true);
  });
});

describe('patch-node', () => {
  test('replaces the matching node and records history', () => {
    const initial = mixedState();
    const classify = initial.workflow.nodes.find(n => n.id === 'classify');
    if (classify === undefined || classify.variant !== 'prompt') throw new Error('fixture drift');
    const patched = editorReducer(initial, {
      type: 'patch-node',
      node: { ...classify, data: { prompt: 'new body' } },
      at: 1000,
    });
    const updated = patched.workflow.nodes.find(n => n.id === 'classify');
    expect(updated?.variant === 'prompt' ? updated.data.prompt : null).toBe('new body');
    expect(patched.history.past.length).toBe(1);
  });

  test('is a no-op for an unknown node id', () => {
    const initial = mixedState();
    const result = editorReducer(initial, {
      type: 'patch-node',
      node: { id: 'ghost', variant: 'prompt', base: {}, data: { prompt: 'x' } },
      at: 1000,
    });
    expect(result).toBe(initial);
  });
});

describe('remove-nodes', () => {
  test('removes nodes and cascades the dep off remaining nodes', () => {
    const initial = mixedState();
    const removed = editorReducer(initial, { type: 'remove-nodes', ids: ['fix'], at: 1000 });
    expect(removed.workflow.nodes.map(n => n.id)).toEqual(['classify', 'report']);
    // 'report' dropped the now-dangling 'fix' dependency but kept 'classify'.
    expect(removed.workflow.nodes.find(n => n.id === 'report')?.base.depends_on).toEqual([
      'classify',
    ]);
    expect(removed.positions.has('fix')).toBe(false);
  });

  test('is a no-op for an empty id list or ids that match nothing', () => {
    const initial = mixedState();
    expect(editorReducer(initial, { type: 'remove-nodes', ids: [], at: 1000 })).toBe(initial);
    expect(editorReducer(initial, { type: 'remove-nodes', ids: ['ghost'], at: 1000 })).toBe(
      initial
    );
  });
});

describe('add-edge', () => {
  test('appends a dependency when both endpoints exist and the edge is new', () => {
    // 'classify' has no deps; wire fix -> classify... already exists, so use a
    // fresh edge: make 'classify' depend on a newly added node.
    let state = mixedState();
    state = editorReducer(state, {
      type: 'add-node',
      variant: 'prompt',
      position: { x: 0, y: 0 },
      at: 1000,
    });
    const withEdge = editorReducer(state, {
      type: 'add-edge',
      source: 'prompt-1',
      target: 'classify',
      at: 2000,
    });
    expect(withEdge.workflow.nodes.find(n => n.id === 'classify')?.base.depends_on).toEqual([
      'prompt-1',
    ]);
  });

  test('rejects self-loops, unknown endpoints, and duplicate edges', () => {
    const initial = mixedState();
    // self-loop
    expect(
      editorReducer(initial, { type: 'add-edge', source: 'fix', target: 'fix', at: 1000 })
    ).toBe(initial);
    // unknown source
    expect(
      editorReducer(initial, { type: 'add-edge', source: 'ghost', target: 'fix', at: 1000 })
    ).toBe(initial);
    // unknown target
    expect(
      editorReducer(initial, { type: 'add-edge', source: 'fix', target: 'ghost', at: 1000 })
    ).toBe(initial);
    // duplicate (fix already depends on classify)
    expect(
      editorReducer(initial, { type: 'add-edge', source: 'classify', target: 'fix', at: 1000 })
    ).toBe(initial);
  });
});

describe('move-nodes', () => {
  test('updates positions and records history', () => {
    const initial = mixedState();
    const moved = editorReducer(initial, {
      type: 'move-nodes',
      moves: [{ id: 'classify', position: { x: 999, y: 888 } }],
      at: 1000,
    });
    expect(moved.positions.get('classify')).toEqual({ x: 999, y: 888 });
    expect(moved.history.past.length).toBe(1);
  });

  test('is a no-op for empty moves', () => {
    const initial = mixedState();
    expect(editorReducer(initial, { type: 'move-nodes', moves: [], at: 1000 })).toBe(initial);
  });
});

describe('select-all', () => {
  test('selects every node id and clears edge selection', () => {
    let state = mixedState();
    state = editorReducer(state, {
      type: 'apply-selection',
      nodes: [],
      edges: [{ id: edgeId('classify', 'fix'), selected: true }],
    });
    const all = editorReducer(state, { type: 'select-all' });
    expect([...all.selectedNodes].sort()).toEqual(['classify', 'fix', 'report']);
    expect(all.selectedEdges.size).toBe(0);
  });
});

describe('copy / cut / paste', () => {
  test('copy populates the clipboard without mutating the workflow', () => {
    const selected = select(mixedState(), ['classify']);
    const copied = editorReducer(selected, { type: 'copy' });
    expect(copied.clipboard).not.toBeNull();
    expect(copied.workflow).toBe(selected.workflow);
  });

  test('copy with an empty selection is a no-op', () => {
    const initial = mixedState();
    expect(editorReducer(initial, { type: 'copy' })).toBe(initial);
  });

  test('paste materializes clipboard nodes with remapped ids and selects them', () => {
    let state = select(mixedState(), ['classify']);
    state = editorReducer(state, { type: 'copy' });
    const pasted = editorReducer(state, { type: 'paste', at: 1000 });
    // Original 'classify' kept; the paste lands a remapped copy.
    expect(pasted.workflow.nodes.length).toBe(4);
    const copyId = pasted.workflow.nodes.map(n => n.id).find(id => id.startsWith('classify-copy'));
    if (copyId === undefined) throw new Error('expected a remapped paste copy');
    expect([...pasted.selectedNodes]).toEqual([copyId]);
  });

  test('paste with an empty clipboard is a no-op', () => {
    const initial = mixedState();
    expect(editorReducer(initial, { type: 'paste', at: 1000 })).toBe(initial);
  });

  test('cut removes the selection, fills the clipboard, and labels history as cut', () => {
    const selected = select(mixedState(), ['fix']);
    const cut = editorReducer(selected, { type: 'cut', at: 1000 });
    expect(cut.workflow.nodes.map(n => n.id)).toEqual(['classify', 'report']);
    expect(cut.clipboard).not.toBeNull();
    expect(cut.history.lastKind).toBe('cut');
    // A cut copy can be pasted back.
    const pasted = editorReducer(cut, { type: 'paste', at: 2000 });
    expect(pasted.workflow.nodes.some(n => n.id === 'fix')).toBe(true);
  });
});

describe('distribute', () => {
  test('needs at least three selected nodes', () => {
    const twoSelected = select(mixedState(), ['classify', 'fix']);
    expect(editorReducer(twoSelected, { type: 'distribute', axis: 'h', at: 1000 })).toBe(
      twoSelected
    );
  });

  test('evenly spaces three selected nodes along the axis and records history', () => {
    let state = mixedState();
    state = {
      ...state,
      positions: new Map([
        ['classify', { x: 0, y: 0 }],
        ['fix', { x: 50, y: 0 }],
        ['report', { x: 300, y: 0 }],
      ]),
    };
    state = select(state, ['classify', 'fix', 'report']);
    const distributed = editorReducer(state, { type: 'distribute', axis: 'h', at: 1000 });
    // Endpoints are pinned; the middle node is re-spaced between them.
    expect(distributed.positions.get('classify')?.x).toBe(0);
    expect(distributed.positions.get('report')?.x).toBe(300);
    expect(distributed.positions.get('fix')?.x).not.toBe(50);
    expect(distributed.history.past.length).toBe(1);
  });
});

describe('auto-arrange', () => {
  test('relays out positions for every node and records history', () => {
    let state = mixedState();
    state = {
      ...state,
      positions: new Map([
        ['classify', { x: -999, y: -999 }],
        ['fix', { x: -999, y: -999 }],
        ['report', { x: -999, y: -999 }],
      ]),
    };
    const arranged = editorReducer(state, { type: 'auto-arrange', at: 1000 });
    for (const id of ['classify', 'fix', 'report']) {
      expect(arranged.positions.get(id)).not.toEqual({ x: -999, y: -999 });
    }
    expect(arranged.history.past.length).toBe(1);
  });
});

describe('undo / redo integration', () => {
  test('undo restores the pre-edit workflow; redo reapplies it', () => {
    const initial = mixedState();
    const added = editorReducer(initial, {
      type: 'add-node',
      variant: 'prompt',
      position: { x: 0, y: 0 },
      at: 1000,
    });
    expect(added.workflow.nodes.length).toBe(4);

    const undone = editorReducer(added, { type: 'undo' });
    expect(undone.workflow.nodes.length).toBe(3);
    expect(undone.workflow.nodes.map(n => n.id)).toEqual(['classify', 'fix', 'report']);
    // Selection is cleared on undo so it can never dangle against the restored
    // snapshot (the added node's selection would otherwise reference a node the
    // undo just removed).
    expect(undone.selectedNodes.size).toBe(0);
    expect(undone.selectedEdges.size).toBe(0);

    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.workflow.nodes.length).toBe(4);
    // Redo also clears selection; whatever remains must reference live nodes.
    expect(redone.selectedNodes.size).toBe(0);
    for (const id of redone.selectedNodes) {
      expect(redone.workflow.nodes.some(n => n.id === id)).toBe(true);
    }
  });

  test('undo and redo are no-ops at the ends of the history stack', () => {
    const initial = mixedState();
    expect(editorReducer(initial, { type: 'undo' })).toBe(initial);
    expect(editorReducer(initial, { type: 'redo' })).toBe(initial);
  });
});

describe('rename-node duplicate id', () => {
  test('renaming to an id another node already uses is a silent no-op (Inspector surfaces it)', () => {
    const initial = mixedState();
    const result = editorReducer(initial, {
      type: 'rename-node',
      id: 'fix',
      nextId: 'report',
      at: 1000,
    });
    expect(result).toBe(initial);
  });

  test('renaming a non-existent source id is a no-op (no history, no dep rewrite)', () => {
    const initial = mixedState();
    const result = editorReducer(initial, {
      type: 'rename-node',
      id: 'ghost',
      nextId: 'phantom',
      at: 1000,
    });
    expect(result).toBe(initial);
  });

  test('clears a stale edge selection so a later delete cannot miss', () => {
    // Select the classify->fix edge, then rename 'classify' — the edge id
    // `classify->fix` no longer exists, so the selection must be cleared.
    let state = select(mixedState(), [], [edgeId('classify', 'fix')]);
    state = editorReducer(state, {
      type: 'rename-node',
      id: 'classify',
      nextId: 'triage',
      at: 1000,
    });
    expect(state.selectedEdges.size).toBe(0);
    // The dependency itself was rewired to the new id.
    expect(state.workflow.nodes.find(n => n.id === 'fix')?.base.depends_on).toEqual(['triage']);
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
