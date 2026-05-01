import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  fetchCompassGraph,
  upsertCompassGhost,
  deleteCompassGhost,
  annotateCompassGhost,
  promoteCompassGhost,
  type CompassGraphResponse,
  type CompassGhostFeatureNode,
  type CompassRealFeatureNode,
  type CompassPromoteTarget,
} from '@/lib/api';
import { realFeatureNode, type RealFeatureNodeData } from './RealFeatureNode';
import { ghostFeatureNode, type GhostFeatureNodeData } from './GhostFeatureNode';
import { NorthStarPanel } from './NorthStarPanel';
import { Plus, Trash2, RefreshCw } from 'lucide-react';

const NODE_TYPES = {
  real: realFeatureNode,
  ghost: ghostFeatureNode,
};

const KIND_ROW_ORDER: CompassRealFeatureNode['kind'][] = [
  'route',
  'endpoint',
  'component',
  'workflow',
  'module',
];

interface Props {
  codebaseId: string;
  repoPath: string;
}

function layoutRealNodes(reals: CompassRealFeatureNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const byKind = new Map<CompassRealFeatureNode['kind'], CompassRealFeatureNode[]>();
  for (const n of reals) {
    const list = byKind.get(n.kind) ?? [];
    list.push(n);
    byKind.set(n.kind, list);
  }
  const COLS = 6;
  const DX = 200;
  const DY = 90;
  const ROW_GAP = 40;
  let yCursor = 0;
  for (const kind of KIND_ROW_ORDER) {
    const group = byKind.get(kind);
    if (!group?.length) continue;
    group.forEach((n, i) => {
      positions.set(n.id, {
        x: (i % COLS) * DX,
        y: yCursor + Math.floor(i / COLS) * DY,
      });
    });
    const rowsInGroup = Math.ceil(group.length / COLS);
    yCursor += rowsInGroup * DY + ROW_GAP;
  }
  return positions;
}

