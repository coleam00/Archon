import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  useReactFlow,
  useStoreApi,
  type NodeChange,
  type Node as RFNode,
  type NodeProps,
} from '@xyflow/react';
import { useHotkeys } from 'react-hotkeys-hook';
import '@xyflow/react/dist/style.css';
import './Canvas.css';

import { SHORTCUTS } from '../shortcuts';
import { useBuilderStore } from '../store/builder-store';
import { withUndo } from '../store/undo-store';
import { deriveFlow, type DagNodeData } from './canvas/deriveFlow';
import { layoutWithDagre } from '../hooks/useDagre';
import { usePositionContext } from '../hooks/PositionContext';
import { defaultRegistry } from '../nodes/default-registry';
import { VARIANT_IDS } from '../nodes/registry';
import { LIBRARY_DRAG_MIME, decodeLibraryDrag } from './library/dragPayload';
import { loadSnippet } from '../snippets';
import { insertSnippet } from '../snippets/insertSnippet';
import {
  makeOnNodesChange,
  makeOnConnect,
  makeOnEdgesDelete,
  makeOnNodesDelete,
} from './canvas/canvasHandlers';
import { computeGuides } from '../smart-guides';
import { SmartGuidesLayer } from './SmartGuidesLayer';
import { CanvasContextMenu } from './CanvasContextMenu';

// Hoisted to module scope so the array reference is stable across renders —
// passing a fresh array to React Flow every render forces RF to re-init its
// key-handling state machine.
const MULTI_SELECTION_KEY_CODE: string[] = ['Meta', 'Shift', 'Control'];

