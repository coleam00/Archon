/**
 * Content validation: scan text bodies for `$<nodeId>.output` references that
 * point outside the node's transitive upstream set, and verify each `when:`
 * expression parses. Code spans are stripped first so referenced ids inside
 * fenced/inline code are not flagged.
 *
 * `content.var.unknown` is a deliberately conservative heuristic: it requires
 * the referenced node to be reachable via explicit `depends_on` edges. A
 * shared-context workflow can legitimately reference a node that ran earlier in
 * the topological order without declaring an edge — those references will warn
 * (severity `warning`, never `error`) because the builder cannot distinguish an
 * intentional shared-context read from a missing dependency. Declaring the edge
 * silences the warning and makes the ordering guarantee explicit.
 */
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import { makeIssue } from './make-issue';
import { parse } from './when-grammar';

/** Strip fenced code blocks and inline code spans, replacing them with spaces. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/** Matches `$nodeId.output` references in body text. */
const OUTPUT_REF_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output\b/g;

/** The text bodies that carry `$nodeId.output` references for a given variant. */
function textBodies(node: BuilderNode): string[] {
  switch (node.variant) {
    case 'prompt':
      return [node.data.prompt];
    case 'command':
      return [node.data.command];
    case 'bash':
      return [node.data.bash];
    case 'script':
      return [node.data.script];
    case 'approval':
      return [node.data.message];
    case 'loop':
      return [node.data.prompt];
    case 'cancel':
      return [];
  }
}

/** Compute the transitive set of upstream node ids reachable via `depends_on`. */
function upstreamSet(startId: string, depsById: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  // Stack + pop() (not queue.shift()) keeps traversal O(V+E) on long chains;
  // visitation order is irrelevant since we only collect into a set.
  const stack: string[] = [...(depsById.get(startId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const dep of depsById.get(current) ?? []) stack.push(dep);
  }
  return seen;
}

/** Validate content references and `when:` expressions across the workflow. */
export function validateContent(workflow: BuilderWorkflow): Issue[] {
  const issues: Issue[] = [];
  const depsById = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    depsById.set(node.id, node.base.depends_on ?? []);
  }

  for (const node of workflow.nodes) {
    const upstream = upstreamSet(node.id, depsById);

    // Output-reference scan over the node's text bodies.
    for (const body of textBodies(node)) {
      const stripped = stripCode(body);
      const refs = new Set<string>();
      for (const match of stripped.matchAll(OUTPUT_REF_PATTERN)) {
        const refId = match[1];
        if (refId !== undefined) refs.add(refId);
      }
      for (const refId of refs) {
        if (!upstream.has(refId)) {
          issues.push(
            makeIssue({
              rule: 'content.var.unknown',
              severity: 'warning',
              source: 'client-debounced',
              message: `node '${node.id}' references '$${refId}.output' which is not an upstream dependency`,
              path: { nodeId: node.id },
            })
          );
        }
      }
    }

    // `when:` parse check.
    const when = node.base.when;
    if (when !== undefined && when.trim().length > 0) {
      const result = parse(when);
      if (!result.ok) {
        issues.push(
          makeIssue({
            rule: 'content.when.parse',
            severity: 'error',
            source: 'client-debounced',
            message: `node '${node.id}': invalid when expression — ${result.error}`,
            path: { nodeId: node.id, field: 'when' },
          })
        );
      }
    }
  }

  return issues;
}
