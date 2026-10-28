import type { RunUsageFigures } from '../schemas/run-usage';
import { mergeTokenUsage, tokenUsageSchema, type TokenUsage } from '@archon/provider-contract';
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
 * Sum finite reported costs, preserving absence when no contribution reported cost.
 *
 * Fan-out callers include every child, not only completed ones: a child persists its usage at
 * its run tail whatever its outcome (#2469), so a failed or cancelled child still
 * contributes what it burned. That matters most here — `all_done` is the default join,
 * which makes a partly-failed fan-out the ordinary case rather than the exceptional one.
 */
export function sumReportedCost(outcomes: readonly { costUsd?: number }[]): number | undefined {
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
 * {@link sumReportedCost}, this covers every child regardless of outcome.
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

export type { RunUsageFigures } from '../schemas/run-usage';

// Float sums taken in a different order differ in the last bits.
const COST_TOLERANCE_USD = 1e-9;

const RECONCILED_TOKEN_AXES = tokenUsageSchema
  .omit({
    cachePartial: true, // Aggregation floor marker, not a counter.
    total: true, // Provider-defined total; not aggregated across nodes.
    cost: true, // Provider-defined cost; run cost is reconciled separately.
  })
  .keyof().options;

/**
 * The axes on which two figures for the same run disagree; empty when they agree. The
 * usage reconciliation tests and the debug-level check in `persistRunUsage` both judge
 * with it, so a blind comparison would blind both.
 *
 * Absent cost equals `0`, because the fold reports `0` when no row carried cost. Tokens
 * compare per reconciled schema axis.
 */
export function runUsageMismatch(a: RunUsageFigures, b: RunUsageFigures): ('cost' | 'tokens')[] {
  const mismatched: ('cost' | 'tokens')[] = [];
  if (Math.abs((a.costUsd ?? 0) - (b.costUsd ?? 0)) > COST_TOLERANCE_USD) mismatched.push('cost');
  if (!tokensAgree(a, b)) mismatched.push('tokens');
  return mismatched;
}

function tokensAgree(a: RunUsageFigures, b: RunUsageFigures): boolean {
  const aUnknown = a.tokensUnknown === true;
  if (aUnknown || b.tokensUnknown === true) return aUnknown === (b.tokensUnknown === true);
  return RECONCILED_TOKEN_AXES.every(axis => a.tokens?.[axis] === b.tokens?.[axis]);
}
