import { describe, expect, it } from 'bun:test';
import { unrecordedFanOutUsage } from './fan-out-usage';
import type { ChildWorkflowOutcome } from '../../child-run';

const paid: ChildWorkflowOutcome = {
  status: 'completed',
  childRunId: 'paid',
  costUsd: 0.03,
  tokens: { input: 21, output: 9, cacheRead: 15, cacheWrite: 0 },
};

describe('fan-out usage increments', () => {
  it('deducts spend already recorded across pauses, including cache axes', () => {
    expect(
      unrecordedFanOutUsage([paid], {
        costUsd: 0.01,
        tokens: { input: 7, output: 3, cacheRead: 5, cacheWrite: 0 },
      })
    ).toEqual({
      costUsd: expect.closeTo(0.02),
      tokensUnknown: false,
      tokens: { input: 14, output: 6, cacheRead: 10, cacheWrite: 0 },
    });
  });

  it('keeps unreported spend absent', () => {
    expect(unrecordedFanOutUsage([{ status: 'completed', childRunId: 'silent' }], {})).toEqual({
      costUsd: undefined,
      tokens: undefined,
      tokensUnknown: false,
    });
  });

  it.each([true, false])('keeps unknown tokens unavailable (previously unknown=%s)', previous => {
    const unknown: ChildWorkflowOutcome = {
      status: 'failed',
      childRunId: 'unknown',
      tokensUnknown: true,
    };
    const usage = unrecordedFanOutUsage(previous ? [paid] : [paid, unknown], {
      tokensUnknown: previous,
    });
    expect(usage.tokensUnknown).toBe(true);
    expect(usage.tokens).toBeUndefined();
    expect(usage.costUsd).toBe(0.03);
  });
});
