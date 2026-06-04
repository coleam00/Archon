/**
 * Structural validation: node-id hygiene (non-empty, unique) and per-variant
 * required-field checks. Hand-rolled to match the engine's superRefine intent
 * without depending on a runtime schema.
 */
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import { makeIssue } from './make-issue';

/** Empty (or whitespace-only) ids and duplicate ids across the node list. */
function checkIds(nodes: BuilderNode[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const id = node.id.trim();
    if (id.length === 0) {
      issues.push(
        makeIssue({
          rule: 'structural.id.empty',
          severity: 'error',
          source: 'client-instant',
          message: 'node id must not be empty',
          path: { nodeId: node.id, field: 'id' },
        })
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(
        makeIssue({
          rule: 'structural.id.duplicate',
          severity: 'error',
          source: 'client-instant',
          message: `duplicate node id '${id}'`,
          path: { nodeId: id, field: 'id' },
        })
      );
    }
    seen.add(id);
  }
  return issues;
}

/** Per-variant required-field checks (mirrors the engine's mode-field rules). */
function checkRequiredFields(node: BuilderNode): Issue[] {
  const issues: Issue[] = [];
  const missing = (field: string, message: string): void => {
    issues.push(
      makeIssue({
        rule: 'structural.field.missing',
        severity: 'error',
        source: 'client-instant',
        message,
        path: { nodeId: node.id, field },
      })
    );
  };

  switch (node.variant) {
    case 'prompt':
      if (node.data.prompt.trim().length === 0)
        missing('prompt', `node '${node.id}': prompt must not be empty`);
      break;
    case 'command':
      if (node.data.command.trim().length === 0)
        missing('command', `node '${node.id}': command must not be empty`);
      break;
    case 'bash':
      if (node.data.bash.trim().length === 0)
        missing('bash', `node '${node.id}': bash script must not be empty`);
      break;
    case 'script':
      if (node.data.script.trim().length === 0)
        missing('script', `node '${node.id}': script must not be empty`);
      if (node.data.runtime !== 'bun' && node.data.runtime !== 'uv')
        missing('runtime', `node '${node.id}': script requires runtime 'bun' or 'uv'`);
      break;
    case 'loop':
      if (node.data.prompt.trim().length === 0)
        missing('loop.prompt', `node '${node.id}': loop requires a prompt`);
      if (node.data.until.trim().length === 0)
        missing('loop.until', `node '${node.id}': loop requires an 'until' signal`);
      if (!Number.isInteger(node.data.max_iterations) || node.data.max_iterations <= 0)
        missing(
          'loop.max_iterations',
          `node '${node.id}': loop requires a positive integer max_iterations`
        );
      break;
    case 'approval':
      if (node.data.message.trim().length === 0)
        missing('approval.message', `node '${node.id}': approval requires a message`);
      break;
    case 'cancel':
      if (node.data.reason.trim().length === 0)
        missing('cancel', `node '${node.id}': cancel requires a reason`);
      break;
  }
  return issues;
}

/** Validate node-id hygiene and per-variant required fields. */
export function validateStructural(workflow: BuilderWorkflow): Issue[] {
  const issues: Issue[] = checkIds(workflow.nodes);
  for (const node of workflow.nodes) {
    issues.push(...checkRequiredFields(node));
  }
  return issues;
}
