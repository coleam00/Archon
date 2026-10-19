import type { TokenUsage } from '@archon/provider-contract';
import type { DagResumeSnapshot } from '../../../store';
import type { ChildWorkflowOutcome } from '../../child-run';
import { sumFanOutTokens, sumReportedCost } from '../../usage';

/** Child rows carry lifetime totals; parent events carry only the unrecorded increment. */
export function unrecordedFanOutUsage(
  outcomes: readonly ChildWorkflowOutcome[],
  recorded: Pick<DagResumeSnapshot, 'costUsd' | 'tokens' | 'tokensUnknown'>
): { costUsd?: number; tokens?: TokenUsage; tokensUnknown?: boolean } {
  const cost = sumReportedCost(outcomes);
  const tokens = sumFanOutTokens(outcomes);
  const previous = recorded.tokens;
  return {
    costUsd: cost === undefined ? undefined : Math.max(0, cost - (recorded.costUsd ?? 0)),
    tokensUnknown: recorded.tokensUnknown || outcomes.some(outcome => outcome.tokensUnknown),
    tokens:
      recorded.tokensUnknown || tokens === undefined
        ? undefined
        : {
            ...tokens,
            input: Math.max(0, tokens.input - (previous?.input ?? 0)),
            output: Math.max(0, tokens.output - (previous?.output ?? 0)),
            ...(tokens.cacheRead === undefined
              ? {}
              : { cacheRead: Math.max(0, tokens.cacheRead - (previous?.cacheRead ?? 0)) }),
            ...(tokens.cacheWrite === undefined
              ? {}
              : { cacheWrite: Math.max(0, tokens.cacheWrite - (previous?.cacheWrite ?? 0)) }),
          },
  };
}
