import type { DagNode } from '../../schemas';
import { type Issue } from '../types';
import { mk as mkIssue } from './helpers';

// Three-color DFS constants: WHITE=0, GRAY=1, BLACK=2.
type Color = 0 | 1 | 2;

/**
 * Debounced-tier graph rules:
 *   - graph.ref.unknown  — depends_on references a node id that doesn't exist
 *   - graph.cycle        — one issue per node that participates in a cycle
 *
 * NOTE (drift 6.2.1): Decision-branch goto ref-integrity was dropped because
 * the `decision` variant does not exist in the current DagNode schema; there
 * are no routing edges (on_success / on_failure / goto) in the schema at this
 * time. See phase-6-drift-notes.md §6.2.1.
 */
export function runGraphRules(nodes: readonly DagNode[]): Issue[] {
  const out: Issue[] = [];
  const ids = new Set(nodes.map(n => n.id));

  // -------------------------------------------------------------------------
  // Ref integrity: depends_on
  // Each unknown reference emits one issue on the referencing node.
  // -------------------------------------------------------------------------
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) {
        out.push(
          err(
            'graph.ref.unknown',
            { nodeId: node.id, field: 'depends_on' },
            `depends_on references unknown node "${dep}".`
          )
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cycle detection — three-color DFS over depends_on edges.
  //
  // We walk depends_on as the adjacency list (u → depends_on[u], meaning
  // "u depends on v" is an edge u→v). A GRAY back-edge u→v means every node
  // between v and u on the stack is in the cycle.
  //
  // Results are collected into a Set<string> so each node is reported once
  // even if it participates in multiple paths through the DFS.
  //
  // NOTE: The cycle DFS is recursive. V8's call-stack depth is ~10–15k frames.
  // `depends_on` graphs in the Studio UI are bounded by canvas node counts
  // (typically < 200). If programmatically-generated graphs of arbitrary depth
  // become a supported input, convert this to an iterative stack-based DFS.
  // -------------------------------------------------------------------------
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    // Only include edges to known nodes; unknown-ref issues are already above.
    adj.set(
      node.id,
      (node.depends_on ?? []).filter(d => ids.has(d))
    );
  }

  const color = new Map<string, Color>();
  for (const node of nodes) color.set(node.id, 0);

  const cycleMembers = new Set<string>();
  const stack: string[] = [];

  function dfs(u: string): void {
    color.set(u, 1); // GRAY — currently on stack
    stack.push(u);

    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) {
        // Back-edge: v is GRAY — everything from v to the top of the stack
        // (inclusive) is part of the cycle.
        const startIdx = stack.indexOf(v);
        for (let i = startIdx; i < stack.length; i++) cycleMembers.add(stack[i]);
      } else if (color.get(v) === 0) {
        // WHITE — not yet visited.
        dfs(v);
      }
      // BLACK — already fully explored, safe to skip.
    }

    stack.pop();
    color.set(u, 2); // BLACK — fully explored
  }

  // Visit nodes in input order so issue ordering is deterministic.
  for (const node of nodes) {
    if (color.get(node.id) === 0) dfs(node.id);
  }

  // Emit one issue per cycle-member node, in input order for stability.
  for (const node of nodes) {
    if (cycleMembers.has(node.id)) {
      out.push(
        err(
          'graph.cycle',
          { nodeId: node.id },
          `Node "${node.id}" is part of a cycle in depends_on.`
        )
      );
    }
  }

  return out;
}

function err(rule: string, path: Issue['path'], message: string): Issue {
  return mkIssue(rule, 'error', 'client-debounced', path, message);
}
