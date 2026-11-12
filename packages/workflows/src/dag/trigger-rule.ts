import type { NodeSkipReason, SkipCause, NodeOutput, DagNode, TriggerRule } from '../schemas';
import type { JsonValue } from '../output-ref';
import { readComposedMeta, type ComposedBlockBoundary } from '../compiled-command';
import type { LoopBodyScope } from './loop-scope';
import { evaluateCondition } from '../condition-evaluator';
import { formatIncludeBoundaryId } from '../skip-cause';

export type TriggerRuleDecision =
  | { decision: 'run' }
  | { decision: 'skip'; cause: SkipCause; error?: unknown };

export interface TriggerRuleUpstream {
  id: string;
  output: NodeOutput;
}

export function triggerSkipCause(upstreams: readonly TriggerRuleUpstream[]): SkipCause {
  for (const upstream of upstreams) {
    if (upstream.output.state === 'failed') {
      return { kind: 'upstream_failed', origin: upstream.id };
    }
    if (upstream.output.state === 'skipped' && upstream.output.cause.kind === 'upstream_failed') {
      return { kind: 'upstream_failed', origin: upstream.output.cause.origin };
    }
  }

  const skipped = upstreams.find(upstream => upstream.output.state === 'skipped');
  if (skipped?.output.state === 'skipped') {
    return {
      kind: 'upstream_skipped',
      origin:
        skipped.output.cause.kind === 'upstream_skipped' ? skipped.output.cause.origin : skipped.id,
    };
  }

  const unsettled = upstreams[0];
  if (unsettled === undefined) {
    throw new Error('Cannot determine a skip cause without a blocking dependency');
  }
  return { kind: 'upstream_skipped', origin: unsettled.id };
}

/** Evaluate trigger rule for a node given its upstream states. */
export function checkTriggerRule(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>
): TriggerRuleDecision {
  const nodeDeps = node.depends_on ?? [];
  return checkTriggerRuleForDependencies(nodeDeps, node.trigger_rule ?? 'all_success', nodeOutputs);
}

export function checkTriggerRuleForDependencies(
  nodeDeps: readonly string[],
  rule: TriggerRule,
  nodeOutputs: Map<string, NodeOutput>
): TriggerRuleDecision {
  if (nodeDeps.length === 0) return { decision: 'run' };

  const upstreams = nodeDeps.map(id => ({
    id,
    output: nodeOutputs.get(id) ?? {
      state: 'failed',
      output: '',
      error: `upstream '${id}' missing from outputs`,
    },
  }));
  let blocking: TriggerRuleUpstream[];
  switch (rule) {
    case 'all_success':
      blocking = upstreams.filter(upstream => upstream.output.state !== 'completed');
      break;
    case 'one_success':
      blocking = upstreams.some(upstream => upstream.output.state === 'completed') ? [] : upstreams;
      break;
    case 'none_failed_min_one_success': {
      const failed = upstreams.filter(
        upstream =>
          upstream.output.state === 'failed' ||
          (upstream.output.state === 'skipped' && upstream.output.cause.kind === 'upstream_failed')
      );
      const anySucceeded = upstreams.some(upstream => upstream.output.state === 'completed');
      blocking = failed.length > 0 ? failed : anySucceeded ? [] : upstreams;
      break;
    }
    case 'all_done':
      blocking = upstreams.filter(
        upstream => upstream.output.state === 'pending' || upstream.output.state === 'running'
      );
      break;
  }

  return blocking.length === 0
    ? { decision: 'run' }
    : { decision: 'skip', cause: triggerSkipCause(blocking) };
}

export function checkComposedBlockBoundaries(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>,
  inputs?: Record<string, JsonValue>,
  options: {
    loopBodyScopes?: readonly LoopBodyScope[];
  } = {}
): TriggerRuleDecision {
  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    const triggerRules = boundary.isEntry
      ? [boundary.entryTriggerRule]
      : boundary.entryTriggerRules;
    const triggerDecisions = triggerRules.map(rule =>
      checkTriggerRuleForDependencies(boundary.dependsOn, rule, nodeOutputs)
    );
    if (!triggerDecisions.some(decision => decision.decision === 'run')) {
      const blocked = triggerDecisions[0];
      if (blocked.decision === 'skip') {
        return { ...blocked, cause: { ...blocked.cause, boundary: boundary.boundary } };
      }
    }

    const conditionDecision = checkBoundaryCondition(
      boundary,
      nodeOutputs,
      inputs,
      options.loopBodyScopes
    );
    if (conditionDecision.decision === 'skip') return conditionDecision;
  }
  return { decision: 'run' };
}

function checkBoundaryCondition(
  boundary: ComposedBlockBoundary,
  nodeOutputs: Map<string, NodeOutput>,
  inputs: Record<string, JsonValue> | undefined,
  loopBodyScopes: readonly LoopBodyScope[] | undefined
): TriggerRuleDecision {
  if (boundary.when === undefined) return { decision: 'run' };
  try {
    const depth = boundary.loopDepth ?? 0;
    const scopeIndex = (loopBodyScopes?.length ?? 0) - 1 - depth;
    const loopPrevOutputs = loopBodyScopes?.[scopeIndex]?.loopPrevOutputs;
    const condition = evaluateCondition(boundary.when, nodeOutputs, inputs, {
      loopPrevOutputs,
    });
    if (!condition.parsed) {
      return {
        decision: 'skip',
        cause: { kind: 'condition_parse_error', expr: boundary.when, boundary: boundary.boundary },
      };
    }
    if (!condition.result) {
      return {
        decision: 'skip',
        cause: { kind: 'condition', expr: boundary.when, boundary: boundary.boundary },
      };
    }
  } catch (error) {
    if (boundary.isEntry) {
      throw new Error(
        `Include '${formatIncludeBoundaryId(boundary.boundary.includeId)}' (workflow '${boundary.boundary.workflow}'): cannot evaluate when: "${boundary.when}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    return {
      decision: 'skip',
      cause: { kind: 'condition_parse_error', expr: boundary.when, boundary: boundary.boundary },
      error,
    };
  }
  return { decision: 'run' };
}

export function skipReasonForCause(cause: SkipCause): NodeSkipReason {
  switch (cause.kind) {
    case 'condition':
      return 'when_condition';
    case 'condition_parse_error':
      return 'when_condition_parse_error';
    case 'timeout':
      return 'timeout';
    case 'upstream_failed':
    case 'upstream_skipped':
      return 'trigger_rule';
  }
}
