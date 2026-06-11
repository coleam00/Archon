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
import { useCallback, useState, type DragEvent, type ReactElement } from 'react';
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
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { VariantId } from '../types';
import type { BuilderFlowEdge, BuilderFlowNode, XYPosition } from '../flow/types';
import { BUILDER_NODE_TYPE } from '../flow/to-flow';
import { NODE_HEIGHT, NODE_WIDTH } from '../flow/layout';
import { computeGuides, GUIDE_THRESHOLD, type Rect } from '../editor/smart-guides';
import { builderNodeView } from './BuilderNodeView';
import { SmartGuides } from './SmartGuides';

/** dataTransfer MIME key the palette writes and the canvas reads. */
export const PALETTE_DATA_KEY = 'application/archon-builder-variant';

const NODE_TYPES = { [BUILDER_NODE_TYPE]: builderNodeView };

interface BuilderCanvasProps {
  nodes: BuilderFlowNode[];
  edges: BuilderFlowEdge[];
  onMoveNodes: (moves: readonly { id: string; position: XYPosition }[]) => void;
  onSelectionChange: (nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>) => void;
  onConnect: (source: string, target: string) => void;
  onAddNode: (variant: VariantId, position: XYPosition) => void;
  onInit: (instance: ReactFlowInstance<BuilderFlowNode, BuilderFlowEdge>) => void;
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
  onSelectionChange,
  onConnect,
  onAddNode,
  onInit,
}: BuilderCanvasProps): ReactElement {
  const { screenToFlowPosition } = useReactFlow();
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] }>({
    vertical: [],
    horizontal: [],
  });

  const handleNodesChange = useCallback(
    (changes: NodeChange<BuilderFlowNode>[]): void => {
      const positionChanges = changes.filter(
        c => c.type === 'position' && c.position !== undefined
      );
      if (positionChanges.length === 0) return;

      const dragging = positionChanges.some(c => c.type === 'position' && c.dragging === true);
      const moves: { id: string; position: XYPosition }[] = [];

      if (positionChanges.length === 1 && dragging) {
        // Single-node drag: compute helper lines and snap to the closest one.
        const change = positionChanges[0];
        if (change.type !== 'position' || change.position === undefined) return;
        const node = nodes.find(n => n.id === change.id);
        if (node === undefined) return;
        const others = nodes.filter(n => n.id !== change.id).map(n => rectOf(n, n.position));
        const result = computeGuides(rectOf(node, change.position), others, GUIDE_THRESHOLD);
        setGuides({ vertical: result.vertical, horizontal: result.horizontal });
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
    [nodes, guides, onMoveNodes]
  );

  // Selection flows through onSelectionChange below; edge data changes flow
  // through the reducer. Nothing to apply here, but xyflow requires the
  // handler for edges to be selectable at all.
  const handleEdgesChange = useCallback((_changes: EdgeChange<BuilderFlowEdge>[]): void => {
    // no-op: selection is handled by handleSelectionChange, removal by the keymap
  }, []);

  const handleSelectionChange = useCallback(
    (params: OnSelectionChangeParams<BuilderFlowNode, BuilderFlowEdge>): void => {
      onSelectionChange(new Set(params.nodes.map(n => n.id)), new Set(params.edges.map(e => e.id)));
    },
    [onSelectionChange]
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
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onAddNode(variant as VariantId, {
        x: point.x - NODE_WIDTH / 2,
        y: point.y - NODE_HEIGHT / 2,
      });
    },
    [screenToFlowPosition, onAddNode]
  );

  return (
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
      panOnDrag={[1, 2]}
      deleteKeyCode={null}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onSelectionChange={handleSelectionChange}
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
