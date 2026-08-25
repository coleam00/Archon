/**
 * Content validation: scan text bodies for `$<nodeId>.output` references that
 * point outside the node's transitive upstream set, and verify each `when:`
 * expression parses and references only upstream nodes. Code spans are stripped
 * first so referenced ids inside fenced/inline code are not flagged.
 *
 * `content.var.unknown` is a deliberately conservative heuristic: it requires
 * the referenced node to be reachable via explicit `depends_on` edges. A
 * shared-context workflow can legitimately reference a node that ran earlier in
 * the topological order without declaring an edge — those references will warn
 * (severity `warning`, never `error`) because the builder cannot distinguish an
 * intentional shared-context read from a missing dependency. Declaring the edge
 * silences the warning and makes the ordering guarantee explicit.
 *
 * What a reference LOOKS like is not decided here — `@/lib/node-ref` owns that
 * one definition for the whole package, mirroring the engine's loader scan.
 */
import { findOutputRefs } from '@/lib/node-ref';
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import { makeIssue } from './make-issue';
import { parse } from './when-grammar';

/** Strip fenced code blocks and inline code spans, replacing them with spaces. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * Base-field text bodies — valid on every variant, so they are collected outside the
 * variant switch. `systemPrompt` and `agents.*` became runtime `$nodeId.output` surfaces
 * in the engine (#1764/#2476), where a dangling ref is now a load error; without them here
 * the builder would let an author write one and only learn at save.
 */
function baseTextBodies(node: BuilderNode): string[] {
  const bodies: string[] = [];
  if (node.base.systemPrompt !== undefined) bodies.push(node.base.systemPrompt);
  for (const agent of Object.values(node.base.agents ?? {})) {
    bodies.push(agent.prompt, agent.description);
  }
  return bodies;
}

/**
 * String surfaces of a node-local `with:` map (#2637): string values are live ref
 * surfaces (whole refs and templates), and a binding directive's `from` is exactly
 * one whole ref. Non-string literals carry no refs.
 */
function bindingTextBodies(withMap: Record<string, unknown> | undefined): string[] {
  const bodies: string[] = [];
  for (const value of Object.values(withMap ?? {})) {
    if (typeof value === 'string') {
      bodies.push(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const from = (value as { from?: unknown }).from;
      if (typeof from === 'string') bodies.push(from);
    }
  }
  return bodies;
}

/** The text bodies that carry `$nodeId.output` references for a given variant. */
function variantTextBodies(node: BuilderNode): string[] {
  switch (node.variant) {
    case 'prompt':
      return [node.data.prompt];
    case 'command':
      return [node.data.command, ...bindingTextBodies(node.data.with)];
    case 'bash':
      return [node.data.bash];
    case 'script':
      return [node.data.script, ...bindingTextBodies(node.data.with)];
    case 'approval':
      // `on_reject.prompt` is an ordinary prompt the engine substitutes and scans.
      return [node.data.message, ...(node.data.on_reject ? [node.data.on_reject.prompt] : [])];
    case 'wait':
      return [
        ...(node.data.until !== undefined ? [node.data.until] : []),
        ...(node.data.event !== undefined ? [node.data.event] : []),
      ];
    case 'loop':
      // A command-backed loop has no inline text to scan — the command file's
      // body is loaded at runtime (same posture as the engine loader's ref scan).
      // `until_bash` IS inline and is a live ref surface the loader scans.
      return [
        ...(node.data.prompt !== undefined ? [node.data.prompt] : []),
        ...(node.data.until_bash !== undefined ? [node.data.until_bash] : []),
      ];
    case 'cancel':
      return [node.data.reason];
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
    for (const body of [...baseTextBodies(node), ...variantTextBodies(node)]) {
      for (const refId of findOutputRefs(stripCode(body))) {
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
      } else {
        const refIds = new Set<string>();
        for (const group of result.ast.or) {
          for (const atom of group) {
            if (atom.kind === 'node') refIds.add(atom.nodeId);
          }
        }
        for (const refId of refIds) {
          if (!upstream.has(refId)) {
            issues.push(
              makeIssue({
                rule: 'content.var.unknown',
                severity: 'warning',
                source: 'client-debounced',
                message: `node '${node.id}' when references node '${refId}' which is not an upstream dependency`,
                path: { nodeId: node.id, field: 'when' },
              })
            );
          }
        }
      }
    }
  }

  return issues;
}
