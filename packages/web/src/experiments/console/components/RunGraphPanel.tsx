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

// Full-canvas node dimensions (design v3: 168×46). dagre positions by center.
const NODE_W = 168;
const NODE_H = 46;
const RANK_SEP = 58;
const NODE_SEP = 32;
const PADDING = 30;

interface LaidOutNode extends WorkflowGraphNodeWithStatus {
  x: number;
  y: number;
}

interface Edge {
  from: string;
  to: string;
  /** Orthogonal elbow path (design v3 connectors). */
  d: string;
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

  // Orthogonal elbow connectors (design v3): drop from the source's bottom
  // center, elbow at the midpoint between ranks, into the target's top center.
  const laidById = new Map(laid.map(n => [n.id, n]));
  const edges: Edge[] = [];
  for (const e of g.edges()) {
    const a = laidById.get(e.v);
    const b = laidById.get(e.w);
    if (a === undefined || b === undefined) continue;
    const ax = a.x + NODE_W / 2;
    const ay = a.y + NODE_H;
    const bx = b.x + NODE_W / 2;
    const by = b.y;
    const d =
      ax === bx
        ? `M${ax.toString()},${ay.toString()} V${by.toString()}`
        : `M${ax.toString()},${ay.toString()} V${(ay + (by - ay) / 2).toString()} H${bx.toString()} V${by.toString()}`;
    edges.push({ from: e.v, to: e.w, d });
  }

  const graph = g.graph();
  return {
    nodes: laid,
    edges,
    width: graph.width ?? 0,
    height: graph.height ?? 0,
  };
}

/* Status → color (design v3 .gnode tints; CSS var refs so themes can retune). */
function statusFill(s: WorkflowNodeStatus): string {
  switch (s) {
    case 'running':
      return 'color-mix(in oklch, var(--running), transparent 90%)';
    case 'completed':
      return 'color-mix(in oklch, var(--success), transparent 95%)';
    case 'failed':
      return 'color-mix(in oklch, var(--error), transparent 92%)';
    case 'skipped':
      return 'var(--surface-elevated)';
    case 'pending':
      return 'var(--surface-elevated)';
  }
}

function statusBorder(s: WorkflowNodeStatus): string {
  switch (s) {
    case 'running':
      return 'color-mix(in oklch, var(--running), transparent 40%)';
    case 'completed':
      return 'color-mix(in oklch, var(--success), transparent 60%)';
    case 'failed':
      return 'color-mix(in oklch, var(--error), transparent 45%)';
    case 'skipped':
      return 'var(--border-bright)';
    case 'pending':
      return 'var(--border-bright)';
  }
}

/* Glyph/icon color per status (design: green check-tone icon, rose on failed). */
function statusGlyphClass(s: WorkflowNodeStatus): string {
  switch (s) {
    case 'running':
      return 'text-[color:var(--running)]';
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'skipped':
      return 'text-text-tertiary';
    case 'pending':
      return 'text-text-tertiary';
  }
}

function kindGlyph(k: WorkflowNodeKind): string {
  switch (k) {
    case 'loop':
      return '↻';
    case 'approval':
      return '◈';
    case 'cancel':
      return '⊘';
    case 'bash':
      return '$';
    case 'command':
      return '/';
    case 'script':
      return '⧉';
    case 'workflow':
      return '⋔';
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
    <div
      className="flex h-full w-full justify-center overflow-auto p-6"
      // Dotted canvas (design v3 .rd-graph).
      style={{
        background:
          'radial-gradient(circle at 1px 1px, color-mix(in oklch, white, transparent 95%) 1px, transparent 0) 0 0 / 26px 26px',
      }}
    >
      <div className="relative mt-7" style={svgStyle}>
        <svg
          className="absolute inset-0 overflow-visible"
          width={svgStyle.width}
          height={svgStyle.height}
          aria-hidden
        >
          {edges.map(e => (
            <path
              key={`${e.from}→${e.to}`}
              d={e.d}
              fill="none"
              stroke="color-mix(in oklch, white, transparent 84%)"
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
  const failed = node.status === 'failed';
  const dimmed = node.status === 'pending' || node.status === 'skipped';
  // Fan-out attention (#2451): a `completed` fan-out node whose children did not all complete
  // gets AMBER attention + a `completed/total` badge — never a red `failed` status. Lifecycle
  // stays `completed`; the amber is attention, not a new DAG state.
  const attention = node.fanOut !== null && node.fanOut.notCompleted > 0 ? node.fanOut : null;
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: NODE_W,
    height: NODE_H,
    backgroundColor:
      attention !== null && !failed
        ? 'color-mix(in oklch, var(--warning), transparent 92%)'
        : statusFill(node.status),
    borderColor:
      attention !== null && !failed
        ? 'color-mix(in oklch, var(--warning), transparent 45%)'
        : statusBorder(node.status),
    boxShadow: failed
      ? '0 0 0 3px color-mix(in oklch, var(--error), transparent 94%)'
      : attention !== null
        ? '0 0 0 3px color-mix(in oklch, var(--warning), transparent 90%)'
        : undefined,
  };

  const attentionTitle =
    attention !== null
      ? ` · ${String(attention.notCompleted)} of ${String(attention.total)} children did not complete`
      : '';

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${node.id} · ${node.kind} · ${node.status}${attentionTitle}`}
      className={`absolute flex items-center gap-2.5 overflow-hidden rounded-[9px] border px-3.5 text-left transition-colors hover:brightness-110 ${
        running ? 'animate-pulse' : ''
      } ${dimmed ? 'opacity-60' : ''}`}
      style={style}
    >
      <span
        aria-hidden
        className={`shrink-0 font-mono text-[15px] font-bold leading-none ${
          attention !== null && !failed ? 'text-warning' : statusGlyphClass(node.status)
        }`}
      >
        {kindGlyph(node.kind)}
      </span>
      <span
        className={`min-w-0 flex-1 truncate font-mono text-[13px] font-semibold ${
          failed ? 'text-error' : dimmed ? 'text-text-secondary' : 'text-text-primary'
        }`}
      >
        {node.id}
      </span>
      {attention !== null ? (
        <span
          aria-hidden
          className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-warning"
        >
          {`${String(attention.completed)}/${String(attention.total)}`}
        </span>
      ) : null}
    </button>
  );
}
