import type { z } from 'zod';
import type { DagNode, IncludeDirective } from '../schemas';
import {
  isAgentNode,
  isComposeFanOutNode,
  isExecNode,
  isIncludeDirective,
  isWorkflowNode,
} from '../schemas';
import { dagNodeSchema, ignoredFieldsForNode } from '../schemas/dag-node';
import { getLog } from './log';
import {
  collectLoopUntilDeprecationWarnings,
  collectUnknownNodeKeys,
  nodeIdForMessages,
} from './parse-warnings';

/**
 * Format a Zod validation error issue into a human-readable string for a named node.
 */
function formatNodeIssue(id: string, issue: z.ZodIssue): string {
  const pathStr = issue.path.length > 0 ? `'${issue.path.join('.')}' ` : '';
  return `Node '${id}': ${pathStr}${issue.message}`;
}

/**
 * Validate and parse a single DAG node from raw YAML, recording schema errors
 * and author-facing warnings.
 */
export function parseDagNode(
  raw: unknown,
  index: number,
  errors: string[],
  warnings: string[]
): DagNode | IncludeDirective | null {
  // Extract id early for error messages (may be empty/invalid — schema will catch it)
  const id = nodeIdForMessages(raw, index);

  const result = dagNodeSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(formatNodeIssue(id, issue));
    }
    return null;
  }

  const node = result.data;

  // `mutates_checkout:` is workflow-level, so Zod strips a misplaced node-level value
  // before superRefine runs. A composed block, fanned out or not, runs inside the
  // composing run and shares its checkout, so the declaration belongs to that run.
  if (isIncludeDirective(node) && (raw as Record<string, unknown>).mutates_checkout !== undefined) {
    errors.push(
      `Node '${id}': 'mutates_checkout' is not supported on an include node: a composed block shares the run's single checkout, so concurrency safety is the composing workflow's to declare. Set it at workflow level, or use a 'workflow:' node when you want a separate governed run.`
    );
    return null;
  }
  if (
    isComposeFanOutNode(node) &&
    (raw as Record<string, unknown>).mutates_checkout !== undefined
  ) {
    errors.push(
      `Node '${id}': 'mutates_checkout' is not supported on a composed fan-out node: its instances run inside this run and share its checkout. Set 'fan_out.max_parallel: 1' to run them one at a time, or use a 'workflow:' fan-out for separate governed runs.`
    );
    return null;
  }
  collectUnknownNodeKeys(raw, id, `Node '${id}'`, warnings);
  collectLoopUntilDeprecationWarnings(node, id, warnings);

  // `with:` is live on an agent node's command-sourced form (node-local bindings,
  // #2637), on exec (script-runtime only), and on include/workflow (caller inputs).
  // On every other node type Zod strips it silently — surface that through the
  // parse-warnings channel (#2213) so an author learns the binding never attached,
  // without rejecting YAML that loaded fine before.
  const hasWithSupport =
    isIncludeDirective(node) ||
    isWorkflowNode(node) ||
    isComposeFanOutNode(node) ||
    (isExecNode(node) && node.runtime !== 'sh') ||
    (isAgentNode(node) && node.source.kind === 'command');
  if ((raw as Record<string, unknown>).with !== undefined && !hasWithSupport) {
    warnings.push(
      `Node '${id}': 'with' is only supported on command, script, include, and workflow nodes — it is ignored here`
    );
    getLog().debug({ id: node.id }, 'node_with_ignored');
  }

  if ((raw as Record<string, unknown>).on_timeout !== undefined && node.kind !== 'exec') {
    warnings.push(
      `Node '${id}': 'on_timeout' is only supported on bash and script nodes — it is ignored here`
    );
    getLog().debug({ id: node.id }, 'node_on_timeout_ignored');
  }

  // parseWarnings owns author-facing diagnostics; the structured log observes the
  // same message for operators without becoming a second classification path.
  const nonAiNode = ignoredFieldsForNode(node);
  if (nonAiNode) {
    const presentAiFields = nonAiNode.fields.filter(
      f => (raw as Record<string, unknown>)[f] !== undefined
    );
    if (presentAiFields.length > 0) {
      const quoted = presentAiFields.map(f => `'${f}'`).join(', ');
      const plural = presentAiFields.length > 1;
      const message =
        nonAiNode.type === 'include'
          ? `Node '${id}': ${quoted} ${plural ? 'are' : 'is'} ignored and will have no effect ` +
            '(an include attaches a sub-graph and does not reconfigure it; declare the ' +
            `${plural ? 'fields' : 'field'} on the included nodes instead)`
          : `Node '${id}': ${quoted} ${plural ? 'are' : 'is'} not supported on this node type ` +
            `(${nonAiNode.type}) — ${plural ? 'they are' : 'it is'} ignored at run time.`;
      warnings.push(message);
      getLog().debug(
        { id: node.id, fields: presentAiFields, warning: message },
        `${nonAiNode.type}_node_ai_fields_ignored`
      );
    }
  }

  return node;
}
