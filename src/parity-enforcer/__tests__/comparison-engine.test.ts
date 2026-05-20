import { describe, it, expect } from 'bun:test';
import { compareTrade, compareTrades } from '../comparison-engine';
import { createTrade } from './helpers';

describe('compareTrade', () => {
  it('returns zero deviations for identical trades', () => {
    const trade = createTrade({ entryPrice: 100, exitPrice: 110, pnl: 10, quantity: 1 });
    const result = compareTrade(trade, trade);

    expect(result.entryDeviation).toBe(0);
    expect(result.entryDeviationPct).toBe(0);
    expect(result.exitDeviation).toBe(0);
    expect(result.exitDeviationPct).toBe(0);
    expect(result.pnlDiff).toBe(0);
    expect(result.pnlDiffPct).toBe(0);
  });

  it('computes correct entry deviation', () => {
    const expected = createTrade({ entryPrice: 100, exitPrice: 110, pnl: 10, quantity: 1 });
    const actual = createTrade({ entryPrice: 100.5, exitPrice: 110, pnl: 9.5, quantity: 1 });
    const result = compareTrade(expected, actual);

    expect(result.entryDeviation).toBeCloseTo(0.5, 5);
    expect(result.entryDeviationPct).toBeCloseTo(0.005, 5);
  });

  it('computes correct PnL deviation', () => {
    const expected = createTrade({ pnl: 1000 });
    const actual = createTrade({ pnl: 900 });
    const result = compareTrade(expected, actual);

    expect(result.pnlDiff).toBe(-100);
    expect(result.pnlDiffPct).toBeCloseTo(-0.1, 5);
  });

  it('handles expected PnL = 0 with actual != 0', () => {
    const expected = createTrade({ pnl: 0 });
    const actual = createTrade({ pnl: 50 });
    const result = compareTrade(expected, actual);

    expect(result.pnlDiffPct).toBe(Infinity);
  });

  it('handles expected PnL = 0 and actual = 0', () => {
    const expected = createTrade({ pnl: 0 });
    const actual = createTrade({ pnl: 0 });
    const result = compareTrade(expected, actual);

    expect(result.pnlDiffPct).toBe(0);
  });

  it('computes slippage diff', () => {
    const expected = createTrade({ entryPrice: 100, exitPrice: 105, quantity: 2 });
    const actual = createTrade({ entryPrice: 100, exitPrice: 106, quantity: 2 });
    const result = compareTrade(expected, actual);

    // Expected slippage: |105-100|*2 = 10, Actual slippage: |106-100|*2 = 12
    expect(result.slippageDiff).toBeCloseTo(2, 5);
  });

  it('handles negative PnL trades', () => {
    const expected = createTrade({ pnl: -500 });
    const actual = createTrade({ pnl: -700 });
    const result = compareTrade(expected, actual);

    expect(result.pnlDiff).toBe(-200);
    expect(result.pnlDiffPct).toBeCloseTo(-0.4, 5);
  });

  it('returns empty flags array', () => {
    const trade = createTrade();
    const result = compareTrade(trade, trade);
    expect(result.flags).toEqual([]);
  });
});

describe('compareTrades', () => {
  it('handles batch comparison', () => {
    const pairs = [
      { expected: createTrade({ pnl: 100 }), actual: createTrade({ pnl: 90 }) },
      { expected: createTrade({ pnl: 200 }), actual: createTrade({ pnl: 180 }) },
    ];

    const results = compareTrades(pairs);
    expect(results).toHaveLength(2);
    expect(results[0].pnlDiff).toBe(-10);
    expect(results[1].pnlDiff).toBe(-20);
  });
});
