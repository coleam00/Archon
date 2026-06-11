/**
 * Editor state + reducer for `BuilderPage`. Pure module: every action is a
 * plain object and mutating actions carry their own timestamp (`at`) so the
 * history coalescing window is deterministic under test — the page's dispatch
 * wrapper stamps `Date.now()`.
 *
 * The reducer owns the canonical `BuilderWorkflow` plus the UI-only canvas
 * state PR-1 deliberately excluded from the data layer: positions, selection,
 * undo history, and the clipboard envelope.
 */
import { VARIANT_REGISTRY } from '../variants';
import type { BuilderNode, BuilderWorkflow, VariantId } from '../types';
import { NODE_HEIGHT, NODE_WIDTH, layoutWithDagre } from '../flow/layout';
import { builderToFlowEdges } from '../flow/to-flow';
import type { XYPosition } from '../flow/types';
import {
  canRedo,
  canUndo,
  createHistory,
  pushSnapshot,
  redo,
  undo,
  type History,
  type Snapshot,
} from './history';
import { copySelection, pasteEnvelope, type ClipboardEnvelope } from './clipboard';
import { align, distributeH, distributeV, type AlignMode, type NodeRect } from './align';

export interface EditorState {
  workflow: BuilderWorkflow;
  positions: ReadonlyMap<string, XYPosition>;
  selectedNodes: ReadonlySet<string>;
  selectedEdges: ReadonlySet<string>;
  history: History;
  clipboard: ClipboardEnvelope | null;
}

export type EditorAction =
  | { type: 'add-node'; variant: VariantId; position: XYPosition; at: number }
  | { type: 'patch-node'; node: BuilderNode; at: number }
  | { type: 'rename-node'; id: string; nextId: string; at: number }
  | { type: 'remove-nodes'; ids: readonly string[]; at: number }
  | { type: 'add-edge'; source: string; target: string; at: number }
  | { type: 'remove-edges'; edgeIds: readonly string[]; at: number }
  | { type: 'move-nodes'; moves: readonly { id: string; position: XYPosition }[]; at: number }
  | { type: 'set-selection'; nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> }
  | { type: 'select-all' }
  | { type: 'copy' }
  | { type: 'cut'; at: number }
  | { type: 'paste'; at: number }
  | { type: 'align'; mode: AlignMode; at: number }
  | { type: 'distribute'; axis: 'h' | 'v'; at: number }
  | { type: 'auto-arrange'; at: number }
  | { type: 'undo' }
  | { type: 'redo' };

/** Initial editor state: dagre-layout every node, nothing selected. */
export function createEditorState(workflow: BuilderWorkflow): EditorState {
  const edges = builderToFlowEdges(workflow).map(e => ({ source: e.source, target: e.target }));
  return {
    workflow,
    positions: layoutWithDagre(
      workflow.nodes.map(n => n.id),
      edges
    ),
    selectedNodes: new Set(),
    selectedEdges: new Set(),
    history: createHistory(),
    clipboard: null,
  };
}

function snapshotOf(state: EditorState): Snapshot {
  return { workflow: state.workflow, positions: state.positions };
}

/** Push the pre-edit snapshot under `kind`, coalescing per `history.ts`. */
function remember(state: EditorState, kind: string, at: number): History {
  return pushSnapshot(state.history, kind, snapshotOf(state), at);
}