export function Canvas(): JSX.Element {
  const positions = usePositionContext();
  const reactFlow = useReactFlow();
  const storeApi = useStoreApi();

  const storeNodes = useBuilderStore(s => s.nodes);
  const connect = useBuilderStore(s => s.connect);
  const disconnect = useBuilderStore(s => s.disconnect);
  const deleteNodes = useBuilderStore(s => s.deleteNodes);
  const addNodeFromVariant = useBuilderStore(s => s.addNodeFromVariant);
  const setSelection = useBuilderStore(s => s.setSelection);
  const addToSelection = useBuilderStore(s => s.addToSelection);
  const clearSelection = useBuilderStore(s => s.clearSelection);
  const primarySelectionId = useBuilderStore(s => s.primarySelectionId);
  const selectedNodeIds = useBuilderStore(s => s.selectedNodeIds);
  const setHoveredNodeId = useBuilderStore(s => s.setHoveredNodeId);
  const setNodePosition = useBuilderStore(s => s.setNodePosition);
  const activeGuides = useBuilderStore(s => s.activeGuides);
  const setActiveGuides = useBuilderStore(s => s.setActiveGuides);
  const gridSnap = useBuilderStore(s => s.gridSnap);
  const canvasMode = useBuilderStore(s => s.canvasMode);
  const setCanvasMode = useBuilderStore(s => s.setCanvasMode);
  const interactive = useBuilderStore(s => s.interactive);
  const toggleInteractive = useBuilderStore(s => s.toggleInteractive);
  const toggleGridSnap = useBuilderStore(s => s.toggleGridSnap);

  // Canvas hotkeys. enableOnFormTags:false means typing in the inspector
  // doesn't trigger these single-letter shortcuts.
  const hkOpts = { enableOnFormTags: false, enableOnContentEditable: false } as const;
  useHotkeys(
    SHORTCUTS.modePan,
    e => {
      e.preventDefault();
      setCanvasMode('pan');
    },
    hkOpts
  );
  useHotkeys(
    SHORTCUTS.modeSelect,
    e => {
      e.preventDefault();
      setCanvasMode('select');
    },
    hkOpts
  );
  useHotkeys(
    SHORTCUTS.fitView,
    e => {
      e.preventDefault();
      reactFlow.fitView({ duration: 300 });
    },
    hkOpts
  );
  useHotkeys(
    SHORTCUTS.toggleInteractive,
    e => {
      e.preventDefault();
      toggleInteractive();
    },
    hkOpts
  );
  useHotkeys(
    SHORTCUTS.toggleGrid,
    e => {
      e.preventDefault();
      toggleGridSnap();
    },
    hkOpts
  );

  // Build the React Flow nodeTypes map from the variant registry. Each per-variant
  // Renderer is registered under its own variant id; deriveFlow emits `type: variant`,
  // so React Flow dispatches to the correct component. The cast is justified at the
  // dispatcher boundary — typed `TData` is reclaimed inside each Renderer.
  const nodeTypes = useMemo(
    () =>
      Object.fromEntries(VARIANT_IDS.map(id => [id, defaultRegistry[id].Renderer])) as Record<
        string,
        ComponentType<NodeProps>
      >,
    []
  );

  // Derive RF nodes/edges from the store. `deriveFlow` returns {x:0,y:0} for
  // any node missing from the persistence map; we overlay seeded/persisted
  // positions when rendering below.
  const selectedNodeIdsSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const { rfNodes: derivedNodes, rfEdges } = useMemo(
    () => deriveFlow(storeNodes, positions.positions, selectedNodeIdsSet),
    [storeNodes, positions.positions, selectedNodeIdsSet]
  );

  // Local in-flight node array for React Flow. We hydrate it from `derivedNodes`
  // whenever the *set* of node ids changes (load, add, delete) but otherwise let
  // applyNodeChanges drive it during drag/select so the canvas stays smooth.
  const [rfNodes, setRfNodes] = useState<RFNode<DagNodeData>[]>(derivedNodes);

  const idsKey = useMemo(() => storeNodes.map(n => n.id).join(' '), [storeNodes]);

  // Re-hydrate the in-flight rfNodes whenever:
  //   - the set of node ids changes (load, add, delete), OR
  //   - the positions map is replaced (e.g., Reset Layout clears it and the
  //     seed effect below repopulates with fresh dagre output), OR
  //   - the store's BuilderNode content changes (Inspector edit, rename
  //     cascade) — without this, RFNode.data.node holds a stale reference
  //     and the per-variant Renderer keeps painting old field values.
  // Drag-end ALSO produces a new positions map (Map identity churns), but
  // `applyNodeChanges` has already updated rfNodes with the same final
  // position, so the rehydrate is idempotent.
  useEffect(() => {
    setRfNodes(
      derivedNodes.map(n => ({
        ...n,
        position: positions.positions.get(n.id) ?? n.position,
      }))
    );
  }, [derivedNodes, positions.positions]);

  // Seed positions for any node id NOT already in the map.
  // Branches:
  //   1. missing.length === 0 → no-op (every node already has a position).
  //   2. positions empty (first-load OR Reset Layout) → full dagre on whole graph.
  //   3. partial-miss (some positions persisted) → seed missing ids at origin.
  // Listening on `positions.positions` (not just idsKey) is what makes the
  // Reset Layout button visible: Reset clears the map, this effect re-fires
  // with branch 2, dagre re-runs, the rehydrate effect above propagates the
  // new positions into rfNodes.
  useEffect(() => {
    const missing = derivedNodes.filter(n => !positions.positions.has(n.id));
    if (missing.length === 0) return;
    if (positions.positions.size === 0) {
      const laid = layoutWithDagre(derivedNodes, rfEdges);
      const newEntries: [string, { x: number; y: number }][] = derivedNodes
        .map(n => [n.id, laid.get(n.id)] as const)
        .filter((entry): entry is [string, { x: number; y: number }] => entry[1] !== undefined);
      if (newEntries.length > 0) positions.setMany(newEntries);
    } else {
      // Drag-drop sets its own position before this effect runs so it never
      // hits this branch. Click-to-add (NodeLibrary onActivate) does land
      // here — by design, click is the keyboard-friendly fallback and the
      // user drags the new node into place.
      positions.setMany(missing.map(n => [n.id, { x: 0, y: 0 }]));
    }
  }, [idsKey, positions.positions]);

  // Persistence hook — drag-end only. Pure factory tested in canvasHandlers.spec.ts.
  const persistOnNodesChange = useMemo(() => makeOnNodesChange(positions), [positions]);

  // Forward every change to React Flow's internal state AND record drag-end persistence.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes(prev => applyNodeChanges(changes, prev) as RFNode<DagNodeData>[]);
      persistOnNodesChange(changes);
    },
    [persistOnNodesChange]
  );

  // Pan the primary selection into view when selection changes programmatically
  // (e.g., from ValidationPanel row click). The `selected` flag on rfNodes is
  // already driven by deriveFlow + the rehydrate effect above; no need to
  // re-apply it here.
  useEffect(() => {
    if (primarySelectionId) {
      const node = reactFlow.getNode(primarySelectionId);
      if (node) {
        const cx = node.position.x + (node.measured?.width ?? 150) / 2;
        const cy = node.position.y + (node.measured?.height ?? 40) / 2;
        reactFlow.setCenter(cx, cy, { duration: 300, zoom: reactFlow.getZoom() });
      }
    }
  }, [primarySelectionId, reactFlow]);

  const onConnect = useMemo(() => makeOnConnect(connect), [connect]);
  const onEdgesDelete = useMemo(() => makeOnEdgesDelete(disconnect), [disconnect]);
  const onNodesDelete = useMemo(() => makeOnNodesDelete(deleteNodes), [deleteNodes]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
      const payload = decodeLibraryDrag(raw);
      if (!payload) return;
      e.preventDefault();
      const flowPos = reactFlow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (payload.kind === 'variant') {
        const id = addNodeFromVariant(payload.variantId, {
          idHintOverride: payload.idHintOverride,
          dataPatch: payload.prefill,
        });
        positions.setPosition(id, flowPos);
      }
      if (payload.kind === 'snippet') {
        insertSnippet({
          yaml: loadSnippet(payload.category, payload.name),
          anchorPosition: flowPos,
          setPosition: positions.setPosition,
        });
      }
      if (payload.kind === 'user-snippet') {
        insertSnippet({
          yaml: payload.yaml,
          anchorPosition: flowPos,
          setPosition: positions.setPosition,
        });
      }
    },
    [reactFlow, addNodeFromVariant, positions]
  );

  const NODE_W = 200,
    NODE_H = 60;

  // Right-click context menu (PowerPoint-style align/distribute). The menu is
  // positioned relative to the canvas container, so we use its bounding rect
  // to convert the MouseEvent's clientX/clientY into local coords.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-pan during marquee selection. React Flow ships autoPanOnNodeDrag and
  // autoPanOnConnect but has no equivalent for the selection marquee in v12,
  // so we drive it ourselves. Triggered by React Flow's own onSelectionStart /
  // onSelectionEnd callbacks so the gesture lifecycle is exact (no guessing
  // from pointerdown targets). We use the store's `panBy` — the same primitive
  // XYDrag uses for node-drag autopan — instead of setViewport, because panBy
  // is the canonical way to nudge the viewport during an active gesture.
  const autoPanRef = useRef<{
    raf: number | null;
    pointer: { x: number; y: number } | null;
    onMove: ((e: PointerEvent) => void) | null;
  }>({ raf: null, pointer: null, onMove: null });

  const stopAutoPan = useCallback(() => {
    const s = autoPanRef.current;
    if (s.raf !== null) {
      cancelAnimationFrame(s.raf);
      s.raf = null;
    }
    if (s.onMove) {
      window.removeEventListener('pointermove', s.onMove, true);
      s.onMove = null;
    }
    s.pointer = null;
  }, []);

  const startAutoPan = useCallback(
    (initial: { clientX: number; clientY: number }) => {
      const container = containerRef.current;
      if (!container) return;
      const EDGE = 30;
      const MAX_SPEED = 18;
      const state = autoPanRef.current;
      state.pointer = { x: initial.clientX, y: initial.clientY };

      const onMove = (e: PointerEvent): void => {
        state.pointer = { x: e.clientX, y: e.clientY };
      };
      state.onMove = onMove;
      window.addEventListener('pointermove', onMove, true);

      const tick = (): void => {
        const p = state.pointer;
        if (!p) {
          state.raf = null;
          return;
        }
        const rect = container.getBoundingClientRect();
        const leftDist = p.x - rect.left;
        const rightDist = rect.right - p.x;
        const topDist = p.y - rect.top;
        const bottomDist = rect.bottom - p.y;

        // panBy adds delta to the viewport transform directly:
        //   right edge → reveal content to the right → viewport.x decreases → dx < 0
        //   left  edge → reveal content to the left  → viewport.x increases → dx > 0
        //   bottom edge → reveal below → viewport.y decreases → dy < 0
        //   top    edge → reveal above → viewport.y increases → dy > 0
        let dx = 0;
        let dy = 0;
        if (leftDist < EDGE) dx = ((EDGE - Math.max(leftDist, 0)) / EDGE) * MAX_SPEED;
        else if (rightDist < EDGE) dx = -((EDGE - Math.max(rightDist, 0)) / EDGE) * MAX_SPEED;
        if (topDist < EDGE) dy = ((EDGE - Math.max(topDist, 0)) / EDGE) * MAX_SPEED;
        else if (bottomDist < EDGE) dy = -((EDGE - Math.max(bottomDist, 0)) / EDGE) * MAX_SPEED;

        if (dx !== 0 || dy !== 0) {
          // CRITICAL: when the marquee starts, React Flow sets
          // userSelectionActive=true which causes XYPanZoom.update() to call
          // destroy() — that unbinds d3-zoom's 'zoom' event listener (see
          // @xyflow/system index.js:2909). Any panBy / setViewport call still
          // updates d3-zoom's internal __zoom, but the listener that would
          // propagate it into store.transform is gone, so the viewport CSS
          // never re-renders. We bypass that by writing transform directly
          // into the store (Viewport reads transform[0..2] to build its CSS
          // transform) and then calling syncViewport so __zoom stays in sync
          // for the next real wheel/pan gesture after the marquee ends.
          const s = storeApi.getState() as unknown as {
            transform: [number, number, number];
            userSelectionRect?: {
              startX: number;
              startY: number;
              x: number;
              y: number;
              width: number;
              height: number;
            } | null;
            panZoom?: { syncViewport: (v: { x: number; y: number; zoom: number }) => void };
          };
          const [tx, ty, tz] = s.transform;
          const nx = tx + dx;
          const ny = ty + dy;
          // Shift the marquee's start anchor by the same delta so it stays
          // pinned to the flow point the user originally clicked on, rather
          // than to a fixed container pixel (which would slide across the
          // canvas as we pan). The pane's onPointerMove will rebuild
          // x/y/width/height from this new startX/startY + the synthetic
          // pointermove we dispatch below.
          const rect = s.userSelectionRect;
          const nextPatch: Record<string, unknown> = { transform: [nx, ny, tz] };
          if (rect) {
            nextPatch.userSelectionRect = {
              ...rect,
              startX: rect.startX + dx,
              startY: rect.startY + dy,
            };
          }
          storeApi.setState(nextPatch as Parameters<typeof storeApi.setState>[0]);
          s.panZoom?.syncViewport({ x: nx, y: ny, zoom: tz });

          // The pane only recomputes which nodes fall inside the marquee on
          // real pointermove events (Pane.onPointerMove in @xyflow/react). If
          // the cursor sits still at the edge while we pan, the selection
          // would freeze. Synthesize a pointermove at the cursor's current
          // screen position to make React Flow re-run getNodesInside against
          // the just-updated transform.
          const pane = container.querySelector('.react-flow__pane');
          if (pane) {
            pane.dispatchEvent(
              new PointerEvent('pointermove', {
                clientX: p.x,
                clientY: p.y,
                bubbles: true,
                cancelable: true,
                pointerType: 'mouse',
              })
            );
          }
        }
        state.raf = requestAnimationFrame(tick);
      };

      if (state.raf === null) state.raf = requestAnimationFrame(tick);
    },
    [storeApi]
  );

  // Make sure the loop is torn down if Canvas unmounts mid-drag.
  useEffect(() => stopAutoPan, [stopAutoPan]);

  const openContextMenu = useCallback(
    (event: { clientX: number; clientY: number; preventDefault: () => void }, nodeId?: string) => {
      event.preventDefault();
      // If right-clicking a node not in the current selection, replace the
      // selection with that one node so the menu state matches what the user
      // visually targeted. Matches PowerPoint's right-click behavior.
      if (nodeId) {
        const sel = useBuilderStore.getState().selectedNodeIds;
        if (!sel.includes(nodeId)) setSelection([nodeId]);
      }
      const rect = containerRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      setContextMenu({ x: event.clientX - left, y: event.clientY - top });
    },
    [setSelection]
  );

  return (
    <div
      ref={containerRef}
      onDrop={onDrop}
      onDragOver={onDragOver}
      data-canvas-mode={canvasMode}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeClick={(event, node) => {
          if (event.shiftKey) {
            addToSelection(node.id);
          } else {
            setSelection([node.id]);
          }
        }}
        onPaneClick={() => {
          clearSelection();
        }}
        onNodeContextMenu={(event, node) => {
          openContextMenu(event, node.id);
        }}
        onPaneContextMenu={event => {
          openContextMenu(event);
        }}
        onSelectionContextMenu={event => {
          openContextMenu(event);
        }}
        onSelectionStart={event => {
          // Fires once the marquee actually begins (after paneClickDistance is
          // exceeded). This is the precise lifecycle hook we need — not a
          // pointerdown heuristic.
          startAutoPan({ clientX: event.clientX, clientY: event.clientY });
        }}
        onSelectionEnd={() => {
          stopAutoPan();
          // Marquee released. Read RF's selected nodes once and mirror into
          // our store. Deferred via queueMicrotask so the store write happens
          // *after* RF finishes its current render commit — writing inside
          // RF's render (as onSelectionChange does) caused a setState-during-
          // render feedback loop.
          queueMicrotask(() => {
            const selected = reactFlow.getNodes().filter(n => n.selected);
            const ids = selected.map(n => n.id);
            const current = useBuilderStore.getState().selectedNodeIds;
            const sortedNext = [...ids].sort();
            const sortedCurr = [...current].sort();
            if (
              sortedNext.length === sortedCurr.length &&
              sortedNext.every((id, i) => id === sortedCurr[i])
            ) {
              return;
            }
            setSelection(ids);
          });
        }}
        selectNodesOnDrag={false}
        panOnDrag={canvasMode === 'pan' && interactive}
        selectionOnDrag={canvasMode === 'select' && interactive}
        multiSelectionKeyCode={MULTI_SELECTION_KEY_CODE}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        elementsSelectable={interactive}
        onNodeMouseEnter={(_e, node) => {
          setHoveredNodeId(node.id);
        }}
        onNodeMouseLeave={() => {
          setHoveredNodeId(null);
        }}
        onNodeDrag={(_event, node) => {
          const allNodes = useBuilderStore.getState().nodes;
          const allPositions = useBuilderStore.getState().positions;
          const draggingRect = {
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            w: NODE_W,
            h: NODE_H,
          };
          const stationary = allNodes
            .filter(n => n.id !== node.id)
            .map(n => {
              const pos = allPositions[n.id] ?? { x: 0, y: 0 };
              return { id: n.id, x: pos.x, y: pos.y, w: NODE_W, h: NODE_H };
            });
          const guides = computeGuides(draggingRect, stationary, 8);
          setActiveGuides(guides);
        }}
        onNodeDragStop={(_event, node) => {
          setActiveGuides([]);
          withUndo('drag node', {
            label: 'drag node',
            workflow: useBuilderStore.getState().workflow ?? null,
            nodes: [...useBuilderStore.getState().nodes],
            positions: { ...useBuilderStore.getState().positions },
          });
          setNodePosition(node.id, node.position.x, node.position.y);
        }}
        snapToGrid={gridSnap}
        snapGrid={[20, 20]}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls position="top-left" />
      </ReactFlow>
      <SmartGuidesLayer guides={activeGuides} width={800} height={600} />
      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => {
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}
