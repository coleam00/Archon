import { mergeTokenUsage, type TokenUsage } from '@archon/provider-contract';
import { getLog } from './log';

/**
 * Add provider usage, keeping each cache axis that was actually reported and marking the
 * result a floor when some contribution stayed silent (see `mergeTokenUsage`).
 * Required non-finite counters invalidate only that contribution; malformed optional
 * counters are treated as unknown while valid gross input/output remain usable.
 */
export function sumTokenUsage(
  usages: readonly TokenUsage[],
  context: Record<string, unknown> = {}
): TokenUsage | undefined {
  const valid: TokenUsage[] = [];
  for (const usage of usages) {
    if (!Number.isFinite(usage.input) || !Number.isFinite(usage.output)) {
      getLog().warn({ ...context, tokens: usage }, 'dag.usage_tokens_non_finite_ignored');
      continue;
    }
    // Spread rather than rebuild field-by-field: a rebuilt literal silently drops any
    // axis this function does not know about, which is how `cachePartial` was lost on
    // re-aggregation (a partial total became complete on the next merge).
    const normalized: TokenUsage = { ...usage };
    for (const axis of ['cacheRead', 'cacheWrite'] as const) {
      const value = usage[axis];
      if (value === undefined) continue;
      if (!Number.isFinite(value)) {
        // Cleared rather than deleted (no-dynamic-delete): every reader treats an
        // undefined axis as unreported, and JSON.stringify omits the key entirely.
        normalized[axis] = undefined;
        getLog().warn({ ...context, axis, value }, 'dag.usage_optional_tokens_non_finite_ignored');
      }
    }
    valid.push(normalized);
  }
  // The merge rule itself lives with TokenUsage so every aggregation site shares one
  // owner; this function keeps the validation and warn events, which differ per caller.
  return mergeTokenUsage(valid);
}

/**
 * Σ of defined child `costUsd`. Returns undefined when NO child reported cost so the
 * node's own `costUsd` stays absent (a misleading `0` would look like a free run) —
 * matching the run-level aggregation's "only write when > 0" posture.
 *
 * This is Σ of every child, not only the completed ones: a child persists its usage at
 * its run tail whatever its outcome (#2469), so a failed or cancelled child still
 * contributes what it burned. That matters most here — `all_done` is the default join,
 * which makes a partly-failed fan-out the ordinary case rather than the exceptional one.
 */
export function sumFanOutCost(outcomes: readonly { costUsd?: number }[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const o of outcomes) {
    if (o.costUsd !== undefined && Number.isFinite(o.costUsd)) {
      sum += o.costUsd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/**
 * Σ of defined child token usage; unavailable if any child explicitly cannot count
 * its tokens, or if no child reported tokens. Like
 * {@link sumFanOutCost}, this covers every child regardless of outcome.
 */
export function sumFanOutTokens(
  outcomes: readonly { tokens?: TokenUsage; tokensUnknown?: boolean }[]
): TokenUsage | undefined {
  if (outcomes.some(outcome => outcome.tokensUnknown)) return undefined;
  return sumTokenUsage(
    outcomes.flatMap(outcome => (outcome.tokens !== undefined ? [outcome.tokens] : [])),
    { scope: 'fan_out' }
  );
}
