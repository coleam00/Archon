import { create } from 'zustand';
import type { BuilderNode } from '../nodes/shared/types';
import { defaultRegistry } from '../nodes/default-registry';
import type { VariantId } from '../nodes/registry';
import { makeUniqueId } from '../nodes/shared/makeUniqueId';
import { pickBaseFields } from '../nodes/shared/pickBaseFields';
import { mergePatch } from './mergePatch';
import { serializeYaml } from '../exporter/serializeYaml';
import { withUndo, useUndoStore, type UndoSnapshot } from './undo-store';
import { serializeClipboard, parseClipboard } from '../clipboard';
import { layoutWithDagre } from '../hooks/useDagre';
import {
  alignLeft,
  alignRight,
  alignTop,
  alignBottom,
  alignCenterH,
  alignCenterV,
  distributeH,
  distributeV,
} from '../alignment';
import type { Guide } from '../smart-guides';

/**
 * Base fields whose semantics are AI-inference-specific (provider routing,
 * sampling knobs, tool gating, structured output). When `convertVariant`
 * targets a variant with `honorsAiFields: false`, these get stripped from
 * `n.base` and stashed in `data._unknown._converted_from` so a future
 * convert-back can restore them.
 *
 * Deliberately NARROWER than "every base field": `mcp`, `skills`, `agents`,
 * and `context` are runtime-relevant on bash / script / cancel / approval
 * too (a bash node may declare which mcp servers it accesses), so they're
 * kept across conversion. `depends_on` / `when` / `retry` / `hooks` /
 * `sandbox` / `idle_timeout` / `trigger_rule` are flow-control and always
 * kept regardless.
 */
const AI_BASE_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'allowed_tools',
  'denied_tools',
  'output_format',
  'effort',
  'thinking',
  'maxBudgetUsd',
  'systemPrompt',
  'fallbackModel',
  'betas',
]);

export interface WorkflowMeta {
  name: string;
  description: string;
  base: Record<string, unknown>;
  unknown: Record<string, unknown>;
}

export interface LoadWorkflowInput {
  meta: WorkflowMeta;
  nodes: BuilderNode[];
}

/**
 * Lightweight path descriptor for the focused validation issue.
 * Intentionally NOT imported from `validation/types` to avoid a circular
 * dependency: builder-store → validation/types → (nothing) would be fine,
 * but having the UI layer depend on validation internals through the store
 * creates an undesirable coupling. This local type is structurally identical
 * to `IssuePath` in validation/types (drift 6.5 — local alias).
 */
export interface IssuePath {
  nodeId?: string;
  field?: string;
  atomIndex?: number;
}

export interface BuilderState {
  workflow: WorkflowMeta | null;
  nodes: BuilderNode[];
  /** Node position map for undo snapshots (parallel to PositionContext for snapshotting). */
  positions: Record<string, { x: number; y: number }>;
  /** All currently-selected node ids. Driven by Canvas onSelectionChange. */
  selectedNodeIds: string[];
  /** The last id added to the selection — used by single-node consumers (Inspector, YAML preview). */
  primarySelectionId: string | null;
  /** The validation issue path currently focused in the panel. Drives inspector tab routing. */
  focusedIssue: IssuePath | null;
  /** Id of the node currently hovered on the canvas. Null when no node is hovered. */
  hoveredNodeId: string | null;
  /** Whether the YAML preview drawer is open. */
  isYamlPreviewOpen: boolean;
  /** Serialized YAML captured at last loadWorkflow call. Used to detect unsaved changes. */
  baselineYaml: string | null;
  /** In-memory clipboard fallback for environments where navigator.clipboard is unavailable. */
  clipboard: string | null;
  /** Currently active smart guide lines shown during node drag. */
  activeGuides: Guide[];
  /** Whether snap-to-grid is enabled. */
  gridSnap: boolean;
  /** Canvas interaction mode: 'pan' = drag pans viewport, 'select' = drag draws marquee. */
  canvasMode: 'pan' | 'select';
  /** When false, nodes/edges are locked — no drag, no selection, no new connections. */
  interactive: boolean;

  setNodePosition: (id: string, x: number, y: number) => void;
  setManyPositions: (entries: Iterable<[string, { x: number; y: number }]>) => void;
  setActiveGuides: (guides: Guide[]) => void;
  toggleGridSnap: () => void;
  setCanvasMode: (mode: 'pan' | 'select') => void;
  toggleInteractive: () => void;

