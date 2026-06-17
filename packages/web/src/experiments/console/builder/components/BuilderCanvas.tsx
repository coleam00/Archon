/**
 * The builder canvas: a controlled `ReactFlow` over nodes/edges derived from
 * the editor state. The canvas owns no workflow data — every change (drag,
 * connect, drop, selection) is emitted up to `BuilderPage`'s reducer.
 *
 * Drag positions snap to the smart guides (editor/smart-guides.ts) when a
 * single node is dragged; the guide lines render via the `SmartGuides`
 * overlay. Deletion is keymap-owned (`deleteKeyCode={null}`) so Delete /
 * Backspace behave identically inside and outside the canvas.
 */
import {
  useCallback,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import { VARIANTS, VARIANT_REGISTRY, isVariantId } from '../variants';
import type { VariantId } from '../types';
import type { BuilderFlowEdge, BuilderFlowNode, XYPosition } from '../flow/types';
import { BUILDER_NODE_TYPE } from '../flow/to-flow';
import { NODE_HEIGHT, NODE_WIDTH } from '../flow/layout';
import { computeGuides, GUIDE_THRESHOLD, type Rect } from '../editor/smart-guides';
import { builderNodeView } from './BuilderNodeView';
import { SmartGuides } from './SmartGuides';
import { BuilderContextMenu, type MenuEntry } from './BuilderContextMenu';

/** dataTransfer MIME key the palette writes and the canvas reads. */
export const PALETTE_DATA_KEY = 'application/archon-builder-variant';

const NODE_TYPES = { [BUILDER_NODE_TYPE]: builderNodeView };

interface BuilderCanvasProps {
  nodes: BuilderFlowNode[];
  edges: BuilderFlowEdge[];
  onMoveNodes: (moves: readonly { id: string; position: XYPosition }[]) => void;
  /** Per-element selection deltas (xyflow's only selection channel in controlled mode). */
  onSelectDelta: (
    nodes: readonly { id: string; selected: boolean }[],
    edges: readonly { id: string; selected: boolean }[]
  ) => void;
  onConnect: (source: string, target: string) => void;
  onAddNode: (variant: VariantId, position: XYPosition) => void;
  onInit: (instance: ReactFlowInstance<BuilderFlowNode, BuilderFlowEdge>) => void;
  /** Replace the whole selection (used when right-clicking an unselected element). */
  onSetSelection: (nodeIds: readonly string[], edgeIds: readonly string[]) => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onAutoArrange: () => void;
  onFitView: () => void;
  hasClipboard: boolean;
  selectedNodeCount: number;
  selectedEdgeCount: number;
}

/** Open context menu: viewport anchor + the flow point under the cursor. */
interface MenuState {
  x: number;
  y: number;
  flow: XYPosition;
  target: 'pane' | 'node' | 'edge';
}

function rectOf(node: BuilderFlowNode, position: XYPosition): Rect {
  return {
    id: node.id,
    x: position.x,
    y: position.y,
    width: node.measured?.width ?? NODE_WIDTH,
    height: node.measured?.height ?? NODE_HEIGHT,
  };
}

function CanvasInner({
  nodes,
  edges,
  onMoveNodes,
  onSelectDelta,
  onConnect,
  onAddNode,
  onInit,
  onSetSelection,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  onDelete,
  onSelectAll,
  onAutoArrange,
  onFitView,
  hasClipboard,
  selectedNodeCount,
  selectedEdgeCount,
}: BuilderCanvasProps): ReactElement {
  const { screenToFlowPosition } = useReactFlow();
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] }>({
    vertical: [],
    horizontal: [],
  });
  const [menu, setMenu] = useState<MenuState | null>(null);

  const handleNodesChange = useCallback(
    (changes: NodeChange<BuilderFlowNode>[]): void => {
      // Selection: xyflow emits `select` changes here (controlled mode never
      // updates its store directly), so this is the only place node clicks and
      // marquee selection are observable. Forward them before the early return.
      const selects: { id: string; selected: boolean }[] = [];
      for (const c of changes) {
        if (c.type === 'select') selects.push({ id: c.id, selected: c.selected });
      }
      if (selects.length > 0) onSelectDelta(selects, []);

      const positionChanges = changes.filter(
        c => c.type === 'position' && c.position !== undefined
      );
      if (positionChanges.length === 0) return;

      const dragging = positionChanges.some(c => c.type === 'position' && c.dragging === true);
      const moves: { id: string; position: XYPosition }[] = [];

      if (positionChanges.length === 1) {
        // Single-node move: compute helper lines and snap to the closest one.
        // Snapping must run for the FINAL change too (xyflow emits a last
        // `position` change with `dragging: false` on drop, and in controlled
        // mode that raw position would otherwise overwrite the snapped one).
        // Guides are a drag-time affordance, so only show them while dragging.
        const change = positionChanges[0];
        if (change.type !== 'position' || change.position === undefined) return;
        const node = nodes.find(n => n.id === change.id);
        if (node === undefined) return;
        const others = nodes.filter(n => n.id !== change.id).map(n => rectOf(n, n.position));
        const result = computeGuides(rectOf(node, change.position), others, GUIDE_THRESHOLD);
        setGuides(
          dragging
            ? { vertical: result.vertical, horizontal: result.horizontal }
            : { vertical: [], horizontal: [] }
        );
        moves.push({ id: change.id, position: result.snap });
      } else {
        if (guides.vertical.length > 0 || guides.horizontal.length > 0) {
          setGuides({ vertical: [], horizontal: [] });
        }
        for (const change of positionChanges) {
          if (change.type === 'position' && change.position !== undefined) {
            moves.push({ id: change.id, position: change.position });
          }
        }
      }

      if (!dragging) setGuides({ vertical: [], horizontal: [] });
      onMoveNodes(moves);
    },
    [nodes, guides, onMoveNodes, onSelectDelta]
  );

  // Edges are selectable only because we forward their `select` changes: in
  // controlled mode xyflow drops them unless onEdgesChange applies them, so a
  // no-op handler (the previous behavior) made edges impossible to select or
  // delete. Edge removal still runs through the keymap (deleteKeyCode={null}).
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<BuilderFlowEdge>[]): void => {
      const selects: { id: string; selected: boolean }[] = [];
      for (const c of changes) {
        if (c.type === 'select') selects.push({ id: c.id, selected: c.selected });
      }
      if (selects.length > 0) onSelectDelta([], selects);
    },
    [onSelectDelta]
  );

  const handleConnect = useCallback(
    (connection: Connection): void => {
      if (connection.source.length > 0 && connection.target.length > 0) {
        onConnect(connection.source, connection.target);
      }
    },
    [onConnect]
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.types.includes(PALETTE_DATA_KEY)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      const variant = event.dataTransfer.getData(PALETTE_DATA_KEY);
      if (variant.length === 0) return;
      event.preventDefault();
      // The MIME key is namespaced to the builder, but a foreign drag could
      // still carry an unrecognized payload under it. Validate against the
      // registry before casting — otherwise VARIANT_REGISTRY[unknown] is
      // undefined and `.defaultData()` throws on a stray drop.
      if (!isVariantId(variant)) return;
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onAddNode(variant, {
        x: point.x - NODE_WIDTH / 2,
        y: point.y - NODE_HEIGHT / 2,
      });
    },
    [screenToFlowPosition, onAddNode]
  );

  const closeMenu = useCallback((): void => {
    setMenu(null);
  }, []);

  /** Build the menu anchor (and flow point) from a right-click event. */
  const openMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent, target: MenuState['target']): void => {
      event.preventDefault();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        target,
      });
    },
    [screenToFlowPosition]
  );

  // ONE contextmenu handler on the canvas wrapper — NOT React Flow's
  // onPaneContextMenu/onNodeContextMenu. Those route through React Flow's
  // `wrapHandler`, which fires onPaneContextMenu ONLY when `event.target` is
  // *exactly* the `.react-flow__pane` element; a real cursor right-click whose
  // target is a pane child (the background dots, the viewport, a node's inner
  // text) is silently dropped, so the menu never opens for real clicks even
  // though a synthetic dispatch on the pane works. Handling the *bubbled*
  // contextmenu here catches every right-click in the canvas and classifies it
  // by walking the DOM. Right-clicking an unselected element replaces the
  // selection with it; right-clicking inside a multi-selection keeps it. The
  // mini-map / controls keep their native menu.
  const handleCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const targetEl = event.target instanceof HTMLElement ? event.target : null;
      if (targetEl === null) return;
      // The open menu itself and React Flow chrome are not the canvas surface.
      if (targetEl.closest('[role="menu"]') !== null) return;
      if (
        targetEl.closest(
          '.react-flow__minimap, .react-flow__controls, .react-flow__attribution'
        ) !== null
      ) {
        return;
      }
      const nodeId = targetEl.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      const edgeId = targetEl.closest<HTMLElement>('.react-flow__edge')?.dataset.id;
      if (nodeId !== undefined && nodeId.length > 0) {
        if (nodes.find(n => n.id === nodeId)?.selected !== true) onSetSelection([nodeId], []);
        openMenu(event, 'node');
      } else if (edgeId !== undefined && edgeId.length > 0) {
        if (edges.find(e => e.id === edgeId)?.selected !== true) onSetSelection([], [edgeId]);
        openMenu(event, 'edge');
      } else {
        openMenu(event, 'pane');
      }
    },
    [nodes, edges, onSetSelection, openMenu]
  );

  const menuEntries = useCallback(
    (m: MenuState): MenuEntry[] => {
      if (m.target === 'edge') {
        return [
          {
            kind: 'item',
            label: selectedEdgeCount > 1 ? 'Delete connectors' : 'Delete connector',
            danger: true,
            hint: 'Del',
            onSelect: onDelete,
          },
        ];
      }
      if (m.target === 'node') {
        const many = selectedNodeCount > 1;
        return [
          { kind: 'item', label: 'Cut', hint: 'x', onSelect: onCut },
          { kind: 'item', label: 'Copy', hint: 'y', onSelect: onCopy },
          { kind: 'item', label: 'Duplicate', onSelect: onDuplicate },
          { kind: 'separator' },
          {
            kind: 'item',
            label: many ? 'Delete nodes' : 'Delete node',
            danger: true,
            hint: 'Del',
            onSelect: onDelete,
          },
        ];
      }
      // Pane menu.
      return [
        {
          kind: 'submenu',
          label: 'Add node here',
          items: VARIANTS.map(variant => ({
            kind: 'item' as const,
            label: VARIANT_REGISTRY[variant].label,
            onSelect: (): void => {
              onAddNode(variant, {
                x: m.flow.x - NODE_WIDTH / 2,
                y: m.flow.y - NODE_HEIGHT / 2,
              });
            },
          })),
        },
        { kind: 'separator' },
        { kind: 'item', label: 'Paste', hint: 'P', disabled: !hasClipboard, onSelect: onPaste },
        { kind: 'item', label: 'Select all', hint: 'a', onSelect: onSelectAll },
        { kind: 'separator' },
        { kind: 'item', label: 'Auto-arrange', hint: 'A', onSelect: onAutoArrange },
        { kind: 'item', label: 'Fit view', hint: 'f', onSelect: onFitView },
      ];
    },
    [
      selectedEdgeCount,
      selectedNodeCount,
      hasClipboard,
      onCut,
      onCopy,
      onDuplicate,
      onDelete,
      onAddNode,
      onPaste,
      onSelectAll,
      onAutoArrange,
      onFitView,
    ]
  );

  return (
    <div className="relative h-full w-full" onContextMenu={handleCanvasContextMenu}>
      <ReactFlow<BuilderFlowNode, BuilderFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode="dark"
        fitView
        minZoom={0.2}
        snapToGrid
        snapGrid={[8, 8]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        // Middle-button drag pans (plus Space+drag); the right button is left
        // free so the canvas can own a custom context menu.
        panOnDrag={[1]}
        panActivationKeyCode="Space"
        deleteKeyCode={null}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onInit={onInit}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        style={{ background: 'var(--surface-inset)' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
        <MiniMap
          pannable
          zoomable
          style={{ background: 'var(--surface-inset)' }}
          maskColor="color-mix(in oklch, var(--surface-inset), transparent 40%)"
          nodeColor={(n): string => `var(--node-${(n as BuilderFlowNode).data.node.variant})`}
        />
        <Controls showInteractive={false} />
        <SmartGuides vertical={guides.vertical} horizontal={guides.horizontal} />
      </ReactFlow>
      {menu !== null ? (
        <BuilderContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu)} onClose={closeMenu} />
      ) : null}
    </div>
  );
}

/** Provider wrapper so canvas internals can use xyflow hooks. */
export function BuilderCanvas(props: BuilderCanvasProps): ReactElement {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
