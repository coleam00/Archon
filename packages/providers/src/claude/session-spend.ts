import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { TokenUsage } from '../types';

/**
 * Per-query spend for a session whose SDK totals are cumulative.
 *
 * Since Claude Agent SDK 0.3.277 a resumed or forked session's `total_cost_usd`
 * and `modelUsage` continue from the earlier turns instead of starting at zero.
 * Archon reports spend per node, per loop iteration and per chat turn, and the
 * callers add those figures up, so each query must report only what it spent:
 * its result's totals minus the session's totals when the query started.
 *
 * Resumes and forks use the SDK's persisted cost-state as their baseline.
 * Missing or invalid state leaves cost unknown rather than over-counting earlier
 * turns. Tokens are also unknown when persisted records lack any token axis.
 */

export type ModelTokens = Pick<
  ModelUsage,
  'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
>;

// Older cost-state records may retain only output, which still supports model selection.
export type BaselineModelUsage = Pick<ModelTokens, 'outputTokens'> & Partial<ModelTokens>;

/** A session's cumulative totals, as its latest result reported them. */
export interface SessionSpend {
  costUsd: number | undefined;
  modelUsage: Record<string, ModelUsage>;
}

/** Where a query's spend starts counting. */
export type SpendBaseline =
  /** A new session: the SDK's totals start at zero. */
  | { kind: 'fresh' }
  /** A resume or fork with persisted totals. */
  | {
      kind: 'known';
      spend: { costUsd: number; modelUsage: Record<string, BaselineModelUsage> };
    }
  /** A resume or fork with no persisted totals. */
  | { kind: 'unknown' };

/** The query's own share of a result's cumulative totals. */
export interface QuerySpend {
  /** Undefined when the baseline is unknown or the totals went backwards. */
  costUsd: number | undefined;
  /**
   * Per-model usage of this query when the baseline is known (models with no new output
   * omitted). With an unknown baseline, the cumulative record if it names one model, else empty.
   */
  modelUsage: Record<string, ModelUsage>;
  /** Unknown when the token baseline is missing, incomplete, or totals went backwards. */
  tokens: TokenUsage | undefined;
}

export function spendSince(baseline: SpendBaseline, cumulative: SessionSpend): QuerySpend {
  const tokens = tokensSince(baseline, cumulative.modelUsage);
  if (baseline.kind === 'fresh') return { ...cumulative, tokens };
  if (baseline.kind === 'unknown') {
    // Without a baseline, only a session that has used a single model can name this query's.
    const single = Object.keys(cumulative.modelUsage).length === 1;
    return { costUsd: undefined, modelUsage: single ? cumulative.modelUsage : {}, tokens };
  }

  const base = baseline.spend;
  const costUsd = cumulative.costUsd === undefined ? undefined : cumulative.costUsd - base.costUsd;
  const modelUsage: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(cumulative.modelUsage)) {
    const outputTokens = usage.outputTokens - (base.modelUsage[model]?.outputTokens ?? 0);
    if (outputTokens > 0)
      modelUsage[model] = {
        ...usage,
        ...modelTokenDelta(usage, base.modelUsage[model]),
      };
  }
  return {
    // Totals below the baseline mean the SDK did not continue from it; the share is unknowable.
    costUsd: costUsd !== undefined && costUsd >= 0 ? costUsd : undefined,
    // Empty when no model produced output in this query (a zeroed crash or startup result):
    // no model is named then, rather than one from the session's earlier turns.
    modelUsage,
    tokens,
  };
}

function tokensSince(
  baseline: SpendBaseline,
  cumulative: Record<string, ModelUsage>
): TokenUsage | undefined {
  if (baseline.kind === 'unknown') return undefined;
  const base = baseline.kind === 'known' ? baseline.spend.modelUsage : {};
  if (baseline.kind === 'known' && baseline.spend.costUsd > 0 && Object.keys(base).length === 0)
    return undefined;
  if (Object.keys(base).some(model => cumulative[model] === undefined)) return undefined;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [model, usage] of Object.entries(cumulative)) {
    const previous = base[model];
    const delta = modelTokenDelta(usage, previous);
    if (Object.values(delta).some(value => !Number.isFinite(value) || value < 0)) return undefined;
    tokens.input += delta.inputTokens + delta.cacheReadInputTokens + delta.cacheCreationInputTokens;
    tokens.output += delta.outputTokens;
    tokens.cacheRead += delta.cacheReadInputTokens;
    tokens.cacheWrite += delta.cacheCreationInputTokens;
  }
  return tokens;
}

function modelTokenDelta(usage: ModelUsage, previous: BaselineModelUsage | undefined): ModelTokens {
  return {
    inputTokens: usage.inputTokens - (previous === undefined ? 0 : (previous.inputTokens ?? NaN)),
    outputTokens: usage.outputTokens - (previous?.outputTokens ?? 0),
    cacheReadInputTokens:
      usage.cacheReadInputTokens -
      (previous === undefined ? 0 : (previous.cacheReadInputTokens ?? NaN)),
    cacheCreationInputTokens:
      usage.cacheCreationInputTokens -
      (previous === undefined ? 0 : (previous.cacheCreationInputTokens ?? NaN)),
  };
}