  loadWorkflow: (input: LoadWorkflowInput) => void;
  clearWorkflow: () => void;
  setSelection: (ids: string[]) => void;
  addToSelection: (id: string) => void;
  removeFromSelection: (id: string) => void;
  clearSelection: () => void;
  selectAll: () => void;
  removeSelected: () => void;
  setFocusedIssue: (path: IssuePath | null) => void;
  setHoveredNodeId: (id: string | null) => void;
  setYamlPreviewOpen: (open: boolean) => void;

  setWorkflowName: (name: string) => void;
  setWorkflowDescription: (description: string) => void;

  addNode: (node: BuilderNode) => void;
  /**
   * Mint a new node from a variant's `createDefault()` and append it to the store.
   * Returns the id chosen via `makeUniqueId(hint, existingIds)` so callers can
   * persist a position for the new node.
   *
   * `dataPatch` is **shallow-merged** onto `createDefault()` — for nested-data
   * variants (loop, approval), patching `data.loop` replaces the whole loop
   * config object. Phase-3 callers (Commands section) only patch flat fields.
   */
  addNodeFromVariant: (
    variantId: VariantId,
    options?: { idHintOverride?: string; dataPatch?: Record<string, unknown> }
  ) => string;
  updateNode: (id: string, patch: Partial<BuilderNode>) => void;
  /**
   * Patch a node's editable fields by routing each key to its correct storage
   * bucket (data / base / unknown) via pickBaseFields, deep-merging via
   * mergePatch. Inspector tabs call this with any field regardless of origin.
   * `null` in the patch deletes the key from its bucket.
   */
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  /**
   * Migrate a node to a different variant. Variant-specific fields the target
   * cannot represent are parked in `data._unknown._converted_from`. When the
   * target variant has `honorsAiFields: false` (bash, script, cancel, approval),
   * AI base fields are also parked. Flow-control base fields (depends_on,
   * when, retry, hooks, etc.) are kept regardless.
   *
   * No-op if `id`'s current variant already equals `newVariantId`. Throws on
   * unknown id or unknown variant id.
   */
  convertVariant: (id: string, newVariantId: VariantId) => void;
  deleteNodes: (ids: string[]) => void;

  connect: (source: string, target: string) => void;
  disconnect: (source: string, target: string) => void;
  renameNode: (oldId: string, newId: string) => void;

  /** Restore nodes + positions from an undo snapshot. */
  applySnapshot: (snap: UndoSnapshot) => void;
  /** Alias for applySnapshot — same semantics, symmetric naming for redo. */
  revertSnapshot: (snap: UndoSnapshot) => void;
  /** Pop the top of the undo stack and apply it. No-op when stack is empty. */
  applyUndo: () => void;
  /** Pop the top of the redo stack and apply it. No-op when stack is empty. */
  applyRedo: () => void;

  /** Copy selected nodes to in-memory clipboard and (best-effort) navigator.clipboard. */
  copySelection: () => Promise<void>;
  /** Paste from navigator.clipboard (falling back to in-memory clipboard). Remaps IDs and depends_on. */
  pasteClipboard: () => Promise<void>;
  /** Copy then remove selected nodes in one operation. */
  cutSelection: () => Promise<void>;

