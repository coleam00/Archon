import type { SkipCause, NodeOutput, DagNode, TriggerRule } from '../schemas';
import type { JsonValue } from '../output-ref';
import { readComposedMeta } from '../compiled-command';
import { evaluateCondition } from '../condition-evaluator';

export type TriggerRuleDecision = { decision: 'run' } | { decision: 'skip'; cause: SkipCause };

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

/**
 * Enforce caller-level include predicates that load-time flattening attached to every
 * descendant. Entry nodes normally keep using their ordinary trigger/when fields so they
 * retain the existing diagnostics. A cached entry is the exception: resume would otherwise
 * return its prior output before those fields run, so its boundary must be checked here too.
 */
export function checkComposedBlockBoundaries(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>,
  inputs?: Record<string, JsonValue>,
  options: {
    evaluateEntryBoundary?: boolean;
    loopPrevOutputs?: ReadonlyMap<string, NodeOutput>;
  } = {}
): TriggerRuleDecision {
  const { evaluateEntryBoundary = false } = options;
  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    if (boundary.isEntry && !evaluateEntryBoundary) continue;

    const triggerRules =
      boundary.isEntry && evaluateEntryBoundary
        ? [boundary.entryTriggerRule]
        : boundary.entryTriggerRules;
    const triggerDecisions = triggerRules.map(rule =>
      checkTriggerRuleForDependencies(boundary.dependsOn, rule, nodeOutputs)
    );
    if (!triggerDecisions.some(decision => decision.decision === 'run')) {
      return triggerDecisions[0];
    }

    if (boundary.when !== undefined) {
      try {
        const condition = evaluateCondition(boundary.when, nodeOutputs, inputs, options);
        if (!condition.parsed) {
          return {
            decision: 'skip',
            cause: { kind: 'condition_parse_error', expr: boundary.when },
          };
        }
        if (!condition.result) {
          return { decision: 'skip', cause: { kind: 'condition', expr: boundary.when } };
        }
      } catch (error) {
        if (boundary.isEntry && evaluateEntryBoundary) throw error;
        // Entry nodes own the actionable missing-ref error. Descendants only need to stay
        // inside the failed boundary, without repeating the same failure for every node.
        return {
          decision: 'skip',
          cause: { kind: 'condition_parse_error', expr: boundary.when },
        };
      }
    }
  }
  return { decision: 'run' };
}
