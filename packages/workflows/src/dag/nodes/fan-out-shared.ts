import type { FanOutConfig, WorkflowNode } from '../../schemas';
import type { JsonValue } from '../../output-ref';
import { substituteWorkflowVariables } from '../../workflow-variables';
import type { ChildWorkflowOutcome } from '../child-run';
import {
  resolveRunInputs,
  nodeTemplateReferences,
  type ShellInputContext,
  resolveWorkflowValue,
} from '../references';

export function resolveFanOutItems(
  node: Pick<WorkflowNode, 'id'>,
  ctx: ShellInputContext,
  fanOut: Pick<FanOutConfig, 'items'>
): { items: JsonValue[] } | { error: string } {
  const parentRun = ctx.workflowRun;
  let parsedItems: unknown;
  try {
    const { prompt: itemsResolved } = substituteWorkflowVariables(
      fanOut.items,
      parentRun.id,
      parentRun.user_message ?? '',
      ctx.artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      undefined,
      undefined,
      undefined,
      { references: nodeTemplateReferences(fanOut.items, ctx) }
    );
    parsedItems = JSON.parse(itemsResolved);
  } catch (err) {
    return {
      error: `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`,
    };
  }
  if (!Array.isArray(parsedItems)) {
    return {
      error:
        `fan_out.items on '${node.id}' resolved to ${typeof parsedItems}, not a JSON array. ` +
        `'${fanOut.items}' must reference a node output that produces a JSON array.`,
    };
  }
  return { items: parsedItems };
}

export function resolveFanOutStaticInputs(
  node: Pick<WorkflowNode, 'id' | 'with'>,
  ctx: ShellInputContext
): { inputs: Record<string, JsonValue> } | { error: string } {
  const parentInputs = resolveRunInputs(ctx.workflowRun);
  try {
    return {
      inputs: Object.fromEntries(
        Object.entries(node.with ?? {}).map(([name, rawValue]) => [
          name,
          resolveWorkflowValue(rawValue, ctx, parentInputs, false),
        ])
      ),
    };
  } catch (err) {
    return {
      error: `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`,
    };
  }
}

/**
 * Collectors check the reserved discriminator, not error/status fields a successful
 * payload may also contain. Child schemas must avoid this key; it is not unforgeable.
 */
export type FanOutFailureMarker = {
  archon_failed: true;
  error: string;
  status: Exclude<ChildWorkflowOutcome['status'], 'completed'>;
};

export function fanOutFailureMarker(
  status: FanOutFailureMarker['status'],
  error: string
): FanOutFailureMarker {
  return { archon_failed: true, error, status };
}
