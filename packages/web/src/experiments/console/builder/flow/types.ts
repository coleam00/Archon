/**
 * Canvas-side types for the builder. PR-1's `BuilderNode` deliberately has no
 * `position`/selection fields (data layer only); the xyflow `Node<T>` shape
 * carries those canvas concerns. `flow/` owns the bridge between the two.
 */
import type { Edge, Node } from '@xyflow/react';
import type { BuilderNode } from '../types';

/** An x/y point in flow coordinates (mirrors xyflow's `XYPosition`). */
export interface XYPosition {
  x: number;
  y: number;
}

/**
 * The data payload on each canvas node: the whole `BuilderNode` plus its
 * registry display label, so the node renderer and `flowToBuilder` both reach
 * the data-layer node without lossy flattening.
 */
export interface BuilderNodeData {
  node: BuilderNode;
  label: string;
  /** Required by React Flow's Node<T> constraint — do not rely on this for typed access. */
  [key: string]: unknown;
}

/** A builder node as rendered on the xyflow canvas. */
export type BuilderFlowNode = Node<BuilderNodeData>;

/** A `depends_on` edge as rendered on the xyflow canvas. */
export type BuilderFlowEdge = Edge;
