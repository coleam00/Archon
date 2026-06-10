/**
 * Graph-structure validation: `depends_on` reference integrity and cycle
 * detection. The three-color DFS is a builder-specific choice (good cycle-path
 * reporting); the engine reaches the same acyclicity verdict via Kahn's
 * algorithm in its loader — same contract, different algorithm.
 */
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import { makeIssue } from './make-issue';

/** A node's direct dependencies (empty when unset). */
function depsOf(node: BuilderNode): string[] {
  return node.base.depends_on ?? [];
}

/** Emit `graph.ref.unknown` for every `depends_on` target that is not a node id. */
function checkRefs(nodes: BuilderNode[], idSet: Set<string>): Issue[] {
  const issues: Issue[] = [];
  for (const node of nodes) {
    for (const dep of depsOf(node)) {
      if (!idSet.has(dep)) {
        issues.push(
          makeIssue({
            rule: 'graph.ref.unknown',
            severity: 'error',
            source: 'client-debounced',
            message: `node '${node.id}' depends on unknown node '${dep}'`,
            path: { nodeId: node.id, field: 'depends_on' },
          })
        );
      }
    }
  }
  return issues;
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/** Detect cycles in the `depends_on` graph via three-color DFS. */
function checkCycles(nodes: BuilderNode[], idSet: Set<string>): Issue[] {
  const color = new Map<string, number>();
  const depsById = new Map<string, string[]>();
  for (const node of nodes) {
    color.set(node.id, WHITE);
    depsById.set(node.id, depsOf(node));
  }

  const issues: Issue[] = [];

  function visit(id: string): void {
    color.set(id, GRAY);
    for (const dep of depsById.get(id) ?? []) {
      if (!idSet.has(dep)) continue; // unknown refs are reported by checkRefs
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        // Back edge → the dependency closes a cycle.
        issues.push(
          makeIssue({
            rule: 'graph.cycle',
            severity: 'error',
            source: 'client-debounced',
            message: `dependency cycle detected involving node '${dep}'`,
            path: { nodeId: dep, field: 'depends_on' },
          })
        );
      } else if (depColor === WHITE) {
        visit(dep);
      }
    }
    color.set(id, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node.id) === WHITE) visit(node.id);
  }
  return issues;
}

/** Validate `depends_on` reference integrity and acyclicity. */
export function validateGraph(workflow: BuilderWorkflow): Issue[] {
  const idSet = new Set<string>(workflow.nodes.map(n => n.id));
  return [...checkRefs(workflow.nodes, idSet), ...checkCycles(workflow.nodes, idSet)];
}
