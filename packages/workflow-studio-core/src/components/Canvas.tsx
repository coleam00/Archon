import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
  type Node as RFNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './Canvas.css';

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

export function Canvas(): JSX.Element {
  const positions = usePositionContext();
  const reactFlow = useReactFlow();

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
    },
    [reactFlow, addNodeFromVariant, positions]
  );

  const NODE_W = 200,
    NODE_H = 60;

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
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
    </div>
  );
}
