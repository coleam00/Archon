import { useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from '@xyflow/react';
import type { Edge, NodeTypes } from '@xyflow/react';
import type { BuilderNode } from '@archon/workflow-studio-core';
import type { DagNodeState, WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';
import type { DagNode } from '@/lib/api';
import { dagNodesToReactFlow } from '@/lib/dag-layout';
import { formatDurationMs } from '@/lib/format';
import {
  adaptedExecutionNode,
  type AdaptedFlowNode,
  type AdaptedNodeData,
} from './AdaptedExecutionNode';

import '@xyflow/react/dist/style.css';

// Defined at module scope — prevents ReactFlow from remounting nodes on every render
const nodeTypes: NodeTypes = { adaptedExecutionNode };

// MiniMap applies nodeColor as an SVG `fill` attribute, where `var()` is not
// resolved (custom properties only work in CSS property values). We read the
// computed values off :root so the minimap gets concrete oklch() strings.
const MINIMAP_STATUS_VARS: Partial<Record<WorkflowStepStatus, string>> = {
  completed: '--success',
  running: '--accent-bright',
  failed: '--error',
  skipped: '--text-tertiary',
};
// Pre-run / no-status nodes need a fallback that is visible against the
// hardcoded black minimap background. Picking a mid-zinc so unstarted nodes
// still register as shapes; status colors take over once execution begins.
const MINIMAP_FALLBACK_COLOR = '#a1a1aa';
const MINIMAP_MASK_COLOR = 'rgba(0, 0, 0, 0.6)';

interface ResolvedMinimapColors {
  byStatus: Partial<Record<WorkflowStepStatus, string>>;
  fallback: string;
}

function readMinimapColors(): ResolvedMinimapColors {
  if (typeof window === 'undefined') {
    return { byStatus: {}, fallback: MINIMAP_FALLBACK_COLOR };
  }
  const styles = getComputedStyle(document.documentElement);
  const resolve = (name: string): string =>
    styles.getPropertyValue(name).trim() || MINIMAP_FALLBACK_COLOR;
  const byStatus: Partial<Record<WorkflowStepStatus, string>> = {};
  for (const [status, varName] of Object.entries(MINIMAP_STATUS_VARS) as [
    WorkflowStepStatus,
    string,
  ][]) {
    byStatus[status] = resolve(varName);
  }
  return { byStatus, fallback: MINIMAP_FALLBACK_COLOR };
}

const EDGE_STROKE_BY_STATUS: Partial<Record<WorkflowStepStatus, string>> = {
  completed: 'var(--success)',
  running: 'var(--accent-bright)',
  failed: 'var(--error)',
};
const DEFAULT_EDGE_STROKE = 'var(--border)';

interface WorkflowDagViewerProps {
  dagNodes: readonly DagNode[];
  builderNodes: readonly BuilderNode[];
  liveStatus: readonly DagNodeState[];
  isRunning: boolean;
  currentlyExecuting?: { nodeName: string; startedAt: number };
  selectedNodeId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  runStatus?: WorkflowRunStatus;
  approval?: { nodeId: string; message: string };
  onApprove?: (comment?: string) => void;
  onReject?: (reason: string) => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}

export function WorkflowDagViewer({
  dagNodes,
  builderNodes,
  liveStatus,
  isRunning,
  currentlyExecuting,
  selectedNodeId,
  onNodeClick,
  runStatus,
  approval,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: WorkflowDagViewerProps): React.ReactElement {
  // Read once on mount — theme is static.
  const [minimapColors] = useState<ResolvedMinimapColors>(() => readMinimapColors());

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

  // Index BuilderNodes by id so we can zip topology nodes with their variant payload.
  const builderNodeMap = useMemo(() => {
    return new Map(builderNodes.map(n => [n.id, n]));
  }, [builderNodes]);

  // Overlay live status onto the topology nodes.
  // Creates new node objects only for nodes whose status changed (React.memo handles the rest).
  const nodes: AdaptedFlowNode[] = useMemo(() => {
    const out: AdaptedFlowNode[] = [];
    for (const node of baseNodes) {
      const builderNode = builderNodeMap.get(node.id);
      if (!builderNode) {
        // Defensive: every layout node should have a matching BuilderNode because both
        // derive from the same workflow definition. Skip rather than crash.
        console.warn('[WorkflowDagViewer] No BuilderNode for layout node', { id: node.id });
        continue;
      }
      const live = statusMap.get(node.id);
      const data: AdaptedNodeData = {
        builderNode,
        status: live?.status,
        duration: live?.duration,
        error: live?.error,
        selected: node.id === selectedNodeId,
        currentIteration: live?.currentIteration,
        maxIterations: live?.maxIterations,
        runStatus,
        approval,
        onApprove,
        onReject,
        isApproving,
        isRejecting,
      };
      out.push({
        ...node,
        type: 'adaptedExecutionNode',
        data,
      });
    }
    return out;
  }, [
    baseNodes,
    builderNodeMap,
    statusMap,
    selectedNodeId,
    runStatus,
    approval,
    onApprove,
    onReject,
    isApproving,
    isRejecting,
  ]);

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
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(node): string => {
              const data = node.data as AdaptedNodeData;
              return (data.status && minimapColors.byStatus[data.status]) ?? minimapColors.fallback;
            }}
            nodeStrokeColor="#e4e4e7"
            nodeStrokeWidth={1}
            maskColor={MINIMAP_MASK_COLOR}
            style={{ background: '#000000', border: '1px solid #3f3f46' }}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
