import dagre from '@dagrejs/dagre';
import type { StepGraph, StepGraphGroup, StepGraphNode } from './step-graph';

// RunGraphPanel's sizes, so a workflow looks the same here as on a run.
export const STEP_W = 168;
export const STEP_H = 46;
const RANK_SEP = 58;
const NODE_SEP = 32;
export const STEP_GRAPH_PADDING = 30;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutStep extends Box {
  node: StepGraphNode;
}

export interface LaidOutGroup extends Box {
  group: StepGraphGroup;
}

export interface Point {
  x: number;
  y: number;
}

interface LaidOutEdge {
  from: string;
  to: string;
  /** The path's corners, from the source's bottom to the target's top. */
  points: Point[];
  /** The same path as SVG path data. */
  d: string;
}

interface StepGraphLayout {
  steps: LaidOutStep[];
  /** Outer groups first, so inner frames draw over them. */
  groups: LaidOutGroup[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/**
 * Lay a step graph out top to bottom with dagre, each group a compound node around its
 * steps. Edges only join steps: dagre's compound layout does not take edges on a group.
 * Edges follow dagre's own routes (see `route`), which keep out of frames they do not
 * belong to.
 */
export function layoutStepGraph(graph: StepGraph): StepGraphLayout {
  // A group holds at least one step; an empty one would be laid out as a zero-size node.
  const used = usedGroups(graph);
  const g = dagreGraph(graph, used);
  dagre.layout(g);
  const box = (id: string): Box => {
    const laid = g.node(id) as { x: number; y: number; width: number; height: number };
    return {
      x: laid.x - laid.width / 2,
      y: laid.y - laid.height / 2,
      width: laid.width,
      height: laid.height,
    };
  };
  const steps = graph.nodes.map(node => ({ node, ...box(node.key) }));
  const byKey = new Map(steps.map(step => [step.node.key, step]));
  const size = g.graph();
  return {
    steps,
    groups: graph.groups
      .filter(group => used.has(group.id))
      .map(group => ({ group, ...box(group.id) })),
    edges: graph.edges.flatMap(({ from, to }) => {
      const a = byKey.get(from);
      const b = byKey.get(to);
      if (a === undefined || b === undefined) return [];
      const inFrom = enclosing(graph, from);
      const inTo = enclosing(graph, to);
      const frames = (ids: Set<string>, not: Set<string>): Box[] =>
        [...ids].filter(id => !not.has(id)).map(box);
      const laidEdge = g.edge(from, to) as { points: Point[] };
      const points = route(laidEdge.points, a, b, frames(inFrom, inTo), frames(inTo, inFrom));
      return [{ from, to, points, d: pathData(points) }];
    }),
    width: size.width ?? 0,
    height: size.height ?? 0,
  };
}

function dagreGraph(graph: StepGraph, used: ReadonlySet<string>): dagre.graphlib.Graph {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    marginx: STEP_GRAPH_PADDING,
    marginy: STEP_GRAPH_PADDING,
  });
  const groups = graph.groups.filter(group => used.has(group.id));
  for (const group of groups) g.setNode(group.id, {});
  for (const group of groups) if (group.parent !== null) g.setParent(group.id, group.parent);
  for (const node of graph.nodes) {
    g.setNode(node.key, { width: STEP_W, height: STEP_H });
    if (node.group !== null) g.setParent(node.key, node.group);
  }
  for (const edge of graph.edges) g.setEdge(edge.from, edge.to);
  return g;
}

function usedGroups(graph: StepGraph): Set<string> {
  const parents = new Map(graph.groups.map(group => [group.id, group.parent]));
  const used = new Set<string>();
  for (const node of graph.nodes)
    for (let group = node.group; group !== null; group = parents.get(group) ?? null)
      used.add(group);
  return used;
}

/** Where an edge leaves its source, kept this far inside the source's sides. */
const EDGE_INSET = 10;

/** The groups a step is drawn in, innermost first. */
function enclosing(graph: StepGraph, key: string): Set<string> {
  const parents = new Map(graph.groups.map(group => [group.id, group.parent]));
  const found = new Set<string>();
  let group = graph.nodes.find(node => node.key === key)?.group ?? null;
  for (; group !== null; group = parents.get(group) ?? null) found.add(group);
  return found;
}

/**
 * dagre's waypoints for an edge, without those inside the frames the edge leaves or enters:
 * a compound layout puts them on the frames' borders, and a turn there would run along a
 * frame's edge or through its label.
 */
function clearWaypoints(
  points: readonly Point[],
  leaving: readonly Box[],
  entering: readonly Box[]
): Point[] {
  const below = Math.max(...leaving.map(box => box.y + box.height), -Infinity);
  const above = Math.min(...entering.map(box => box.y), Infinity);
  return points.slice(1, -1).filter(point => point.y > below + 1 && point.y < above - 1);
}

/**
 * An edge from the source's bottom to the target's top centre through dagre's waypoints, in
 * vertical and horizontal runs. dagre routes an edge around the frames it does not belong to
 * and spreads the edges leaving one step along its side, so siblings do not share a run.
 * Every turn sits on a waypoint, which lies between ranks rather than on a frame's border.
 */
function route(points: readonly Point[], a: Box, b: Box, leaving: Box[], entering: Box[]): Point[] {
  const first = points[0]?.x ?? a.x + a.width / 2;
  const start = {
    x: Math.round(Math.min(a.x + a.width - EDGE_INSET, Math.max(a.x + EDGE_INSET, first))),
    y: a.y + a.height,
  };
  const end = { x: b.x + b.width / 2, y: b.y };
  const via = clearWaypoints(points, leaving, entering);
  const path: Point[] = [start];
  const stops = [...via, end];
  stops.forEach((stop, index) => {
    const from = path.at(-1) ?? start;
    if (stop.x !== from.x) {
      // Turn on a waypoint's level: the next one's on the way down, else the last one's.
      const level = index < via.length ? stop.y : (via.at(-1)?.y ?? (from.y + stop.y) / 2);
      path.push({ x: from.x, y: level }, { x: stop.x, y: level });
    }
    path.push(stop);
  });
  return straighten(path);
}

/** The path without repeated points or corners that do not turn. */
function straighten(path: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of path) {
    const last = out.at(-1);
    if (last !== undefined && last.x === point.x && last.y === point.y) continue;
    const before = out.at(-2);
    if (
      before !== undefined &&
      last !== undefined &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    )
      out.pop();
    out.push(point);
  }
  return out;
}

/** The SVG path through orthogonal corners. */
function pathData(points: readonly Point[]): string {
  return points
    .map((point, index) => {
      if (index === 0) return `M${point.x.toString()},${point.y.toString()}`;
      const before = points[index - 1];
      return before?.x === point.x ? `V${point.y.toString()}` : `H${point.x.toString()}`;
    })
    .join(' ');
}
