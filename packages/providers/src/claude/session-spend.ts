import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Per-query spend for a session whose SDK totals are cumulative.
 *
 * Since Claude Agent SDK 0.3.277 a resumed or forked session's `total_cost_usd`
 * and `modelUsage` continue from the earlier turns instead of starting at zero.
 * Archon reports spend per node, per loop iteration and per chat turn, and the
 * callers add those figures up, so each query must report only what it spent:
 * its result's totals minus the session's totals when the query started.
 *
 * The baseline is the last result this process saw for the session being
 * resumed. A session this process never saw (created by an earlier process, or
 * evicted from the ledger) has no known baseline; its cost is then reported as
 * unknown rather than a cumulative figure that would over-count. Token counts
 * are unaffected: the result's `usage` already covers only the current query.
 */

/** A session's cumulative totals, as its latest result reported them. */
export interface SessionSpend {
  costUsd: number;
  modelUsage: Record<string, ModelUsage>;
}

/** Where a query's spend starts counting. */
export type SpendBaseline =
  /** A new session: the SDK's totals start at zero. */
  | { kind: 'fresh' }
  /** A resume or fork of a session whose totals this process recorded. */
  | { kind: 'known'; spend: SessionSpend }
  /** A resume or fork of a session this process has no totals for. */
  | { kind: 'unknown' };

/** The query's own share of a result's cumulative totals. */
export interface QuerySpend {
  /** Undefined when the baseline is unknown or the totals went backwards. */
  costUsd: number | undefined;
  /** Per-model usage of this query when the baseline is known, else the cumulative record. */
  modelUsage: Record<string, ModelUsage>;
}

/** Latest cumulative totals per session id. Bounded so a long-lived server does not grow it forever. */
export class SessionSpendLedger {
  private readonly latest = new Map<string, SessionSpend>();

  constructor(private readonly capacity = 1000) {}

  baselineFor(resumeSessionId: string | undefined): SpendBaseline {
    if (resumeSessionId === undefined) return { kind: 'fresh' };
    const spend = this.latest.get(resumeSessionId);
    return spend ? { kind: 'known', spend } : { kind: 'unknown' };
  }

  record(sessionId: string, spend: SessionSpend): void {
    // Re-insert so the Map's insertion order tracks recency, then evict the oldest.
    this.latest.delete(sessionId);
    this.latest.set(sessionId, spend);
    if (this.latest.size > this.capacity) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
  }
}

export function spendSince(baseline: SpendBaseline, cumulative: SessionSpend): QuerySpend {
  if (baseline.kind === 'fresh') return cumulative;
  if (baseline.kind === 'unknown') return { costUsd: undefined, modelUsage: cumulative.modelUsage };

  const base = baseline.spend;
  const costUsd = cumulative.costUsd - base.costUsd;
  // Only the output axis is differenced: it is what resolved-model selection reads.
  const modelUsage: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(cumulative.modelUsage)) {
    const outputTokens = usage.outputTokens - (base.modelUsage[model]?.outputTokens ?? 0);
    if (outputTokens > 0) modelUsage[model] = { ...usage, outputTokens };
  }
  return {
    // Totals below the baseline mean the SDK did not continue from it; the share is unknowable.
    costUsd: costUsd >= 0 ? costUsd : undefined,
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : cumulative.modelUsage,
  };
}
