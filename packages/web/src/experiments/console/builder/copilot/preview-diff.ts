/**
 * Pure preview computation for the Builder Copilot's Proposal overlay. Folds a
 * batch of ops over a CLONE of the current workflow — via the real
 * `editorReducer`'s `batch` action, never the live editor state — and diffs
 * the result against the current workflow to produce the ghost map
 * `BuilderPage` renders on canvas (Pre-flight #5).
 */
import { createEditorState, editorReducer } from '../editor/state';
import { builderToFlowEdges } from '../flow/to-flow';
import type { XYPosition } from '../flow/types';
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import { runValidation } from '../validation';
import { opsToEditorActions } from './translate-ops';
import type { ProposedEdit } from './op-schema';

export type GhostKind = 'add' | 'remove' | 'changed';
/** Edges only ever appear or disappear — there is no "changed" edge. */
export type EdgeGhostKind = 'add' | 'remove';

export interface ProposalPreview {
  /** Union workflow: the folded result's nodes PLUS any removed nodes re-included (struck-through). */
  workflow: BuilderWorkflow;
  ghosts: ReadonlyMap<string, GhostKind>;
  /**
   * Proposed connection changes, keyed by xyflow edge id. Without this a
   * proposed `connect` renders as an ordinary solid edge and a dropped one just
   * vanishes — so the author could not see which links the batch would change.
   */
  edgeGhosts: ReadonlyMap<string, EdgeGhostKind>;
  /** Positions for nodes new to the union (added ghosts). Merge UNDER the live position map — the
   *  fold recomputes a full-graph layout, which must not clobber the author's saved positions. */
  positions: ReadonlyMap<string, XYPosition>;
  issues: readonly Issue[];
}

function sameNode(a: BuilderNode, b: BuilderNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fold `ops` over `workflow` and compute the ghost overlay + would-be issues. Never throws —
 *  an op the translator can't apply becomes an `Issue`, not a crash of the whole preview. */
export function computeProposalPreview(
  workflow: BuilderWorkflow,
  ops: readonly ProposedEdit[]
): ProposalPreview {
  const { actions, issues: opIssues } = opsToEditorActions(ops, workflow);
  const seed = createEditorState(workflow);
  const result = actions.length > 0 ? editorReducer(seed, { type: 'batch', actions, at: 0 }) : seed;

  const currentById = new Map(workflow.nodes.map(n => [n.id, n]));
  const nextById = new Map(result.workflow.nodes.map(n => [n.id, n]));

  const ghosts = new Map<string, GhostKind>();
  for (const [id, node] of nextById) {
    const before = currentById.get(id);
    if (before === undefined) ghosts.set(id, 'add');
    else if (!sameNode(before, node)) ghosts.set(id, 'changed');
  }
  const removedNodes: BuilderNode[] = [];
  for (const [id, node] of currentById) {
    if (!nextById.has(id)) {
      ghosts.set(id, 'remove');
      removedNodes.push(node);
    }
  }

  const unionWorkflow: BuilderWorkflow = {
    ...result.workflow,
    nodes: [...result.workflow.nodes, ...removedNodes],
  };

  // Diff the derived edge sets rather than the ops: a `remove` op strips the
  // dependent edges too (via the reducer's `stripDeps`), so an op-level diff
  // would miss the connections that disappear as a side effect.
  const currentEdgeIds = new Set(builderToFlowEdges(workflow).map(e => e.id));
  const nextEdgeIds = new Set(builderToFlowEdges(result.workflow).map(e => e.id));
  const edgeGhosts = new Map<string, EdgeGhostKind>();
  for (const id of nextEdgeIds) if (!currentEdgeIds.has(id)) edgeGhosts.set(id, 'add');
  for (const id of currentEdgeIds) if (!nextEdgeIds.has(id)) edgeGhosts.set(id, 'remove');

  return {
    workflow: unionWorkflow,
    ghosts,
    edgeGhosts,
    positions: result.positions,
    issues: [...opIssues, ...(actions.length > 0 ? runValidation(result.workflow) : [])],
  };
}
