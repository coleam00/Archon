import { describe, test, expect, afterEach } from 'bun:test';
import { calculateMetrics, aggregatePerformance } from './aggregator';
import { createTradeStore } from './db';
import type { StoredTrade, ITradeStore } from './types';

function makeTrade(overrides: Partial<StoredTrade> = {}): StoredTrade {
  return {
    id: 1,
    strategy: 'momentum',
    regime: 'trending',
    volatility: 0.15,
    pnl: 100,
    success: true,
    timestamp: '2026-01-01T00:00:00',
    ...overrides,
  };
}

describe('calculateMetrics', () => {
  test('returns zeroed metrics for empty array', () => {
    const m = calculateMetrics([]);
    expect(m.avg_return).toBe(0);
    expect(m.winrate).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.trades_count).toBe(0);
  });

  test('calculates correctly for single trade', () => {
    const m = calculateMetrics([makeTrade({ pnl: 200, success: true })]);
    expect(m.avg_return).toBe(200);
    expect(m.winrate).toBe(1);
    expect(m.sharpe).toBe(0); // single trade -> sharpe 0
    expect(m.trades_count).toBe(1);
  });

  test('calculates avg_return correctly', () => {
    const trades = [
      makeTrade({ pnl: 100 }),
      makeTrade({ pnl: 200 }),
      makeTrade({ pnl: -50 }),
    ];
    const m = calculateMetrics(trades);
    expect(m.avg_return).toBeCloseTo(83.33, 1);
  });

  test('calculates winrate correctly', () => {
    const trades = [
      makeTrade({ success: true }),
      makeTrade({ success: true }),
      makeTrade({ success: false }),
      makeTrade({ success: false }),
    ];
    const m = calculateMetrics(trades);
    expect(m.winrate).toBe(0.5);
  });

  test('calculates sharpe ratio correctly', () => {
    // Known values: pnl = [100, 200, 300], mean = 200, stddev = 81.65
    const trades = [
      makeTrade({ pnl: 100 }),
      makeTrade({ pnl: 200 }),
      makeTrade({ pnl: 300 }),
    ];
    const m = calculateMetrics(trades);
    expect(m.sharpe).toBeCloseTo(200 / 81.65, 1);
  });

  test('returns sharpe 0 when all pnl values are the same', () => {
    const trades = [
      makeTrade({ pnl: 100 }),
      makeTrade({ pnl: 100 }),
    ];
    const m = calculateMetrics(trades);
    expect(m.sharpe).toBe(0);
  });

  test('handles all winning trades', () => {
    const trades = [makeTrade({ success: true }), makeTrade({ success: true })];
    const m = calculateMetrics(trades);
    expect(m.winrate).toBe(1);
  });

  test('handles all losing trades', () => {
    const trades = [makeTrade({ success: false }), makeTrade({ success: false })];
    const m = calculateMetrics(trades);
    expect(m.winrate).toBe(0);
  });
});

describe('aggregatePerformance', () => {
  let store: ITradeStore;

  afterEach(() => {
    store?.close();
  });

  test('groups by strategy and regime', () => {
    store = createTradeStore();
    store.insertTrade({ strategy: 'momentum', regime: 'trending', volatility: 0.15, pnl: 100, success: true });
    store.insertTrade({ strategy: 'momentum', regime: 'ranging', volatility: 0.08, pnl: 50, success: true });
    store.insertTrade({ strategy: 'mean-revert', regime: 'ranging', volatility: 0.08, pnl: 200, success: true });

    const perf = aggregatePerformance(store);

    expect(perf['momentum']?.trending).toBeDefined();
    expect(perf['momentum']?.ranging).toBeDefined();
    expect(perf['momentum']?.volatile).toBeUndefined();
    expect(perf['mean-revert']?.ranging).toBeDefined();
    expect(perf['mean-revert']?.trending).toBeUndefined();
  });

  test('returns empty object for empty store', () => {
    store = createTradeStore();
    const perf = aggregatePerformance(store);
    expect(Object.keys(perf)).toHaveLength(0);
  });
});