function CompassCanvasInner({ codebaseId, repoPath }: Props): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const reactFlow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [selectedGhostId, setSelectedGhostId] = useState<string | null>(null);
  const [annotatingIds, setAnnotatingIds] = useState<Set<string>>(new Set());
  const [promotingIds, setPromotingIds] = useState<Set<string>>(new Set());

  const graphQuery = useQuery({
    queryKey: ['compass', codebaseId, 'graph'],
    queryFn: () => fetchCompassGraph(codebaseId),
    refetchOnWindowFocus: false,
  });

  const annotateMutation = useMutation({
    mutationFn: ({ ghostId }: { ghostId: string }) => annotateCompassGhost(codebaseId, ghostId),
    onMutate: ({ ghostId }) => {
      setAnnotatingIds(prev => new Set(prev).add(ghostId));
    },
    onSettled: (_data, _err, { ghostId }) => {
      setAnnotatingIds(prev => {
        const next = new Set(prev);
        next.delete(ghostId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['compass', codebaseId, 'graph'] });
    },
  });

  const upsertMutation = useMutation({
    mutationFn: (body: { id?: string; title: string; position: { x: number; y: number } }) =>
      upsertCompassGhost(codebaseId, body),
  });

  const deleteMutation = useMutation({
    mutationFn: (ghostId: string) => deleteCompassGhost(codebaseId, ghostId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['compass', codebaseId, 'graph'] });
      setSelectedGhostId(null);
    },
  });

  const promoteMutation = useMutation({
    mutationFn: ({ ghostId, target }: { ghostId: string; target: CompassPromoteTarget }) =>
      promoteCompassGhost(codebaseId, ghostId, target),
    onMutate: ({ ghostId }) => {
      setPromotingIds(prev => new Set(prev).add(ghostId));
    },
    onSettled: (_data, _err, { ghostId }) => {
      setPromotingIds(prev => {
        const next = new Set(prev);
        next.delete(ghostId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['compass', codebaseId, 'graph'] });
    },
  });

  const handlePromote = useCallback(
    (ghostId: string, target: CompassPromoteTarget): void => {
      promoteMutation.mutate(
        { ghostId, target },
        {
          onSuccess: result => {
            if (target === 'issue' && result.issueUrl) {
              window.open(result.issueUrl, '_blank', 'noopener');
            } else if (target === 'workflow' && result.conversationId) {
              navigate(`/chat/${encodeURIComponent(result.conversationId)}`);
            }
          },
        }
      );
    },
    [promoteMutation, navigate]
  );

  const handleReannotate = useCallback(
    (ghostId: string): void => {
      annotateMutation.mutate({ ghostId });
    },
    [annotateMutation]
  );

  // Build React Flow nodes from query data
  const flowNodes: Node[] = useMemo(() => {
    if (!graphQuery.data) return [];
    const realPositions = layoutRealNodes(graphQuery.data.realNodes);
    const dependencyHighlight = new Set<string>();
    if (selectedGhostId) {
      const ghost = graphQuery.data.ghostNodes.find(g => g.id === selectedGhostId);
      ghost?.annotation?.dependencies.forEach(d => dependencyHighlight.add(d));
    }
    const reals: Node<RealFeatureNodeData>[] = graphQuery.data.realNodes.map(n => ({
      id: n.id,
      type: 'real',
      position: realPositions.get(n.id) ?? { x: 0, y: 0 },
      draggable: false,
      data: { ...n, highlighted: dependencyHighlight.has(n.id) },
    }));
    const ghosts: Node<GhostFeatureNodeData>[] = graphQuery.data.ghostNodes.map(g => ({
      id: g.id,
      type: 'ghost',
      position: g.position,
      data: {
        ...g,
        isAnnotating: annotatingIds.has(g.id),
        isPromoting: promotingIds.has(g.id),
        onPromote: handlePromote,
        onReannotate: handleReannotate,
      },
    }));
    return [...reals, ...ghosts];
  }, [
    graphQuery.data,
    selectedGhostId,
    annotatingIds,
    promotingIds,
    handlePromote,
    handleReannotate,
  ]);

  // Edges: ghost → real for each dependency in annotation
  const flowEdges: Edge[] = useMemo(() => {
    if (!graphQuery.data) return [];
    const edges: Edge[] = [];
    for (const ghost of graphQuery.data.ghostNodes) {
      const deps = ghost.annotation?.dependencies ?? [];
      for (const target of deps) {
        edges.push({
          id: `${ghost.id}->${target}`,
          source: ghost.id,
          target,
          type: 'smoothstep',
          style: { stroke: '#a78bfa', strokeDasharray: '4 3', strokeWidth: 1.5 },
          animated: false,
        });
      }
    }
    return edges;
  }, [graphQuery.data]);

  const onDragOver = useCallback((event: React.DragEvent): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/compass-type');
      if (type !== 'ghost') return;
      const position = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const title = window.prompt('What feature do you want to propose?');
      if (!title?.trim()) return;
      upsertMutation.mutate(
        { title: title.trim(), position },
        {
          onSuccess: result => {
            void queryClient.invalidateQueries({ queryKey: ['compass', codebaseId, 'graph'] });
            setSelectedGhostId(result.ghost.id);
            // Auto-annotate as soon as the ghost is created
            annotateMutation.mutate({ ghostId: result.ghost.id });
          },
        }
      );
    },
    [reactFlow, upsertMutation, annotateMutation, queryClient, codebaseId]
  );

  const onNodeClick: NodeMouseHandler = useCallback((_evt, node) => {
    if (node.type === 'ghost') {
      setSelectedGhostId(node.id);
    } else {
      setSelectedGhostId(null);
    }
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedGhostId(null);
  }, []);

  const selectedGhost: CompassGhostFeatureNode | null = useMemo(() => {
    if (!selectedGhostId || !graphQuery.data) return null;
    return graphQuery.data.ghostNodes.find(g => g.id === selectedGhostId) ?? null;
  }, [selectedGhostId, graphQuery.data]);

  const handleDeleteSelected = (): void => {
    if (!selectedGhostId) return;
    if (window.confirm('Delete this ghost?')) {
      deleteMutation.mutate(selectedGhostId);
    }
  };

  const handleRefreshScan = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['compass', codebaseId, 'graph'] });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <NorthStarPanel
        northStar={graphQuery.data?.northStar ?? null}
        selectedGhost={selectedGhost}
        repoPath={repoPath}
      />

      <ToolbarRow
        graph={graphQuery.data}
        loading={graphQuery.isLoading}
        onRefresh={handleRefreshScan}
        onDeleteSelected={handleDeleteSelected}
        hasSelection={Boolean(selectedGhostId)}
      />

      <div ref={wrapperRef} className="relative flex-1" onDragOver={onDragOver} onDrop={onDrop}>
        <GhostPalette />
        {graphQuery.isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/50 text-sm text-text-tertiary">
            Scanning codebase…
          </div>
        )}
        {graphQuery.error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-rose-400">
            {graphQuery.error.message}
          </div>
        )}
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          panOnDrag={[1, 2]}
          selectionOnDrag
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#27272a" gap={20} size={1} />
          <Controls className="!bottom-4 !left-4 !top-auto" showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={n => (n.type === 'ghost' ? '#a78bfa' : '#52525b')}
            className="!bg-surface !border !border-border"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

