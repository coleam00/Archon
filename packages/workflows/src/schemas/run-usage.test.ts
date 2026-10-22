import { describe, expect, it } from 'bun:test';
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
});
