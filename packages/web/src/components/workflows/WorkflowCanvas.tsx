import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ReactFlow,
  addEdge,
  useReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  OnConnect,
  OnNodesChange,
  OnEdgesChange,
  NodeTypes,
} from '@xyflow/react';
import type { CommandEntry, DagNode } from '@/lib/api';
import { dagNodeComponent, type DagFlowNode } from './DagNodeComponent';
import { QuickAddPicker } from './QuickAddPicker';

export { dagNodesToReactFlow } from '@/lib/dag-layout';

function resolveNodeLabel(nodeType: 'command' | 'prompt' | 'bash', commandName: string): string {
  if (nodeType === 'command') return commandName;
  if (nodeType === 'bash') return 'Shell';
  return 'Prompt';
}

export function reactFlowToDagNodes(rfNodes: DagFlowNode[], rfEdges: Edge[]): DagNode[] {
  return rfNodes.map(node => {
    const deps = rfEdges.filter(e => e.target === node.id).map(e => e.source);

    const dagBase = {
      id: node.id,
      depends_on: deps.length > 0 ? deps : undefined,
      when: node.data.when || undefined,
      trigger_rule: node.data.trigger_rule || undefined,
    };

    if (node.data.nodeType === 'bash') {
      // DagNode uses `never` discriminant fields that can't be set on object literals
      return {
        ...dagBase,
        bash: node.data.bashScript ?? '',
        ...(node.data.bashTimeout ? { timeout: node.data.bashTimeout } : {}),
      } as DagNode;
    }

    // AI node fields (not applicable to bash)
    const aiBase = {
      ...dagBase,
      model: node.data.model || undefined,
      provider: node.data.provider || undefined,
      context: node.data.context || undefined,
      output_format: node.data.output_format ?? undefined,
      allowed_tools: node.data.allowed_tools ?? undefined,
      denied_tools: node.data.denied_tools ?? undefined,
      hooks: node.data.hooks ?? undefined,
      mcp: node.data.mcp ?? undefined,
      skills: node.data.skills ?? undefined,
    };

    // DagNode uses `never` discriminant fields that can't be set on object literals
    if (node.data.nodeType === 'command') {
      return { ...aiBase, command: node.data.label } as DagNode;
    }
    const promptText = node.data.promptText;
    return {
      ...aiBase,
      prompt: typeof promptText === 'string' ? promptText : '',
    } as DagNode;
  });
}

