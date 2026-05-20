import { describe, it, expect } from 'bun:test';
import { computeRollingDrift } from '../rolling-drift';
// helpers used for other test files; this file creates trades inline
import type { Trade, TradeId, Timestamp } from '../types';

function makeTrades(pnls: number[], baseTime = 1000): Trade[] {
  return pnls.map((pnl, i) => ({
    id: `t-${i}` as TradeId,
    symbol: 'BTC/USD',
    side: 'long' as const,
    entryPrice: 100,
    exitPrice: 100 + pnl,
    entryTime: (baseTime + i * 60_000) as Timestamp,
    exitTime: (baseTime + i * 60_000 + 3600_000) as Timestamp,
    quantity: 1,
    pnl,
  }));
}

describe('computeRollingDrift', () => {
  it('returns null when window not full', () => {
    const expected = makeTrades([10, 20, 30]);
    const actual = makeTrades([10, 20, 30]);
    const result = computeRollingDrift(expected, actual, 5);
    expect(result).toBeNull();
  });

  it('returns null when actual has fewer trades than window', () => {
    const expected = makeTrades([10, 20, 30, 40, 50]);
    const actual = makeTrades([10, 20, 30]);
    const result = computeRollingDrift(expected, actual, 5);
    expect(result).toBeNull();
  });

  it('returns zero drift for identical trades', () => {
    const trades = makeTrades([10, -5, 20, -10, 15, 8, -3, 12, 7, -2]);
    const result = computeRollingDrift(trades, trades, 10);
    expect(result).not.toBeNull();
    expect(result!.sharpeDrift).toBe(0);
    expect(result!.drawdownDrift).toBe(0);
    expect(result!.winrateDrift).toBe(0);
  });

  it('detects Sharpe drift', () => {
    const expected = makeTrades([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    const actual = makeTrades([10, -20, 30, -15, 10, -25, 40, -10, 5, -30]);
    const result = computeRollingDrift(expected, actual, 10);
    expect(result).not.toBeNull();
    expect(result!.sharpeDrift).toBeGreaterThan(0);
  });

  it('detects drawdown drift', () => {
    const expected = makeTrades([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    const actual = makeTrades([10, 10, -50, -50, 10, 10, 10, 10, 10, 10]);
    const result = computeRollingDrift(expected, actual, 10);
    expect(result).not.toBeNull();
    expect(result!.drawdownDrift).toBeGreaterThan(0);
  });

  it('detects winrate drift', () => {
    const expected = makeTrades([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]); // 100% win
    const actual = makeTrades([10, -5, 10, -5, 10, -5, 10, -5, 10, -5]); // 50% win
    const result = computeRollingDrift(expected, actual, 10);
    expect(result).not.toBeNull();
    expect(result!.winrateDrift).toBeCloseTo(0.5, 2);
  });

  it('uses most recent N trades (not first N)', () => {
    // 15 trades, window=10 → should use last 10
    const expected = makeTrades([1, 2, 3, 4, 5, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    const actual = makeTrades([1, 2, 3, 4, 5, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    const result = computeRollingDrift(expected, actual, 10);
    expect(result).not.toBeNull();
    expect(result!.windowSize).toBe(10);
  });

  it('reports correct window size', () => {
    const trades = makeTrades([1, 2, 3, 4, 5]);
    const result = computeRollingDrift(trades, trades, 5);
    expect(result).not.toBeNull();
    expect(result!.windowSize).toBe(5);
  });
});