  /** Align selected nodes. Requires >= 2 selected nodes. */
  alignSelection: (direction: 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV') => void;
  /** Distribute selected nodes evenly. Requires >= 3 selected nodes. */
  distributeSelection: (axis: 'h' | 'v') => void;
  /** Run dagre layout on the selection subgraph and update positions. */
  autoArrangeSelection: () => void;
}

export const useBuilderStore = create<BuilderState>((set, get) => {
  /** Capture a snapshot of current state for undo. */
  const snapshot = (label: string): UndoSnapshot => {
    const s = get();
    return {
      label,
      workflow: s.workflow ?? null,
      nodes: [...s.nodes],
      positions: { ...s.positions },
    };
  };

  return {
    workflow: null,
    nodes: [],
    positions: {},
    selectedNodeIds: [],
    primarySelectionId: null,
    focusedIssue: null,
    hoveredNodeId: null,
    isYamlPreviewOpen: false,
    baselineYaml: null,
    clipboard: null,
    activeGuides: [],
    gridSnap: false,
    canvasMode: 'select',
    interactive: true,

    setNodePosition: (id, x, y): void => {
      set(s => ({ positions: { ...s.positions, [id]: { x, y } } }));
    },
    setManyPositions: (entries): void => {
      const update: Record<string, { x: number; y: number }> = {};
      for (const [id, pos] of entries) update[id] = pos;
      set(s => ({ positions: { ...s.positions, ...update } }));
    },
    setActiveGuides: (guides): void => {
      set({ activeGuides: guides });
    },
    toggleGridSnap: (): void => {
      set(s => ({ gridSnap: !s.gridSnap }));
    },
    setCanvasMode: (mode): void => {
      set({ canvasMode: mode });
    },
    toggleInteractive: (): void => {
      set(s => ({ interactive: !s.interactive }));
    },

    loadWorkflow: (input): void => {
      const { yaml: baseline } = serializeYaml(input);
      set({ workflow: input.meta, nodes: input.nodes, baselineYaml: baseline, positions: {} });
      useUndoStore.getState().clear();
    },
    clearWorkflow: (): void => {
      set({
        workflow: null,
        nodes: [],
        positions: {},
        selectedNodeIds: [],
        primarySelectionId: null,
        focusedIssue: null,
        baselineYaml: null,
        hoveredNodeId: null,
        isYamlPreviewOpen: false,
        activeGuides: [],
      });
      useUndoStore.getState().clear();
    },
    setSelection: (ids): void => {
      set({ selectedNodeIds: ids, primarySelectionId: ids.length ? ids[ids.length - 1] : null });
    },
    addToSelection: (id): void => {
      set(s => {
        if (s.selectedNodeIds.includes(id)) return s;
        const next = [...s.selectedNodeIds, id];
        return { selectedNodeIds: next, primarySelectionId: id };
      });
    },
    removeFromSelection: (id): void => {
      set(s => {
        const next = s.selectedNodeIds.filter(x => x !== id);
        return {
          selectedNodeIds: next,
          primarySelectionId: next.length ? next[next.length - 1] : null,
        };
      });
    },
    clearSelection: (): void => {
      set({ selectedNodeIds: [], primarySelectionId: null });
    },
    selectAll: (): void => {
      set(s => {
        const ids = s.nodes.map(n => n.id);
        return {
          selectedNodeIds: ids,
          primarySelectionId: ids.length ? ids[ids.length - 1] : null,
        };
      });
    },
    removeSelected: (): void => {
      const { selectedNodeIds, deleteNodes } = get();
      if (selectedNodeIds.length === 0) return;
      deleteNodes(selectedNodeIds);
      set({ selectedNodeIds: [], primarySelectionId: null });
    },
    setHoveredNodeId: (id): void => {
      set({ hoveredNodeId: id });
    },
    setYamlPreviewOpen: (open): void => {
      set({ isYamlPreviewOpen: open });
    },
    // Reference-equality guard: prevents spurious notifications when the panel
    // re-clicks the same row (the same path reference) — Zustand would otherwise
    // notify on every set() even with an identical payload.
    setFocusedIssue: (path): void => {
      set(s => (s.focusedIssue === path ? s : { focusedIssue: path }));
    },

    setWorkflowName: (name): void => {
      set(s => (s.workflow ? { workflow: { ...s.workflow, name } } : s));
    },
    setWorkflowDescription: (description): void => {
      set(s => (s.workflow ? { workflow: { ...s.workflow, description } } : s));
    },

    addNode: (node): void => {
      withUndo('add node', snapshot('add node'));
      set(s => {
        if (s.nodes.some(n => n.id === node.id)) {
          throw new Error(`addNode: id collision '${node.id}'`);
        }
        return { nodes: [...s.nodes, node] };
      });
    },

    addNodeFromVariant: (variantId, options): string => {
      withUndo('add node', snapshot('add node'));
      const def = defaultRegistry[variantId];
      const hint = options?.idHintOverride ?? def.library.defaultIdHint;
      const existingIds = new Set(get().nodes.map(n => n.id));
      const id = makeUniqueId(hint, existingIds);
      const data = {
        ...(def.createDefault() as Record<string, unknown>),
        ...(options?.dataPatch ?? {}),
      };
      set(s => ({
        nodes: [...s.nodes, { id, variant: variantId, data, base: {}, unknown: {} }],
      }));
      return id;
    },

    updateNode: (id, patch): void => {
      withUndo('update node', snapshot('update node'));
      set(s => ({
        nodes: s.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)),
      }));
    },

    updateNodeData: (id, patch): void => {
      const node = get().nodes.find(n => n.id === id);
      if (!node) throw new Error(`updateNodeData: '${id}' not found`);
      const partition = pickBaseFields(patch, node.variant);
      set(s => ({
        nodes: s.nodes.map(n =>
          n.id === id
            ? {
                ...n,
                data: mergePatch(n.data as Record<string, unknown>, partition.variantSpecific),
                base: mergePatch(n.base, partition.base),
                unknown: mergePatch(n.unknown, partition.unknown),
              }
            : n
        ),
      }));
    },

    convertVariant: (id, newVariantId): void => {
      withUndo('convert variant', snapshot('convert variant'));
      const node = get().nodes.find(n => n.id === id);
      if (!node) throw new Error(`convertVariant: '${id}' not found`);
      const target = defaultRegistry[newVariantId];
      if (!target) throw new Error(`convertVariant: unknown variant '${newVariantId}'`);
      if (node.variant === newVariantId) return;

      // Re-classify the source's variant-specific data under the TARGET variant's
      // lens. pickBaseFields buckets every recognised key into variantSpecific /
      // base / unknown; anything the target can't accept ends up in `unknown`.
      const currentDagShape = (node.data as Record<string, unknown>) ?? {};
      const reclassified = pickBaseFields(currentDagShape, newVariantId);

      // The variant-data forward-compat bag (`data._unknown`) is preserved
      // verbatim below — strip it from `reclassified.unknown` so it is NOT
      // duplicated into `n.unknown` on the merge at the bottom of this action.
      delete reclassified.unknown._unknown;

      // Anything in `reclassified.unknown` at this point is a key that was
      // variant-specific to the source but isn't recognised by the target —
      // park it under `_converted_from` so a convert-back can restore it.
      const parkedFromData: Record<string, unknown> = { ...reclassified.unknown };
      reclassified.unknown = {};

      // Capability-aware base-field parking: when target ignores AI fields,
      // strip the AI-inference-specific subset (see AI_BASE_KEYS) and park.
      // Flow-control base fields (depends_on, when, retry, hooks, sandbox,
      // trigger_rule, idle_timeout) and runtime-relevant lists (mcp, skills,
      // agents, context) are kept regardless.
      let newBase: Record<string, unknown> = { ...node.base };
      const parkedFromBase: Record<string, unknown> = {};
      if (!target.capabilities.honorsAiFields) {
        const kept: Record<string, unknown> = {};
        for (const k of Object.keys(newBase)) {
          if (AI_BASE_KEYS.has(k)) {
            parkedFromBase[k] = newBase[k];
          } else {
            kept[k] = newBase[k];
          }
        }
        newBase = kept;
      }

      const previousDataUnknown = (currentDagShape._unknown as Record<string, unknown>) ?? {};
      const newData: Record<string, unknown> = {
        ...(target.createDefault() as Record<string, unknown>),
        ...reclassified.variantSpecific,
        _unknown: {
          ...previousDataUnknown,
          _converted_from: {
            variant: node.variant,
            ...parkedFromData,
            ...parkedFromBase,
          },
        },
      };

      set(s => ({
        nodes: s.nodes.map(n =>
          n.id === id ? { ...n, variant: newVariantId, data: newData, base: newBase } : n
        ),
      }));
    },

    deleteNodes: (ids): void => {
      withUndo('delete nodes', snapshot('delete nodes'));
      const idSet = new Set(ids);
      set(s => ({
        nodes: s.nodes
          .filter(n => !idSet.has(n.id))
          .map(n => {
            const dep = (n.base.depends_on as string[] | undefined) ?? undefined;
            if (!dep) return n;
            const filtered = dep.filter(d => !idSet.has(d));
            const newBase = { ...n.base };
            if (filtered.length === 0) delete newBase.depends_on;
            else newBase.depends_on = filtered;
            return { ...n, base: newBase };
          }),
      }));
    },

    connect: (source, target): void => {
      set(s => ({
        nodes: s.nodes.map(n => {
          if (n.id !== target) return n;
          const dep = (n.base.depends_on as string[] | undefined) ?? [];
          if (dep.includes(source)) return n;
          return { ...n, base: { ...n.base, depends_on: [...dep, source] } };
        }),
      }));
    },

    disconnect: (source, target): void => {
      set(s => ({
        nodes: s.nodes.map(n => {
          if (n.id !== target) return n;
          const dep = (n.base.depends_on as string[] | undefined) ?? [];
          const filtered = dep.filter(d => d !== source);
          const newBase = { ...n.base };
          if (filtered.length === 0) delete newBase.depends_on;
          else newBase.depends_on = filtered;
          return { ...n, base: newBase };
        }),
      }));
    },

    renameNode: (oldId, newId): void => {
      if (oldId === newId) return;
      const state = get();
      if (state.nodes.some(n => n.id === newId)) {
        throw new Error(`renameNode: collision — '${newId}' already exists`);
      }
      if (!state.nodes.some(n => n.id === oldId)) {
        throw new Error(`renameNode: '${oldId}' not found`);
      }

      // Cascading rename — see spec §5.2 / §7.4.
      const renameRefs = (n: BuilderNode): BuilderNode => {
        const next: BuilderNode = { ...n, base: { ...n.base } };
        // 1. id itself
        if (next.id === oldId) next.id = newId;
        // 2. depends_on
        const dep = (next.base.depends_on as string[] | undefined) ?? undefined;
        if (dep) next.base.depends_on = dep.map(d => (d === oldId ? newId : d));
        // 3. when: strings ($oldId.* → $newId.*)
        const w = next.base.when as string | undefined;
        if (typeof w === 'string') {
          next.base.when = w.replace(new RegExp(`\\$${escapeRegExp(oldId)}\\b`, 'g'), `$${newId}`);
        }
        // 4. body-text refs ($oldId.output… in prompt/bash/script/loop.prompt/
        //    approval.message). Each variant declares its own rewriter via the
        //    optional `renameBodyRefs` slot; variants without body text omit it.
        const variantDef = defaultRegistry[next.variant];
        if (variantDef.renameBodyRefs) {
          next.data = variantDef.renameBodyRefs(next.data as never, oldId, newId);
        }
        return next;
      };
      set({ nodes: state.nodes.map(renameRefs) });
    },

    copySelection: async (): Promise<void> => {
      const { nodes, selectedNodeIds } = get();
      const selected = nodes.filter(n => selectedNodeIds.includes(n.id));
      if (selected.length === 0) return;
      const text = serializeClipboard(selected);
      set({ clipboard: text });
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // private mode or no permission — in-memory fallback already set
      }
    },