/** `variant-1`, `variant-2`, … skipping taken ids. */
function uniqueNodeId(variant: VariantId, taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${variant}-${n}`)) n += 1;
  return `${variant}-${n}`;
}

function nodeIds(workflow: BuilderWorkflow): Set<string> {
  return new Set(workflow.nodes.map(n => n.id));
}

/** Selected nodes as fixed-size rects for the alignment kernels. */
function selectionRects(state: EditorState): NodeRect[] {
  const rects: NodeRect[] = [];
  for (const id of state.selectedNodes) {
    const position = state.positions.get(id);
    if (position === undefined) continue;
    rects.push({ id, position, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  return rects;
}

function withPositions(
  state: EditorState,
  updates: ReadonlyMap<string, XYPosition>
): ReadonlyMap<string, XYPosition> {
  const next = new Map(state.positions);
  for (const [id, pos] of updates) next.set(id, pos);
  return next;
}

/** Drop `removed` ids from every remaining node's `depends_on`. */
function stripDeps(nodes: readonly BuilderNode[], removed: ReadonlySet<string>): BuilderNode[] {
  return nodes.map(node => {
    const deps = node.base.depends_on;
    if (!deps?.some(d => removed.has(d))) return node;
    const filtered = deps.filter(d => !removed.has(d));
    return {
      ...node,
      base: { ...node.base, depends_on: filtered.length > 0 ? filtered : undefined },
    } as BuilderNode;
  });
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'add-node': {
      const id = uniqueNodeId(action.variant, nodeIds(state.workflow));
      // The (variant, data) pair is consistent by construction — both come
      // from the same registry entry — so this is a valid union member.
      const node = {
        id,
        variant: action.variant,
        base: {},
        data: VARIANT_REGISTRY[action.variant].defaultData(),
      } as BuilderNode;
      return {
        ...state,
        history: remember(state, 'add-node', action.at),
        workflow: { ...state.workflow, nodes: [...state.workflow.nodes, node] },
        positions: withPositions(state, new Map([[id, action.position]])),
        selectedNodes: new Set([id]),
        selectedEdges: new Set(),
      };
    }

    case 'patch-node': {
      if (!state.workflow.nodes.some(n => n.id === action.node.id)) return state;
      return {
        ...state,
        history: remember(state, `patch:${action.node.id}`, action.at),
        workflow: {
          ...state.workflow,
          nodes: state.workflow.nodes.map(n => (n.id === action.node.id ? action.node : n)),
        },
      };
    }

    case 'rename-node': {
      const nextId = action.nextId.trim();
      if (nextId.length === 0 || nextId === action.id) return state;
      if (nodeIds(state.workflow).has(nextId)) return state;
      const nodes = state.workflow.nodes.map(node => {
        if (node.id === action.id) return { ...node, id: nextId } as BuilderNode;
        const deps = node.base.depends_on;
        if (!deps?.includes(action.id)) return node;
        return {
          ...node,
          base: { ...node.base, depends_on: deps.map(d => (d === action.id ? nextId : d)) },
        } as BuilderNode;
      });
      const positions = new Map(state.positions);
      const pos = positions.get(action.id);
      if (pos !== undefined) {
        positions.delete(action.id);
        positions.set(nextId, pos);
      }
      const selectedNodes = new Set(state.selectedNodes);
      if (selectedNodes.delete(action.id)) selectedNodes.add(nextId);
      return {
        ...state,
        history: remember(state, 'rename-node', action.at),
        workflow: { ...state.workflow, nodes },
        positions,
        selectedNodes,
      };
    }

    case 'remove-nodes': {
      const removed = new Set(action.ids);
      if (removed.size === 0) return state;
      const kept = state.workflow.nodes.filter(n => !removed.has(n.id));
      if (kept.length === state.workflow.nodes.length) return state;
      const positions = new Map(state.positions);
      for (const id of removed) positions.delete(id);
      const selectedNodes = new Set(state.selectedNodes);
      for (const id of removed) selectedNodes.delete(id);
      return {
        ...state,
        history: remember(state, 'remove-nodes', action.at),
        workflow: { ...state.workflow, nodes: stripDeps(kept, removed) },
        positions,
        selectedNodes,
        selectedEdges: new Set(),
      };
    }

    case 'add-edge': {
      if (action.source === action.target) return state;
      const ids = nodeIds(state.workflow);
      if (!ids.has(action.source) || !ids.has(action.target)) return state;
      const target = state.workflow.nodes.find(n => n.id === action.target);
      if (target === undefined || (target.base.depends_on ?? []).includes(action.source)) {
        return state;
      }
      const nodes = state.workflow.nodes.map(node => {
        if (node.id !== action.target) return node;
        return {
          ...node,
          base: {
            ...node.base,
            depends_on: [...(node.base.depends_on ?? []), action.source],
          },
        } as BuilderNode;
      });
      return {
        ...state,
        history: remember(state, 'add-edge', action.at),
        workflow: { ...state.workflow, nodes },
      };
    }

    case 'remove-edges': {
      if (action.edgeIds.length === 0) return state;
      // Edge ids are `${source}->${target}`; node ids cannot contain `>`.
      const pairs = action.edgeIds
        .map(id => id.split('->'))
        .filter((p): p is [string, string] => p.length === 2);
      if (pairs.length === 0) return state;
      const bySource = new Map<string, Set<string>>();
      for (const [source, target] of pairs) {
        const set = bySource.get(target) ?? new Set<string>();
        set.add(source);
        bySource.set(target, set);
      }
      const nodes = state.workflow.nodes.map(node => {
        const drop = bySource.get(node.id);
        const deps = node.base.depends_on;
        if (drop === undefined || deps === undefined) return node;
        const filtered = deps.filter(d => !drop.has(d));
        if (filtered.length === deps.length) return node;
        return {
          ...node,
          base: { ...node.base, depends_on: filtered.length > 0 ? filtered : undefined },
        } as BuilderNode;
      });
      return {
        ...state,
        history: remember(state, 'remove-edges', action.at),
        workflow: { ...state.workflow, nodes },
        selectedEdges: new Set(),
      };
    }

    case 'move-nodes': {
      if (action.moves.length === 0) return state;
      return {
        ...state,
        history: remember(state, 'move-nodes', action.at),
        positions: withPositions(state, new Map(action.moves.map(m => [m.id, m.position]))),
      };
    }

    case 'set-selection':
      return { ...state, selectedNodes: action.nodeIds, selectedEdges: action.edgeIds };

    case 'select-all':
      return {
        ...state,
        selectedNodes: nodeIds(state.workflow),
        selectedEdges: new Set(),
      };

    case 'copy': {
      const envelope = copySelection(state.workflow, state.selectedNodes, state.positions);
      if (envelope === null) return state;
      return { ...state, clipboard: envelope };
    }

    case 'cut': {
      const envelope = copySelection(state.workflow, state.selectedNodes, state.positions);
      if (envelope === null) return state;
      const next = editorReducer(
        { ...state, clipboard: envelope },
        { type: 'remove-nodes', ids: [...state.selectedNodes], at: action.at }
      );
      // remove-nodes pushed the pre-cut snapshot; relabel the step as a cut.
      return { ...next, history: { ...next.history, lastKind: 'cut' } };
    }

    case 'paste': {
      if (state.clipboard === null) return state;
      const { nodes, positions } = pasteEnvelope(state.clipboard, nodeIds(state.workflow));
      if (nodes.length === 0) return state;
      const merged = new Map(state.positions);
      for (const node of nodes) {
        merged.set(node.id, positions.get(node.id) ?? { x: 40, y: 40 });
      }
      return {
        ...state,
        history: remember(state, 'paste', action.at),
        workflow: { ...state.workflow, nodes: [...state.workflow.nodes, ...nodes] },
        positions: merged,
        selectedNodes: new Set(nodes.map(n => n.id)),
        selectedEdges: new Set(),
      };
    }

    case 'align': {
      const rects = selectionRects(state);
      if (rects.length < 2) return state;
      return {
        ...state,
        history: remember(state, 'align', action.at),
        positions: withPositions(state, align(action.mode, rects)),
      };
    }

    case 'distribute': {
      const rects = selectionRects(state);
      if (rects.length < 3) return state;
      const next = action.axis === 'h' ? distributeH(rects) : distributeV(rects);
      return {
        ...state,
        history: remember(state, 'distribute', action.at),
        positions: withPositions(state, next),
      };
    }

    case 'auto-arrange': {
      const edges = builderToFlowEdges(state.workflow).map(e => ({
        source: e.source,
        target: e.target,
      }));
      return {
        ...state,
        history: remember(state, 'auto-arrange', action.at),
        positions: layoutWithDagre(
          state.workflow.nodes.map(n => n.id),
          edges
        ),
      };
    }

    case 'undo': {
      const result = undo(state.history, snapshotOf(state));
      if (result === null) return state;
      return {
        ...state,
        history: result.history,
        workflow: result.snapshot.workflow,
        positions: result.snapshot.positions,
      };
    }

    case 'redo': {
      const result = redo(state.history, snapshotOf(state));
      if (result === null) return state;
      return {
        ...state,
        history: result.history,
        workflow: result.snapshot.workflow,
        positions: result.snapshot.positions,
      };
    }
  }
}

export { canUndo, canRedo };
