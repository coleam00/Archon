import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { scoreStrategy, isDisabled, selectStrategy } from './selector';
import type { PerformanceMetrics, StrategyPerformance } from './types';

describe('scoreStrategy', () => {
  test('calculates score as expectedReturn * confidence * stability', () => {
    const metrics: PerformanceMetrics = {
      avg_return: 100,
      winrate: 0.7,
      sharpe: 1.5,
      trades_count: 10,
    };
    const score = scoreStrategy(metrics, 10);
    expect(score).toBeCloseTo(100 * 1.0 * 0.7);
  });

  test('confidence capped at 1.0', () => {
    const metrics: PerformanceMetrics = {
      avg_return: 100,
      winrate: 0.7,
      sharpe: 1.5,
      trades_count: 20,
    };
    const score = scoreStrategy(metrics, 10);
    expect(score).toBeCloseTo(100 * 1.0 * 0.7);
  });

  test('low trade count reduces confidence', () => {
    const metrics: PerformanceMetrics = {
      avg_return: 100,
      winrate: 0.7,
      sharpe: 1.5,
      trades_count: 5,
    };
    const score = scoreStrategy(metrics, 10);
    expect(score).toBeCloseTo(100 * 0.5 * 0.7);
  });

  test('negative return produces negative score', () => {
    const metrics: PerformanceMetrics = {
      avg_return: -50,
      winrate: 0.3,
      sharpe: -1,
      trades_count: 10,
    };
    const score = scoreStrategy(metrics, 10);
    expect(score).toBeLessThan(0);
  });
});

describe('isDisabled', () => {
  test('disables negative avg_return', () => {
    const metrics: PerformanceMetrics = {
      avg_return: -10,
      winrate: 0.6,
      sharpe: 0,
      trades_count: 10,
    };
    expect(isDisabled(metrics, 0.4)).toBe(true);
  });

  test('disables low winrate', () => {
    const metrics: PerformanceMetrics = {
      avg_return: 100,
      winrate: 0.3,
      sharpe: 1,
      trades_count: 10,
    };
    expect(isDisabled(metrics, 0.4)).toBe(true);
  });

  test('does not disable good strategy', () => {
    const metrics: PerformanceMetrics = {
      avg_return: 100,
      winrate: 0.6,
      sharpe: 1.5,
      trades_count: 10,
    };
    expect(isDisabled(metrics, 0.4)).toBe(false);
  });

  test('disables exactly at threshold winrate', () => {
    const metrics: PerformanceMetrics = {
      avg_return: 100,
      winrate: 0.39,
      sharpe: 1,
      trades_count: 10,
    };
    expect(isDisabled(metrics, 0.4)).toBe(true);
  });
});

describe('selectStrategy', () => {
  const config = { explorationRate: 0.2, minTradesForConfidence: 10, minWinRate: 0.4 };

  const goodPerformance: StrategyPerformance = {
    momentum: { trending: { avg_return: 200, winrate: 0.7, sharpe: 2.0, trades_count: 20 } },
    'mean-revert': { trending: { avg_return: 100, winrate: 0.6, sharpe: 1.5, trades_count: 15 } },
    breakout: { trending: { avg_return: 50, winrate: 0.5, sharpe: 1.0, trades_count: 12 } },
  };

  let origRandom: () => number;

  beforeEach(() => {
    origRandom = Math.random;
  });

  afterEach(() => {
    Math.random = origRandom;
  });

  test('exploitation selects top strategy', () => {
    Math.random = () => 0.9; // > 0.2, so exploit
    const rec = selectStrategy(goodPerformance, 'trending', config);
    expect(rec.selected_strategy).toBe('momentum');
    expect(rec.confidence).toBeGreaterThan(0);
    expect(rec.alternatives).toHaveLength(2);
  });

  test('exploration selects non-top strategy', () => {
    Math.random = () => 0.1; // < 0.2, so explore
    const rec = selectStrategy(goodPerformance, 'trending', config);
    expect(rec.selected_strategy).not.toBe('momentum');
    expect(rec.selected_strategy).not.toBeNull();
  });

  test('all disabled returns null strategy', () => {
    const perf: StrategyPerformance = {
      bad1: { trending: { avg_return: -10, winrate: 0.3, sharpe: -1, trades_count: 10 } },
      bad2: { trending: { avg_return: -20, winrate: 0.2, sharpe: -2, trades_count: 10 } },
    };
    const rec = selectStrategy(perf, 'trending', config);
    expect(rec.selected_strategy).toBeNull();
    expect(rec.confidence).toBe(0);
    expect(rec.alternatives).toHaveLength(0);
  });

  test('alternatives sorted by score descending', () => {
    Math.random = () => 0.9; // exploit
    const rec = selectStrategy(goodPerformance, 'trending', config);
    for (let i = 0; i < rec.alternatives.length - 1; i++) {
      expect(rec.alternatives[i].score).toBeGreaterThanOrEqual(rec.alternatives[i + 1].score);
    }
  });

  test('single available strategy selected with correct confidence', () => {
    const perf: StrategyPerformance = {
      only: { trending: { avg_return: 150, winrate: 0.8, sharpe: 1.5, trades_count: 5 } },
    };
    Math.random = () => 0.1; // explore, but only one option
    const rec = selectStrategy(perf, 'trending', config);
    expect(rec.selected_strategy).toBe('only');
    expect(rec.alternatives).toHaveLength(0);
    // confidence = min((5/10) * 0.8, 1.0) = 0.4
    expect(rec.confidence).toBeCloseTo(0.4);
  });

  test('no data for regime returns null', () => {
    const rec = selectStrategy(goodPerformance, 'calm', config);
    expect(rec.selected_strategy).toBeNull();
  });
});
