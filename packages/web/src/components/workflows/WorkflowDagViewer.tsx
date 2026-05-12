import { useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from '@xyflow/react';
import type { Edge, NodeTypes } from '@xyflow/react';
import type { DagNodeState, WorkflowStepStatus } from '@/lib/types';
import type { DagNode } from '@/lib/api';
import { dagNodesToReactFlow, resolveNodeDisplay } from '@/lib/dag-layout';
import { formatDurationMs } from '@/lib/format';
import {
  executionDagNode,
  type ExecutionFlowNode,
  type ExecutionNodeData,
} from './ExecutionDagNode';

import '@xyflow/react/dist/style.css';

// Defined at module scope — prevents ReactFlow from remounting nodes on every render
const nodeTypes: NodeTypes = { executionNode: executionDagNode };

const STATUS_MINIMAP_COLORS: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'var(--success)',
  running: 'var(--accent-bright)',
  failed: 'var(--error)',
  skipped: 'var(--text-tertiary)',
};
const DEFAULT_MINIMAP_COLOR = 'var(--surface-elevated)';

const EDGE_STROKE_BY_STATUS: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'var(--success)',
  running: 'var(--accent-bright)',
  failed: 'var(--error)',
};
const DEFAULT_EDGE_STROKE = 'var(--border)';

interface WorkflowDagViewerProps {
  dagNodes: readonly DagNode[];
  liveStatus: readonly DagNodeState[];
  isRunning: boolean;
  currentlyExecuting?: { nodeName: string; startedAt: number };
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
}

export function WorkflowDagViewer({
  dagNodes,
  liveStatus,
  isRunning,
  currentlyExecuting,
  selectedNodeId,
  onNodeClick,
}: WorkflowDagViewerProps): React.ReactElement {
  // Compute topology layout ONCE from the workflow definition.
  // Only re-layout when the definition changes (node/edge count), not on status updates.
  const { baseNodes, edges: layoutedEdges } = useMemo(() => {
    const { nodes, edges } = dagNodesToReactFlow(dagNodes);
    return { baseNodes: nodes, edges };
  }, [dagNodes]);

  // Build a status lookup map from live SSE/REST data
  const statusMap = useMemo(() => {
    const map = new Map<string, DagNodeState>();
    for (const node of liveStatus) {
      map.set(node.nodeId, node);
    }
    return map;
  }, [liveStatus]);

  // Overlay live status onto the topology nodes.
  // Creates new node objects only for nodes whose status changed (React.memo handles the rest).
  const nodes: ExecutionFlowNode[] = useMemo(() => {
    return baseNodes.map(node => {
      const live = statusMap.get(node.id);
      // baseNodes is derived from dagNodes, so this find should always succeed
      const dagNode = dagNodes.find(dn => dn.id === node.id);
      const display = dagNode ? resolveNodeDisplay(dagNode) : node.data;
      return {
        ...node,
        type: 'executionNode',
        data: {
          ...node.data,
          ...display,
          status: live?.status,
          duration: live?.duration,
          error: live?.error,
          selected: node.id === selectedNodeId,
          currentIteration: live?.currentIteration,
          maxIterations: live?.maxIterations,
        },
      } as ExecutionFlowNode;
    });
  }, [baseNodes, statusMap, dagNodes, selectedNodeId]);

  // Color edges based on target node status
  const edges: Edge[] = useMemo(() => {
    return layoutedEdges.map(edge => {
      const targetStatus = statusMap.get(edge.target)?.status;
      const stroke = (targetStatus && EDGE_STROKE_BY_STATUS[targetStatus]) ?? DEFAULT_EDGE_STROKE;
      return {
        ...edge,
        animated: targetStatus === 'running',
        // ReactFlow SVG edges require inline style for stroke — className cannot target SVG stroke.
        style: { stroke, strokeWidth: 1.5 },
      };
    });
  }, [layoutedEdges, statusMap]);

  return (
    <div className="h-full w-full relative">
      {isRunning && currentlyExecuting && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-md bg-surface/90 backdrop-blur-sm border border-border px-3 py-1.5 text-xs">
          <span className="inline-block w-2 h-2 rounded-full bg-accent-bright animate-pulse" />
          <span className="text-text-secondary">Executing:</span>
          <span className="font-medium text-text-primary">{currentlyExecuting.nodeName}</span>
          <span className="text-text-tertiary">
            {formatDurationMs(Date.now() - currentlyExecuting.startedAt)}
          </span>
        </div>
      )}
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          onNodeClick={
            onNodeClick
              ? (_event, node): void => {
                  onNodeClick(node.id);
                }
              : undefined
          }
          fitView
          fitViewOptions={{ padding: 0.15 }}
          panOnDrag
          zoomOnScroll
          className="bg-background"
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
          <Controls showInteractive={false} className="!bg-surface !border-border" />
          <MiniMap
            nodeColor={(node): string => {
              const data = node.data as ExecutionNodeData;
              return (data.status && STATUS_MINIMAP_COLORS[data.status]) ?? DEFAULT_MINIMAP_COLOR;
            }}
            className="!bg-surface !border-border"
            maskColor="rgba(0, 0, 0, 0.6)"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
