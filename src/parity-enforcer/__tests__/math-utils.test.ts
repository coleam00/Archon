import { describe, it, expect } from 'bun:test';
import {
  mean,
  standardDeviation,
  sharpeRatio,
  maxDrawdown,
  winRate,
  tradeFrequency,
} from '../math-utils';

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('returns the value for single element', () => {
    expect(mean([5])).toBe(5);
  });

  it('computes mean of known values', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it('handles negative values', () => {
    expect(mean([-10, 10])).toBe(0);
  });
});

describe('standardDeviation', () => {
  it('returns 0 for empty array', () => {
    expect(standardDeviation([])).toBe(0);
  });

  it('returns 0 for single value', () => {
    expect(standardDeviation([42])).toBe(0);
  });

  it('computes correct stddev for known set', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, sample stddev≈2.138
    const result = standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).toBeCloseTo(2.138, 2);
  });

  it('returns 0 for identical values', () => {
    expect(standardDeviation([3, 3, 3, 3])).toBe(0);
  });
});

describe('sharpeRatio', () => {
  it('returns 0 for empty array', () => {
    expect(sharpeRatio([])).toBe(0);
  });

  it('returns 0 when stddev is 0', () => {
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBe(0);
  });

  it('computes positive Sharpe for positive returns', () => {
    const returns = [0.01, 0.02, 0.015, 0.012, 0.018];
    const result = sharpeRatio(returns);
    expect(result).toBeGreaterThan(0);
  });

  it('computes negative Sharpe for negative returns', () => {
    const returns = [-0.01, -0.02, -0.015, -0.012, -0.018];
    const result = sharpeRatio(returns);
    expect(result).toBeLessThan(0);
  });

  it('accounts for risk-free rate', () => {
    const returns = [0.01, 0.02, 0.015, 0.012, 0.018];
    const withRf = sharpeRatio(returns, 0.01);
    const withoutRf = sharpeRatio(returns, 0);
    expect(withRf).toBeLessThan(withoutRf);
  });
});

describe('maxDrawdown', () => {
  it('returns 0 for empty array', () => {
    expect(maxDrawdown([])).toBe(0);
  });

  it('returns 0 for monotonically increasing curve', () => {
    expect(maxDrawdown([1, 2, 3, 4, 5])).toBe(0);
  });

  it('computes known drawdown', () => {
    // Peak at 100, trough at 60 → DD = 40%
    const curve = [80, 100, 90, 60, 70, 80];
    expect(maxDrawdown(curve)).toBeCloseTo(0.4, 5);
  });

  it('handles all losses', () => {
    const curve = [100, 80, 60, 40, 20];
    expect(maxDrawdown(curve)).toBeCloseTo(0.8, 5);
  });
});

describe('winRate', () => {
  it('returns 0 for empty array', () => {
    expect(winRate([])).toBe(0);
  });

  it('returns 1 for all wins', () => {
    expect(winRate([10, 20, 30])).toBe(1);
  });

  it('returns 0 for all losses', () => {
    expect(winRate([-10, -20, -30])).toBe(0);
  });

  it('computes correct mixed rate', () => {
    expect(winRate([10, -5, 20, -10])).toBe(0.5);
  });

  it('does not count zero as a win', () => {
    expect(winRate([0, 0, 10])).toBeCloseTo(1 / 3, 5);
  });
});

describe('tradeFrequency', () => {
  it('returns 0 for fewer than 2 timestamps', () => {
    expect(tradeFrequency([], 1000)).toBe(0);
    expect(tradeFrequency([100], 1000)).toBe(0);
  });

  it('computes frequency for regular intervals', () => {
    // 5 trades over 4000ms span, window = 4000ms → 5 trades per window
    const timestamps = [1000, 2000, 3000, 4000, 5000];
    const result = tradeFrequency(timestamps, 4000);
    expect(result).toBe(5);
  });

  it('returns 0 for zero window', () => {
    expect(tradeFrequency([1000, 2000], 0)).toBe(0);
  });
});
