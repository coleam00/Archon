import { describe, expect, test } from 'bun:test';
import { addResultUsage, mergeTokenUsage, type TokenUsage } from './result';

describe('mergeTokenUsage', () => {
  test('returns undefined for no contributions', () => {
    expect(mergeTokenUsage([])).toBeUndefined();
  });

  test('sums every axis and stays complete when all contributions report cache', () => {
    const merged = mergeTokenUsage([
      { input: 100, output: 10, cacheRead: 60, cacheWrite: 5 },
      { input: 200, output: 20, cacheRead: 40, cacheWrite: 0 },
    ]);

    expect(merged).toEqual({ input: 300, output: 30, cacheRead: 100, cacheWrite: 5 });
    expect(merged?.cachePartial).toBeUndefined();
  });

  test('keeps the reported cache as a floor when a contribution stays silent', () => {
    const merged = mergeTokenUsage([
      { input: 1_000_000, output: 100, cacheRead: 950_000, cacheWrite: 20_000 },
      { input: 5_000, output: 50 },
    ]);

    // The silent node narrows the total rather than erasing it: without this, `input`
    // stood at 1,005,000 with no cache context and read as "nothing was cached".
    expect(merged).toEqual({
      input: 1_005_000,
      output: 150,
      cacheRead: 950_000,
      cacheWrite: 20_000,
      cachePartial: true,
    });
  });

  test('leaves an axis absent and unflagged when no contribution reports it', () => {
    const merged = mergeTokenUsage([
      { input: 40, output: 4 },
      { input: 60, output: 6 },
    ]);

    // Absence already encodes "unknown", so there is nothing to qualify.
    expect(merged).toEqual({ input: 100, output: 10 });
  });

  test('decides the two axes independently', () => {
    const merged = mergeTokenUsage([
      { input: 10, output: 1, cacheRead: 5, cacheWrite: 2 },
      { input: 20, output: 2, cacheRead: 7 },
    ]);

    // cacheRead is complete, cacheWrite is a floor — one partial axis flags the aggregate.
    expect(merged).toEqual({
      input: 30,
      output: 3,
      cacheRead: 12,
      cacheWrite: 2,
      cachePartial: true,
    });
  });

  test('propagates a contribution that is already a floor', () => {
    const priorAggregate: TokenUsage = {
      input: 500,
      output: 50,
      cacheRead: 300,
      cachePartial: true,
    };

    const merged = mergeTokenUsage([priorAggregate, { input: 100, output: 10, cacheRead: 40 }]);

    // Every contribution reports cacheRead, so the axis alone would look complete —
    // the flag survives only because it travels with the usage.
    expect(merged).toEqual({
      input: 600,
      output: 60,
      cacheRead: 340,
      cachePartial: true,
    });
  });

  test('does not flag a single complete contribution', () => {
    expect(mergeTokenUsage([{ input: 10, output: 1, cacheRead: 5, cacheWrite: 1 }])).toEqual({
      input: 10,
      output: 1,
      cacheRead: 5,
      cacheWrite: 1,
    });
  });

  test('ignores total and cost rather than half-aggregating them', () => {
    const merged = mergeTokenUsage([
      { input: 10, output: 1, total: 11, cost: 0.5 },
      { input: 20, output: 2, total: 22, cost: 0.25 },
    ]);

    // Callers that need these compose them; folding them in here would change
    // OpenCode's `total` fallback semantics.
    expect(merged).toEqual({ input: 30, output: 3 });
  });
});

describe('addResultUsage', () => {
  test('passes a single result through untouched', () => {
    const tokens = { input: 5, output: 1, total: 6 };
    expect(addResultUsage({}, { cost: 0.1, tokens })).toEqual({ cost: 0.1, tokens });
  });

  test('sums cost and tokens across results', () => {
    const total = addResultUsage(
      addResultUsage({}, { cost: 0.1, tokens: { input: 1, output: 2 } }),
      { cost: 0.2, tokens: { input: 3, output: 4 } }
    );
    expect(total.cost).toBeCloseTo(0.3);
    expect(total.tokens).toEqual({ input: 4, output: 6 });
  });

  test('unknown tokens stay unknown for the rest of the turn, cost keeps summing', () => {
    const unknown = addResultUsage(
      addResultUsage({}, { cost: 0.1, tokens: { input: 1, output: 2 } }),
      { cost: 0.1, tokensUnknown: true }
    );
    const total = addResultUsage(unknown, { cost: 0.1, tokens: { input: 3, output: 4 } });
    expect(total.tokensUnknown).toBe(true);
    expect(total.tokens).toBeUndefined();
    expect(total.cost).toBeCloseTo(0.3);
  });

  test.each([
    { input: Number.NaN, output: 1 },
    { input: 1, output: Number.POSITIVE_INFINITY },
  ])('ignores non-finite token usage: %j', tokens => {
    const prior = { input: 5, output: 2 };
    expect(addResultUsage({}, { tokens })).toEqual({});
    expect(addResultUsage({ tokens: prior }, { tokens })).toEqual({ tokens: prior });
  });

  test('a non-finite cost contributes nothing', () => {
    expect(addResultUsage({ cost: 0.1 }, { cost: Number.NaN })).toEqual({ cost: 0.1 });
  });
});