    pasteClipboard: async (): Promise<void> => {
      let text = get().clipboard;
      try {
        const fromBrowser = await navigator.clipboard.readText();
        if (fromBrowser) text = fromBrowser;
      } catch {
        // use in-memory fallback
      }
      if (!text) return;
      const envelope = parseClipboard(text);
      if (!envelope) return;

      // Build old→new id map
      const idMap = new Map<string, string>();
      const remapped = (envelope.nodes as BuilderNode[]).map(n => {
        const newId = `${n.id}-copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        idMap.set(n.id, newId);
        return { ...n, id: newId };
      });

      // Rewrite depends_on using remapped IDs
      const rewritten = remapped.map(n => ({
        ...n,
        base: {
          ...n.base,
          depends_on: ((n.base?.depends_on ?? []) as string[]).map(
            (dep: string) => idMap.get(dep) ?? dep
          ),
        },
      }));

      withUndo('paste', snapshot('paste'));

      // Build positions: offset each node by +30,+30 from its original position.
      // n.id at this point is the NEW id; use idMap (old→new) reversed to find origId.
      const newToOld = new Map<string, string>();
      idMap.forEach((newId, oldId) => newToOld.set(newId, oldId));

      const newPositions = { ...get().positions };
      rewritten.forEach(n => {
        const origId = newToOld.get(n.id);
        const origPos = origId ? get().positions[origId] : undefined;
        newPositions[n.id] = origPos
          ? { x: origPos.x + 30, y: origPos.y + 30 }
          : { x: 100, y: 100 };
      });

      set({ nodes: [...get().nodes, ...rewritten], positions: newPositions });
    },

    cutSelection: async (): Promise<void> => {
      await get().copySelection();
      get().removeSelected();
    },

    applySnapshot: (snap): void => {
      set({ nodes: snap.nodes as BuilderNode[], positions: snap.positions });
    },

    revertSnapshot: (snap): void => {
      set({ nodes: snap.nodes as BuilderNode[], positions: snap.positions });
    },

    applyUndo: (): void => {
      const undoStore = useUndoStore.getState();
      if (undoStore.past.length === 0) return;
      // Capture current (post-action) state — this becomes the redo target
      const { nodes, positions, workflow } = get();
      const label = undoStore.past[undoStore.past.length - 1].label;
      const snap = undoStore.undo(); // moves pre-action snap: past → future
      if (!snap) return;
      // Replace the future-top (pre-action) with current (post-action) so redo restores forward
      useUndoStore.setState(s => ({
        future: [
          { label, workflow: workflow ?? null, nodes: [...nodes], positions: { ...positions } },
          ...s.future.slice(1),
        ],
      }));
      get().applySnapshot(snap);
    },

    applyRedo: (): void => {
      const undoStore = useUndoStore.getState();
      if (undoStore.future.length === 0) return;
      // Capture current (pre-redo) state — this becomes the undo target
      const { nodes, positions, workflow } = get();
      const label = undoStore.future[0].label;
      const snap = undoStore.redo(); // moves post-action snap: future → past
      if (!snap) return;
      // Replace the past-top (post-action) with current (pre-redo) so undo can reverse
      useUndoStore.setState(s => ({
        past: [
          ...s.past.slice(0, -1),
          { label, workflow: workflow ?? null, nodes: [...nodes], positions: { ...positions } },
        ],
      }));
      get().applySnapshot(snap);
    },

    alignSelection: (direction): void => {
      const { selectedNodeIds, positions } = get();
      if (selectedNodeIds.length < 2) return;

      const NODE_W = 200,
        NODE_H = 60;
      const rects: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const id of selectedNodeIds) {
        const pos = positions[id] ?? { x: 0, y: 0 };
        rects[id] = { x: pos.x, y: pos.y, w: NODE_W, h: NODE_H };
      }

      const fn = {
        left: alignLeft,
        right: alignRight,
        top: alignTop,
        bottom: alignBottom,
        centerH: alignCenterH,
        centerV: alignCenterV,
      }[direction];
      const newPos = fn(rects);

      withUndo(`align-${direction}`, snapshot(`align-${direction}`));
      set({ positions: { ...positions, ...newPos } });
    },

    distributeSelection: (axis): void => {
      const { selectedNodeIds, positions } = get();
      if (selectedNodeIds.length < 3) return;

      const NODE_W = 200,
        NODE_H = 60;
      const rects: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const id of selectedNodeIds) {
        const pos = positions[id] ?? { x: 0, y: 0 };
        rects[id] = { x: pos.x, y: pos.y, w: NODE_W, h: NODE_H };
      }

      const fn = axis === 'h' ? distributeH : distributeV;
      const newPos = fn(rects);

      withUndo(`distribute-${axis}`, snapshot(`distribute-${axis}`));
      set({ positions: { ...positions, ...newPos } });
    },

    autoArrangeSelection: (): void => {
      const { nodes, selectedNodeIds, positions } = get();
      if (selectedNodeIds.length === 0) return;

      const selectedSet = new Set(selectedNodeIds);
      const selectedNodes = nodes.filter(n => selectedSet.has(n.id));

      // Build edges from depends_on within the selection only
      const edges = selectedNodes.flatMap(n =>
        ((n.base?.depends_on as string[] | undefined) ?? [])
          .filter((dep: string) => selectedSet.has(dep))
          .map((dep: string) => ({ id: `${dep}->${n.id}`, source: dep, target: n.id }))
      );

      const layoutPositions = layoutWithDagre(
        selectedNodes.map(n => ({ id: n.id, position: positions[n.id] ?? { x: 0, y: 0 } })),
        edges
      );

      if (layoutPositions.size === 0) return;

      withUndo('auto-arrange', snapshot('auto-arrange'));

      const newPositions = { ...positions };
      layoutPositions.forEach((pos, id) => {
        newPositions[id] = pos;
      });
      set({ positions: newPositions });
    },
  }; // end return
}); // end create

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
