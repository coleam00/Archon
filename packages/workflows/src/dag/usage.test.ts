import { describe, it, expect } from 'bun:test';
import { tokenUsageSchema } from '@archon/provider-contract';
import { runUsageMismatch, incrementalCallUsage } from './usage';

// Each case is the shape of a historical aggregation defect, or a difference the
// comparison must not report, so a comparison that passes on anything fails here.
describe('runUsageMismatch', () => {
  it('reports doubled loop_group tokens', () => {
    expect(
      runUsageMismatch(
        { costUsd: 0.3, tokens: { input: 300, output: 30 } },
        { costUsd: 0.3, tokens: { input: 600, output: 60 } }
      )
    ).toEqual(['tokens']);
  });

  it('reports a resumed run that overwrote its prior usage', () => {
    expect(
      runUsageMismatch(
        { costUsd: 0.03, tokens: { input: 60, output: 6 } },
        { costUsd: 0.05, tokens: { input: 100, output: 10 } }
      )
    ).toEqual(['cost', 'tokens']);
  });

  it('reports session-cumulative cost summed as if it were per query', () => {
    const tokens = { input: 10, output: 1 };
    expect(runUsageMismatch({ costUsd: 0.1 + 0.3, tokens }, { costUsd: 0.3, tokens })).toEqual([
      'cost',
    ]);
  });

  it('reports known tokens against unknown, and agrees when both are unknown', () => {
    expect(runUsageMismatch({ tokens: { input: 10, output: 1 } }, { tokensUnknown: true })).toEqual(
      ['tokens']
    );
    expect(runUsageMismatch({ tokensUnknown: true }, { tokensUnknown: true })).toEqual([]);
  });

  it.each(
    tokenUsageSchema
      .keyof()
      .options.filter(
        axis =>
          axis !== 'total' && axis !== 'cost' && tokenUsageSchema.shape[axis].safeParse(0).success
      )
  )('reports a difference in schema counter %s', axis => {
    const a = { tokens: { input: 10, output: 1 } };
    const b = { tokens: { ...a.tokens, [axis]: 0 } };
    expect(runUsageMismatch(a, b)).toEqual(['tokens']);
    expect(runUsageMismatch(b, a)).toEqual(['tokens']);
    expect(runUsageMismatch(b, { tokens: { ...b.tokens, [axis]: 1 } })).toEqual(['tokens']);
    expect(runUsageMismatch(b, { tokens: { ...b.tokens } })).toEqual([]);
    expect(runUsageMismatch({ ...a, tokensUnknown: true }, { ...b, tokensUnknown: true })).toEqual(
      []
    );
  });

  it('ignores the floor marker and provider-defined totals and costs', () => {
    expect(
      runUsageMismatch(
        { tokens: { input: 10, output: 1 } },
        { tokens: { input: 10, output: 1, cachePartial: true, total: 20, cost: 0.5 } }
      )
    ).toEqual([]);
  });

  it('treats absent cost as zero and tolerates float summation order', () => {
    expect(runUsageMismatch({}, { costUsd: 0 })).toEqual([]);
    expect(runUsageMismatch({ costUsd: 0.1 + 0.2 }, { costUsd: 0.3 })).toEqual([]);
  });
});

describe('incremental request evidence', () => {
  const one = { responseId: 'one', input: 100, output: 10 };
  const two = { responseId: 'two', input: 200, output: 20 };
  const total = { input: 300, output: 30, calls: [one, two] };
  it('removes an already reported prefix even after JSON round-trip', () => {
    const prior = tokenUsageSchema.parse(
      JSON.parse(JSON.stringify({ input: 100, output: 10, calls: [one] }))
    );
    expect(incrementalCallUsage(total, prior)).toEqual({ calls: [two] });
    expect(incrementalCallUsage(total, total)).toEqual({ calls: [] });
  });
  it('does not infer a prefix from counters or mismatched response identities', () => {
    for (const prior of [
      { input: 100, output: 10 },
      { input: 100, output: 10, calls: [two] },
    ]) {
      expect(incrementalCallUsage(total, prior)).toEqual({ calls: undefined, callsPartial: true });
    }
  });
  it('retains incomplete evidence through incremental accounting', () => {
    expect(
      incrementalCallUsage(
        { ...total, callsPartial: true },
        {
          input: 100,
          output: 10,
          calls: [one],
        }
      )
    ).toEqual({ calls: [two], callsPartial: true });
  });
});
