import { describe, expect, it } from 'bun:test';
import { tokenUsageSchema } from '@archon/provider-contract';
import type { RunUsageFigures } from '../dag/usage';
import { parseRunUsage, serializeRunUsage } from './run-usage';

describe('persisted run usage', () => {
  it('round-trips every persisted measurement without changing its wire key', () => {
    const usage: RunUsageFigures = {
      costUsd: 0.25,
      tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cachePartial: true },
    };
    const metadata = serializeRunUsage(usage);
    expect(metadata).toEqual({
      total_cost_usd: 0.25,
      total_tokens_in: 100,
      total_tokens_out: 20,
      total_cache_read_tokens: 50,
      total_cache_write_tokens: 0,
      total_cache_partial: true,
    });
    expect(parseRunUsage(metadata)).toEqual(usage);
  });

  it('clears stale counters when the total becomes unknown', () => {
    const metadata = {
      ...serializeRunUsage({ costUsd: 0, tokens: { input: 1, output: 2, cacheRead: 1 } }),
      ...serializeRunUsage({ costUsd: 0.5, tokensUnknown: true }),
    };
    expect(metadata).toEqual({
      total_cost_usd: 0.5,
      total_tokens_unknown: true,
      total_tokens_in: null,
      total_tokens_out: null,
      total_cache_read_tokens: null,
      total_cache_write_tokens: null,
      total_cache_partial: null,
    });
    expect(parseRunUsage(metadata)).toEqual({ costUsd: 0.5, tokensUnknown: true });
  });

  it('preserves absent usage and reported zero', () => {
    expect(serializeRunUsage({})).toEqual({});
    expect(parseRunUsage({})).toEqual({ costUsd: undefined, tokens: undefined });
    const zero = { costUsd: 0, tokens: { input: 0, output: 0 } };
    expect(parseRunUsage(serializeRunUsage(zero))).toEqual(zero);
  });

  it.each(
    [undefined, null, '0', false, {}, [], -1, Number.NaN, Infinity, -Infinity].map(cost => ({
      cost,
    }))
  )('leaves missing or unusable cost $cost unreported without losing tokens', ({ cost }) => {
    const metadata = {
      total_cost_usd: cost,
      ...serializeRunUsage({ tokens: { input: 2, output: 3 } }),
    };
    const expected = { costUsd: undefined, tokens: { input: 2, output: 3 } };
    expect(parseRunUsage(metadata)).toEqual(expected);
    expect(parseRunUsage(metadata, { partialTokens: true })).toEqual(expected);
  });

  it.each([0, -0, 0.00000001, 0.1 + 0.2, 1e21, Number.MAX_VALUE])(
    'preserves usable cost %p',
    costUsd => {
      const metadata = serializeRunUsage({ costUsd });
      expect(parseRunUsage(metadata).costUsd).toBe(costUsd);
      expect(parseRunUsage(metadata, { partialTokens: true }).costUsd).toBe(costUsd);
    }
  );

  it.each([
    { metadata: { total_tokens_in: 2, total_tokens_out: [] }, tokens: { input: 2 } },
    {
      metadata: { total_tokens_in: 'bad', total_tokens_out: 3, total_tokens_unknown: false },
      tokens: { output: 3 },
    },
    { metadata: { total_tokens_in: 2 }, tokens: { input: 2 } },
    { metadata: { total_tokens_out: 3 }, tokens: { output: 3 } },
  ])(
    'keeps a recorded axis for presentation while totals stay unknown: $metadata',
    ({ metadata, tokens }) => {
      expect(parseRunUsage(metadata)).toEqual({ costUsd: undefined, tokensUnknown: true });
      expect(parseRunUsage(metadata, { partialTokens: true })).toEqual({
        costUsd: undefined,
        tokens,
      });
    }
  );

  it.each([true, 'false', null])('hides partial counters under unknown marker %p', marker => {
    const metadata = { total_tokens_in: 2, total_tokens_unknown: marker };
    expect(parseRunUsage(metadata, { partialTokens: true })).toEqual({
      costUsd: undefined,
      tokensUnknown: true,
    });
  });
});

it('persists aggregate axes without duplicating request evidence or provider-only totals', () => {
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cachePartial: true as const,
    total: 99,
    cost: 5,
    calls: [{ input: 0, output: 0 }],
    callsPartial: true as const,
  };
  const owner = tokenUsageSchema.omit({ total: true, cost: true, calls: true, callsPartial: true });
  const metadata = serializeRunUsage({ tokens });
  expect(Object.keys(metadata)).toHaveLength(owner.keyof().options.length);
  expect(parseRunUsage(metadata).tokens).toEqual(owner.parse(tokens));
  const cleared = serializeRunUsage({ tokensUnknown: true });
  expect(
    Object.keys(cleared)
      .filter(key => key !== 'total_tokens_unknown')
      .sort()
  ).toEqual(Object.keys(metadata).sort());
});
