import type { TokenUsage } from '@archon/provider-contract';
import type { z } from 'zod';
import { fanOutUsageSchema } from '../../../schemas/node-execution';
import { readNodeRecordData, type NodeRecordEventEnvelope } from '../../../node-record-reader';
import type { ChildWorkflowOutcome } from '../../child-run';
import { sumFanOutTokens, sumReportedCost } from '../../usage';

type FanOutUsage = z.infer<typeof fanOutUsageSchema>;

export function childUsageTotals(outcomes: readonly ChildWorkflowOutcome[]): FanOutUsage {
  return Object.fromEntries(
    outcomes.map(({ childRunId, costUsd, tokens, tokensUnknown }) => [
      childRunId,
      { costUsd, tokens, tokensUnknown },
    ])
  );
}

export function recordedFanOutUsage(events: readonly NodeRecordEventEnvelope[]): FanOutUsage {
  const recorded: FanOutUsage = {};
  for (const event of events) {
    const parsed = fanOutUsageSchema.safeParse(readNodeRecordData(event.data).fan_out_usage);
    if (parsed.success) Object.assign(recorded, parsed.data);
  }
  return recorded;
}

/** Child rows carry lifetime totals; parent events carry only the unrecorded increment. */
export function unrecordedFanOutUsage(
  outcomes: readonly ChildWorkflowOutcome[],
  recorded: FanOutUsage
): { costUsd?: number; tokens?: TokenUsage; tokensUnknown?: boolean } {
  const previousOutcomes = outcomes.flatMap(outcome => recorded[outcome.childRunId] ?? []);
  const previousCost = sumReportedCost(previousOutcomes);
  const previouslyUnknown = previousOutcomes.some(outcome => outcome.tokensUnknown);
  const cost = sumReportedCost(outcomes);
  const tokens = sumFanOutTokens(outcomes);
  const previous = sumFanOutTokens(previousOutcomes);
  return {
    costUsd: cost === undefined ? undefined : Math.max(0, cost - (previousCost ?? 0)),
    tokensUnknown: previouslyUnknown || outcomes.some(outcome => outcome.tokensUnknown),
    tokens:
      previouslyUnknown || tokens === undefined
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
