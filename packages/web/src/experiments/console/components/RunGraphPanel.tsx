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
import type { RunNodeState } from '../primitives/event';

interface RunGraphPanelProps {
  workflowName: string;
  projectCwd: string;
  /** The engine's node states (`run.nodes`). */
  nodes: readonly RunNodeState[];
  /** False once the run's owner is not observed live: running nodes stop pulsing. */
  live: boolean;
  selectedNodeId: string | null;
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
    case 'wait':
      return '◷';
    case 'cancel':
      return '⊘';
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
  nodes: nodeStates,
  live,
  selectedNodeId,
  onNodeSelect,
}: RunGraphPanelProps): ReactElement {
  const { data: rawNodes, error } = useEntity<WorkflowGraphNode[]>(
    `workflow-graph:${workflowName}:${projectCwd}`,
    () => skill.getWorkflowGraph(workflowName, projectCwd)
  );

  const withStatus = useMemo(
    () => (rawNodes === undefined ? null : deriveNodeStatuses(rawNodes, nodeStates)),
    [rawNodes, nodeStates]
  );

  if (error !== undefined) {
    return (
      <div className="p-6 font-mono text-console-12 text-error">
        Could not load graph: {error.message}
      </div>
    );
  }

  if (withStatus === null) {
    return <div className="p-6 text-console-12 text-text-tertiary">Loading graph…</div>;
  }

  return (
    <WorkflowGraphCanvas
      nodes={withStatus}
      live={live}
      selectedNodeId={selectedNodeId}
      onNodeSelect={onNodeSelect}
    />
  );
}

interface WorkflowGraphCanvasProps {
  nodes: readonly WorkflowGraphNodeWithStatus[];
  live: boolean;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  /** A node's name as a person reads it; the engine id when not given. */
  labelOf?: (nodeId: string) => string;
  /** Show each node's kind under its name, and an arrowhead on every edge. */
  detailed?: boolean;
  /** Leave a node the run has not reached at full strength (a static picture of a workflow). */
  plain?: boolean;
  /** Fill the parent's height and centre in it (the run page); otherwise size to the graph. */
  fill?: boolean;
}

/**
 * The DAG itself: dagre (rankdir=TB) layout, orthogonal connectors and one button per node. The
 * run page draws it with the engine's node states; the factory draws a stage's workflow with it
 * (`detailed`, `plain`), highlighting the step an item runs at.
 */
export function WorkflowGraphCanvas({
  nodes: withStatus,
  live,
  selectedNodeId = null,
  onNodeSelect,
  labelOf,
  detailed = false,
  plain = false,
  fill = true,
}: WorkflowGraphCanvasProps): ReactElement {
  const laid = useMemo(() => layout([...withStatus]), [withStatus]);
  const { nodes, edges, width, height } = laid;
  const svgStyle: CSSProperties = {
    width: Math.max(width, NODE_W + PADDING * 2),
    height: Math.max(height, NODE_H + PADDING * 2),
  };

  return (
    <div
      className={`flex w-full overflow-auto p-6 ${fill ? 'h-full justify-center' : 'max-h-[60vh]'}`}
      // Dotted canvas (design v3 .rd-graph).
      style={{
        background:
          'radial-gradient(circle at 1px 1px, color-mix(in oklch, white, transparent 95%) 1px, transparent 0) 0 0 / 26px 26px',
      }}
    >
      <div className={`relative ${fill ? 'mt-7' : 'm-auto shrink-0'}`} style={svgStyle}>
        <svg
          className="absolute inset-0 overflow-visible"
          width={svgStyle.width}
          height={svgStyle.height}
          aria-hidden
        >
          {detailed ? (
            <defs>
              <marker
                id="wg-head"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,1 L9,5 L0,9 z" fill="color-mix(in oklch, white, transparent 45%)" />
              </marker>
            </defs>
          ) : null}
          {edges.map(e => (
            <path
              key={`${e.from}→${e.to}`}
              d={e.d}
              fill="none"
              stroke="color-mix(in oklch, white, transparent 84%)"
              strokeWidth={1.5}
              markerEnd={detailed ? 'url(#wg-head)' : undefined}
            />
          ))}
        </svg>
        {nodes.map(n => (
          <GraphNode
            key={n.id}
            node={n}
            live={live}
            selected={n.id === selectedNodeId}
            label={labelOf?.(n.id) ?? n.id}
            detailed={detailed}
            plain={plain}
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
  live: boolean;
  selected: boolean;
  label: string;
  detailed: boolean;
  plain: boolean;
  onClick: () => void;
}

function GraphNode({
  node,
  live,
  selected,
  label,
  detailed,
  plain,
  onClick,
}: GraphNodeProps): ReactElement {
  const running = node.status === 'running';
  const failed = node.status === 'failed';
  const dimmed = !plain && (node.status === 'pending' || node.status === 'skipped');
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: NODE_W,
    height: NODE_H,
    backgroundColor: statusFill(node.status),
    borderColor: statusBorder(node.status),
    boxShadow:
      failed && !selected
        ? '0 0 0 3px color-mix(in oklch, var(--error), transparent 94%)'
        : undefined,
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-step={node.id}
      title={`${node.id} · ${node.kind}${plain ? '' : ` · ${node.status}`}`}
      className={`absolute flex items-center gap-2.5 overflow-hidden rounded-lg border px-3.5 text-left transition-colors hover:brightness-110 ${
        running && live ? 'animate-pulse' : ''
      } ${dimmed && !selected ? 'opacity-60' : ''} ${selected ? 'ring-2 ring-accent-bright ring-offset-2 ring-offset-surface' : ''}`}
      style={style}
    >
      <span
        aria-hidden
        className={`shrink-0 font-mono text-console-15 font-bold leading-none ${statusGlyphClass(node.status)}`}
      >
        {kindGlyph(node.kind)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={`truncate font-semibold ${detailed ? 'text-console-13' : 'font-mono text-console-13'} ${
            failed ? 'text-error' : dimmed ? 'text-text-secondary' : 'text-text-primary'
          }`}
        >
          {label}
        </span>
        {detailed ? (
          <span className="truncate text-console-11 uppercase tracking-console-label text-text-tertiary">
            {node.kind}
          </span>
        ) : null}
      </span>
    </button>
  );
}
