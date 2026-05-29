import { useMemo, type CSSProperties, type ReactElement } from 'react';
import dagre from '@dagrejs/dagre';
import { useEntity } from '../store/cache';
import * as skill from '../skills';
import {
  deriveNodeStatuses,
  type WorkflowGraphNode,
  type WorkflowGraphNodeWithStatus,
  type WorkflowNodeKind,
  type WorkflowNodeStatus,
} from '../primitives/workflow-graph';
import type { RunEvent } from '../primitives/event';

interface RunGraphPanelProps {
  workflowName: string;
  projectCwd: string;
  events: RunEvent[];
  /** The node the main stream should scroll to when a graph node is clicked. */
  onNodeSelect?: (nodeId: string) => void;
}

// Full-canvas node dimensions. dagre positions by center.
const NODE_W = 160;
const NODE_H = 40;
const RANK_SEP = 56;
const NODE_SEP = 20;
const PADDING = 24;

interface LaidOutNode extends WorkflowGraphNodeWithStatus {
  x: number;
  y: number;
}

interface Edge {
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

interface Layout {
  nodes: LaidOutNode[];
  edges: Edge[];
  width: number;
  height: number;
}

function layout(nodes: WorkflowGraphNodeWithStatus[]): Layout {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    marginx: PADDING,
    marginy: PADDING,
  });

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      // Only set edges whose source exists (robust against malformed DAGs).
      if (g.hasNode(d)) g.setEdge(d, n.id);
    }
  }

  dagre.layout(g);

  const laid: LaidOutNode[] = nodes.map(n => {
    const pos = g.node(n.id) as { x: number; y: number } | undefined;
    return {
      ...n,
      x: pos ? pos.x - NODE_W / 2 : 0,
      y: pos ? pos.y - NODE_H / 2 : 0,
    };
  });

  const edges: Edge[] = [];
  for (const e of g.edges()) {
    const data = g.edge(e) as { points?: { x: number; y: number }[] };
    if (data.points !== undefined) {
      edges.push({ from: e.v, to: e.w, points: data.points });
    }
  }

  const graph = g.graph();
  return {
    nodes: laid,
    edges,
    width: graph.width ?? 0,
    height: graph.height ?? 0,
  };
}

function polyline(points: { x: number; y: number }[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toString()},${p.y.toString()}`)
    .join(' ');
}

/* Status → color (CSS var reference so the warm theme can retune). */
function statusFill(s: WorkflowNodeStatus): string {
  switch (s) {
    case 'running':
      return 'color-mix(in oklch, var(--running), transparent 82%)';
    case 'completed':
      return 'color-mix(in oklch, var(--success), transparent 84%)';
    case 'failed':
      return 'color-mix(in oklch, var(--error), transparent 82%)';
    case 'skipped':
      return 'color-mix(in oklch, var(--text-tertiary), transparent 90%)';
    case 'pending':
      return 'var(--surface-inset)';
  }
}

function statusBorder(s: WorkflowNodeStatus): string {
  switch (s) {
    case 'running':
      return 'var(--running)';
    case 'completed':
      return 'var(--success)';
    case 'failed':
      return 'var(--error)';
    case 'skipped':
      return 'var(--border)';
    case 'pending':
      return 'var(--border)';
  }
}

function kindGlyph(k: WorkflowNodeKind): string {
  switch (k) {
    case 'loop':
      return '↻';
    case 'approval':
      return '◈';
    case 'bash':
      return '$';
    case 'command':
      return '/';
    case 'script':
      return '⧉';
    case 'prompt':
      return '·';
  }
}

/**
 * Full-canvas DAG view. Uses dagre (rankdir=TB) so parallel nodes sit side
 * by side and fan-in/out are visible. Loop nodes show a ↻ glyph; approval
 * nodes show ◈. Click a node to jump the stream to that node's transition.
 *
 * Renders as a full-width content panel — the calling layout provides the
 * outer flex container (no internal border/aside).
 */
export function RunGraphPanel({
  workflowName,
  projectCwd,
  events,
  onNodeSelect,
}: RunGraphPanelProps): ReactElement {
  const { data: rawNodes, error } = useEntity<WorkflowGraphNode[]>(
    `workflow-graph:${workflowName}:${projectCwd}`,
    () => skill.getWorkflowGraph(workflowName, projectCwd)
  );

  const laid = useMemo(() => {
    if (rawNodes === undefined) return null;
    const withStatus = deriveNodeStatuses(rawNodes, events);
    return layout(withStatus);
  }, [rawNodes, events]);

  if (error !== undefined) {
    return (
      <div className="p-6 font-mono text-[12px] text-error">
        Could not load graph: {error.message}
      </div>
    );
  }

  if (laid === null) {
    return <div className="p-6 text-[12px] text-text-tertiary">Loading graph…</div>;
  }

  const { nodes, edges, width, height } = laid;
  const svgStyle: CSSProperties = {
    width: Math.max(width, NODE_W + PADDING * 2),
    height: Math.max(height, NODE_H + PADDING * 2),
  };

  return (
    <div className="flex h-full w-full justify-center overflow-auto bg-surface-inset p-6">
      <div className="relative" style={svgStyle}>
        <svg
          className="absolute inset-0"
          width={svgStyle.width}
          height={svgStyle.height}
          aria-hidden
        >
          {edges.map(e => (
            <path
              key={`${e.from}→${e.to}`}
              d={polyline(e.points)}
              fill="none"
              stroke="color-mix(in oklch, var(--border), transparent 30%)"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {nodes.map(n => (
          <GraphNode
            key={n.id}
            node={n}
            onClick={() => {
              onNodeSelect?.(n.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

interface GraphNodeProps {
  node: LaidOutNode;
  onClick: () => void;
}

function GraphNode({ node, onClick }: GraphNodeProps): ReactElement {
  const running = node.status === 'running';
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: NODE_W,
    height: NODE_H,
    backgroundColor: statusFill(node.status),
    borderColor: statusBorder(node.status),
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${node.id} · ${node.kind} · ${node.status}`}
      className={`absolute flex items-center gap-2 overflow-hidden rounded border px-2 text-left transition-colors hover:brightness-110 ${running ? 'animate-pulse' : ''}`}
      style={style}
    >
      <span aria-hidden className="shrink-0 font-mono text-[13px] text-text-tertiary">
        {kindGlyph(node.kind)}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary">
        {node.id}
      </span>
    </button>
  );
}