interface WorkflowCanvasProps {
  nodes: DagFlowNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<DagFlowNode>;
  onEdgesChange: OnEdgesChange;
  setNodes: React.Dispatch<React.SetStateAction<DagFlowNode[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  onNodeSelect: (nodeId: string | null) => void;
  onNodeDelete: (nodeId: string) => void;
  onDirty: () => void;
  onPushSnapshot?: () => void;
  commands: CommandEntry[];
}

interface QuickAddPosition {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  setNodes,
  setEdges,
  onNodeSelect,
  onNodeDelete,
  onDirty,
  onPushSnapshot,
  commands,
}: WorkflowCanvasProps): React.ReactElement {
  const { screenToFlowPosition } = useReactFlow();
  const [quickAddPosition, setQuickAddPosition] = useState<QuickAddPosition | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const nodeTypes: NodeTypes = useMemo(() => ({ dagNode: dagNodeComponent }), []);

  // Style edges: conditional edges get dashed purple stroke
  const styledEdges = useMemo(
    () =>
      edges.map(edge => {
        const targetNode = nodes.find(n => n.id === edge.target);
        if (targetNode?.data.when) {
          return {
            ...edge,
            style: { stroke: 'var(--node-prompt)', strokeDasharray: '6 4' },
            type: 'smoothstep' as const,
          };
        }
        return { ...edge, type: 'smoothstep' as const };
      }),
    [edges, nodes]
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => addEdge({ ...connection, type: 'smoothstep' }, eds));
      onDirty();
    },
    [setEdges, onDirty]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();

      const type = e.dataTransfer.getData('application/reactflow-type');
      const command = e.dataTransfer.getData('application/reactflow-command');
      if (!type) return;

      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = `node-${crypto.randomUUID()}`;

      const nodeType = type as 'command' | 'prompt' | 'bash';
      const label = resolveNodeLabel(nodeType, command);

      const newNode: DagFlowNode = {
        id,
        type: 'dagNode',
        position,
        data: {
          id,
          label,
          nodeType,
        },
      };

      onPushSnapshot?.();
      setNodes(nds => [...nds, newNode]);
      onNodeSelect(id);
      onDirty();
    },
    [screenToFlowPosition, setNodes, onNodeSelect, onDirty, onPushSnapshot]
  );

  // Track whether we've already pushed a snapshot for the current drag gesture
  const dragSnapshotPushed = useRef(false);

  const handleNodesChange: OnNodesChange<DagFlowNode> = useCallback(
    changes => {
      // Push snapshot at the start of a drag (before state changes)
      const hasDragStart = changes.some(
        c => c.type === 'position' && 'dragging' in c && c.dragging === true
      );
      const hasDragEnd = changes.some(
        c => c.type === 'position' && 'dragging' in c && c.dragging === false
      );

      if (hasDragStart && !dragSnapshotPushed.current) {
        dragSnapshotPushed.current = true;
        onPushSnapshot?.();
      }
      if (hasDragEnd) {
        dragSnapshotPushed.current = false;
      }

      onNodesChange(changes);
      if (changes.some(c => c.type !== 'select')) {
        onDirty();
      }
    },
    [onNodesChange, onDirty, onPushSnapshot]
  );

  const handleEdgesChange: OnEdgesChange = useCallback(
    changes => {
      onEdgesChange(changes);
      if (changes.some(c => c.type !== 'select')) {
        onDirty();
      }
    },
    [onEdgesChange, onDirty]
  );

  // Clean up click timer on unmount
  useEffect(() => {
    return (): void => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    };
  }, []);

  // Manual double-click detection — ReactFlow v12 has no onPaneDoubleClick prop.
  const DOUBLE_CLICK_MS = 300;
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });

  const handlePaneClick = useCallback(
    (e: React.MouseEvent) => {
      const now = Date.now();
      const last = lastClickRef.current;
      const isDoubleClick =
        now - last.time < DOUBLE_CLICK_MS &&
        Math.abs(e.clientX - last.x) < 10 &&
        Math.abs(e.clientY - last.y) < 10;

      lastClickRef.current = { time: now, x: e.clientX, y: e.clientY };

      if (isDoubleClick) {
        if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        const wrapperEl = (e.target as HTMLElement).closest('.react-flow');
        const rect = wrapperEl?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        setQuickAddPosition({
          screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
          flow: flowPos,
        });
      } else {
        clickTimerRef.current = setTimeout(() => {
          onNodeSelect(null);
          setQuickAddPosition(null);
          clickTimerRef.current = null;
        }, DOUBLE_CLICK_MS);
      }
    },
    [screenToFlowPosition, onNodeSelect]
  );

  const handleQuickAddNode = useCallback(
    (
      type: 'command' | 'prompt' | 'bash',
      options?: { commandName?: string; skills?: string[]; mcp?: string }
    ) => {
      if (!quickAddPosition) return;

      const id = `node-${crypto.randomUUID()}`;
      const label = resolveNodeLabel(type, options?.commandName ?? '');

      const newNode: DagFlowNode = {
        id,
        type: 'dagNode',
        position: quickAddPosition.flow,
        data: {
          id,
          label,
          nodeType: type,
          ...(options?.skills && { skills: options.skills }),
          ...(options?.mcp && { mcp: options.mcp }),
        },
      };

      onPushSnapshot?.();
      setNodes(nds => [...nds, newNode]);
      onNodeSelect(id);
      onDirty();
      setQuickAddPosition(null);
    },
    [quickAddPosition, setNodes, onNodeSelect, onDirty, onPushSnapshot]
  );

  const handleQuickAddClose = useCallback(() => {
    setQuickAddPosition(null);
  }, []);

  // Approximate menu size used for viewport-edge clamping.
  const CONTEXT_MENU_WIDTH = 160;
  const CONTEXT_MENU_HEIGHT = 40;

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: DagFlowNode) => {
      e.preventDefault();
      onNodeSelect(node.id);
      const x = Math.min(e.clientX, window.innerWidth - CONTEXT_MENU_WIDTH);
      const y = Math.min(e.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT);
      setContextMenu({ x, y, nodeId: node.id });
    },
    [onNodeSelect]
  );

  // Dismiss the context menu on Escape or any click/contextmenu outside it.
  useEffect(() => {
    if (!contextMenu) return;

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const onClickOutside = (e: MouseEvent): void => {
      if (
        contextMenuRef.current &&
        e.target instanceof Node &&
        contextMenuRef.current.contains(e.target)
      ) {
        return;
      }
      setContextMenu(null);
    };

    window.addEventListener('keydown', onKey);
    // Use capture so we beat ReactFlow's own handlers and any stopPropagation.
    window.addEventListener('mousedown', onClickOutside, true);
    window.addEventListener('contextmenu', onClickOutside, true);
    return (): void => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClickOutside, true);
      window.removeEventListener('contextmenu', onClickOutside, true);
    };
  }, [contextMenu]);

  return (
    <div className="relative w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={(_e, node): void => {
          onNodeSelect(node.id);
        }}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        panOnDrag
        selectionOnDrag={false}
        fitView
        colorMode="dark"
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <MiniMap className="!bg-surface !border-border" maskColor="rgba(0,0,0,0.6)" />
        <Controls />
      </ReactFlow>

      {/* QuickAddPicker overlay */}
      {quickAddPosition && (
        <QuickAddPicker
          position={quickAddPosition.screen}
          onAddNode={handleQuickAddNode}
          onClose={handleQuickAddClose}
          commands={commands}
        />
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[140px] rounded-md border border-border bg-surface-elevated py-1 shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={(): void => {
              onNodeDelete(contextMenu.nodeId);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left text-xs text-error hover:bg-surface"
          >
            Delete node
          </button>
        </div>
      )}
    </div>
  );
}