function ToolbarRow({
  graph,
  loading,
  onRefresh,
  onDeleteSelected,
  hasSelection,
}: {
  graph: CompassGraphResponse | undefined;
  loading: boolean;
  onRefresh: () => void;
  onDeleteSelected: () => void;
  hasSelection: boolean;
}): React.ReactElement {
  const counts = useMemo(() => {
    if (!graph) return null;
    const byKind = new Map<string, number>();
    for (const n of graph.realNodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
    return Array.from(byKind.entries())
      .map(([kind, n]) => `${String(n)} ${kind}`)
      .join(' · ');
  }, [graph]);

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface/40 px-4 py-1.5 text-[11px] text-text-tertiary">
      <span>
        {loading
          ? 'Scanning…'
          : counts
            ? `${counts} · ${String(graph?.ghostNodes.length ?? 0)} ghosts`
            : 'No data'}
      </span>
      {graph?.lastScannedAt && (
        <span className="text-[10px]">scanned {timeAgo(graph.lastScannedAt)}</span>
      )}
      {graph?.scanWarnings && graph.scanWarnings.length > 0 && (
        <span className="text-[10px] text-amber-400" title={graph.scanWarnings.join('\n')}>
          {graph.scanWarnings.length} warning{graph.scanWarnings.length === 1 ? '' : 's'}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface hover:text-text-primary"
          title="Re-scan codebase"
        >
          <RefreshCw className="h-3 w-3" /> Re-scan
        </button>
        {hasSelection && (
          <button
            type="button"
            onClick={onDeleteSelected}
            className="flex items-center gap-1 rounded px-2 py-1 text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 className="h-3 w-3" /> Delete ghost
          </button>
        )}
      </div>
    </div>
  );
}

function GhostPalette(): React.ReactElement {
  const onDragStart = (event: React.DragEvent): void => {
    event.dataTransfer.setData('application/compass-type', 'ghost');
    event.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div className="absolute left-4 top-4 z-20 flex flex-col gap-2 rounded-lg border border-border bg-surface/90 p-2 shadow backdrop-blur">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
        Drag to canvas
      </div>
      <div
        draggable
        onDragStart={onDragStart}
        className="flex cursor-grab items-center gap-2 rounded-md border-2 border-dashed border-purple-400/60 bg-purple-500/10 px-3 py-2 active:cursor-grabbing"
      >
        <Plus className="h-3 w-3 text-purple-300" />
        <span className="text-xs font-medium text-purple-300">Ghost feature</span>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.round(m / 60);
  return `${String(h)}h ago`;
}

export function CompassCanvas(props: Props): React.ReactElement {
  return (
    <ReactFlowProvider>
      <CompassCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
