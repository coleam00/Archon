import type { NodeFailureKind } from '../../../schemas/node-execution';
import type {
  ComposeFanOutNode,
  DagNode,
  IncludeDirective,
  ResolvedWorkflow,
} from '../../../schemas';
import { type JsonValue } from '../../../output-ref';
import type { IncludeCommandContent } from '../../../compiled-command';
import { instantiateResolvedInclude } from '../../../include/inline';
import { buildInstanceSnapshots, type FanOutInstanceSnapshot } from '../../../fan-out-identity';
import { substituteWorkflowVariables } from '../../../workflow-variables';
import { getLog } from '../../log';
import { type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  nodeTemplateReferences,
  type ShellInputContext,
  resolveWorkflowValue,
} from '../../references';

/** A composed fan-out failure: the persisted error, its kind, and the platform notice. */
export interface ComposeFanOutFailure {
  error: string;
  failureKind: NodeFailureKind;
  notice: string;
}

/** The node's current item list, resolved from `fan_out.items`. */
export function resolveComposeItems(
  node: ComposeFanOutNode,
  ctx: RunLayersContext,
  fanOut: ComposeFanOutNode['fan_out']
): { items: JsonValue[] } | { error: string } {
  const parentRun = ctx.workflowRun;
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
    const parsed: unknown = JSON.parse(itemsResolved);
    if (!Array.isArray(parsed)) {
      return {
        error:
          `fan_out.items on '${node.id}' resolved to ${typeof parsed}, not a JSON array. ` +
          `'${fanOut.items}' must reference a node output that produces a JSON array.`,
      };
    }
    return { items: parsed };
  } catch (err) {
    return {
      error: `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`,
    };
  }
}

function resolveComposeStaticInputs(
  node: ComposeFanOutNode,
  ctx: RunLayersContext
): { inputs: Record<string, JsonValue> } | { error: string } {
  const parentRun = ctx.workflowRun;
  let inputs: Record<string, JsonValue> = {};
  const parentInputs = resolveRunInputs(parentRun);
  try {
    if (node.with !== undefined) {
      const resolutionCtx: ShellInputContext = {
        workflowRun: parentRun,
        artifactsDir: ctx.artifactsDir,
        stateDir: ctx.stateDir,
        baseBranch: ctx.baseBranch,
        docsDir: ctx.docsDir,
        issueContext: ctx.issueContext,
        nodeOutputs: ctx.nodeOutputs,
        loopBodyScopes: ctx.loopBodyScopes,
      };
      inputs = Object.fromEntries(
        Object.entries(node.with).map(([name, rawValue]) => [
          name,
          resolveWorkflowValue(rawValue, resolutionCtx, parentInputs, false),
        ])
      );
    }
  } catch (err) {
    return {
      error: `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`,
    };
  }
  return { inputs };
}

function snapshotsDiffer(
  persisted: readonly FanOutInstanceSnapshot[],
  computed: readonly FanOutInstanceSnapshot[]
): boolean {
  return (
    persisted.length !== computed.length ||
    persisted.some((snapshot, index) => {
      const current = computed[index];
      return (
        snapshot.identity !== current?.identity ||
        JSON.stringify(snapshot.item) !== JSON.stringify(current?.item)
      );
    })
  );
}

/**
 * The instance set this pass executes. A fresh fan-out freezes every resolved binding
 * together with its item and persists the set before any instance starts, so a resumed
 * run never combines completed work from old bindings with a retried instance resolved
 * from changed upstream output. Once a set is persisted it owns the instances; the current
 * items only feed a drift warning.
 */
export async function planComposeInstances(
  node: ComposeFanOutNode,
  ctx: RunLayersContext,
  fanOut: ComposeFanOutNode['fan_out'],
  fanOutScopeName: string,
  currentItems: { items: JsonValue[] } | { error: string },
  persistedSnapshots: readonly FanOutInstanceSnapshot[] | undefined
): Promise<{ snapshots: readonly FanOutInstanceSnapshot[] } | ComposeFanOutFailure> {
  const parentRun = ctx.workflowRun;
  if (persistedSnapshots !== undefined) {
    // Only compare item identity for drift diagnostics. The persisted input map is the
    // authority on resume, so current `with:` references are intentionally not resolved.
    const computed =
      'items' in currentItems
        ? buildInstanceSnapshots(currentItems.items, {}, fanOut.as)
        : [...persistedSnapshots];
    if (snapshotsDiffer(persistedSnapshots, computed)) {
      getLog().warn(
        { parentRunId: parentRun.id, nodeId: node.id },
        'workflow.compose_fan_out_using_persisted_instances'
      );
    }
    return { snapshots: persistedSnapshots };
  }

  const staticInputs = resolveComposeStaticInputs(node, ctx);
  if ('error' in staticInputs) {
    return {
      error: staticInputs.error,
      failureKind: 'config',
      notice: `❌ **Composed fan-out failed** (node \`${node.id}\`): ${staticInputs.error}`,
    };
  }
  if ('error' in currentItems) {
    throw new Error('unreachable: fresh composed fan-out has no resolved item list');
  }
  const snapshots = buildInstanceSnapshots(currentItems.items, staticInputs.inputs, fanOut.as);
  try {
    await ctx.deps.store.persistWorkflowEvent({
      workflow_run_id: parentRun.id,
      event_type: 'fan_out_instances',
      step_name: fanOutScopeName,
      data: { instances: snapshots },
    });
  } catch (err) {
    const error =
      `composed fan-out node '${node.id}' could not persist its item snapshot before ` +
      `execution: ${(err as Error).message}`;
    return {
      error,
      failureKind: 'unknown',
      notice: `❌ **Composed fan-out blocked** (node \`${node.id}\`): ${error}`,
    };
  }
  return { snapshots };
}

/**
 * Instantiate ONE composed fan-out item through the same narrow primitive used by a
 * static include. The target closure was already resolved and validated at load time;
 * only input materialization and instance namespacing vary per item.
 */
export function expandComposeInstance(
  node: ComposeFanOutNode,
  identity: string,
  inputs: Record<string, JsonValue>,
  definition: ResolvedWorkflow,
  commandContents: ReadonlyMap<string, IncludeCommandContent>
): { nodes: DagNode[]; primarySink: string } | { error: string } {
  const directiveId = `${node.id}__${identity}`;
  const directive: IncludeDirective = {
    id: directiveId,
    kind: 'include',
    include: node.include,
    ...(Object.keys(inputs).length > 0 ? { with: inputs } : {}),
  };
  const expanded = instantiateResolvedInclude(directive, definition, commandContents);
  const primarySink = expanded.primarySink;
  if (primarySink === '') {
    return { error: `composed block '${definition.name}' has no sink node` };
  }
  return { nodes: expanded.namespaced, primarySink };
}
