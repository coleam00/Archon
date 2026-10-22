import { childUsageSchema } from '../schemas/node-execution';
import { tokenUsageSchema, type TokenUsage } from '@archon/provider-contract';
import type { DagResumeSnapshot } from '../store';
import type { RunUsageFigures } from './usage';

const tokenAxes = tokenUsageSchema
  .omit({ cachePartial: true, total: true, cost: true })
  .keyof().options;

export function reportedChildUsage(usage: RunUsageFigures & { childRunId: string }) {
  return childUsageSchema.parse(usage);
}

/** Child totals are cumulative; parent events must carry only spend not already reported. */
export function unreportedChildUsage(
  total: RunUsageFigures,
  reportedByChild: DagResumeSnapshot['reportedChildUsage'],
  childRunId: string
): RunUsageFigures {
  const reported = reportedByChild?.get(childRunId);
  if (reported === undefined) return total;
  const tokensUnknown = total.tokensUnknown === true || reported.tokensUnknown === true;
  let tokens: TokenUsage | undefined;
  if (!tokensUnknown && total.tokens !== undefined) {
    tokens = { ...total.tokens };
    for (const axis of tokenAxes) {
      const value = total.tokens[axis];
      if (value !== undefined) tokens[axis] = Math.max(0, value - (reported.tokens?.[axis] ?? 0));
    }
  }
  return {
    costUsd:
      total.costUsd === undefined
        ? undefined
        : Math.max(0, total.costUsd - (reported.costUsd ?? 0)),
    tokens,
    tokensUnknown,
  };
}
