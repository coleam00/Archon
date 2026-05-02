import { describe, test, expect, afterEach } from 'bun:test';
import { createTradeStore } from './db';
import type { ITradeStore } from './types';

describe('createTradeStore', () => {
  let store: ITradeStore;

  afterEach(() => {
    store?.close();
  });

  test('creates store with in-memory database', () => {
    store = createTradeStore();
    expect(store).toBeDefined();
  });

  test('insertTrade returns stored trade with id and timestamp', () => {
    store = createTradeStore();
    const result = store.insertTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 250,
      success: true,
    });
    expect(result.id).toBe(1);
    expect(result.strategy).toBe('momentum');
    expect(result.regime).toBe('trending');
    expect(result.volatility).toBe(0.15);
    expect(result.pnl).toBe(250);
    expect(result.success).toBe(true);
    expect(typeof result.timestamp).toBe('string');
  });

  test('insertTrade converts boolean success correctly', () => {
    store = createTradeStore();
    const win = store.insertTrade({
      strategy: 'a',
      regime: 'calm',
      volatility: 0.1,
      pnl: 100,
      success: true,
    });
    const loss = store.insertTrade({
      strategy: 'a',
      regime: 'calm',
      volatility: 0.1,
      pnl: -50,
      success: false,
    });
    expect(win.success).toBe(true);
    expect(loss.success).toBe(false);
  });

  test('getTradesByStrategyAndRegime filters correctly', () => {
    store = createTradeStore();
    store.insertTrade({ strategy: 'momentum', regime: 'trending', volatility: 0.15, pnl: 250, success: true });
    store.insertTrade({ strategy: 'momentum', regime: 'ranging', volatility: 0.08, pnl: 50, success: true });
    store.insertTrade({ strategy: 'mean-revert', regime: 'trending', volatility: 0.15, pnl: -30, success: false });

    const result = store.getTradesByStrategyAndRegime('momentum', 'trending');
    expect(result).toHaveLength(1);
    expect(result[0].strategy).toBe('momentum');
    expect(result[0].regime).toBe('trending');
  });

  test('getAllStrategies returns distinct strategies', () => {
    store = createTradeStore();
    store.insertTrade({ strategy: 'momentum', regime: 'trending', volatility: 0.15, pnl: 100, success: true });
    store.insertTrade({ strategy: 'momentum', regime: 'ranging', volatility: 0.08, pnl: 50, success: true });
    store.insertTrade({ strategy: 'mean-revert', regime: 'calm', volatility: 0.05, pnl: 30, success: true });

    const strategies = store.getAllStrategies();
    expect(strategies).toHaveLength(2);
    expect(strategies).toContain('momentum');
    expect(strategies).toContain('mean-revert');
  });

  test('getAllTrades returns all trades', () => {
    store = createTradeStore();
    store.insertTrade({ strategy: 'a', regime: 'trending', volatility: 0.1, pnl: 10, success: true });
    store.insertTrade({ strategy: 'b', regime: 'calm', volatility: 0.2, pnl: 20, success: false });

    const trades = store.getAllTrades();
    expect(trades).toHaveLength(2);
  });

  test('empty database returns empty arrays', () => {
    store = createTradeStore();
    expect(store.getTradesByStrategyAndRegime('x', 'trending')).toHaveLength(0);
    expect(store.getAllStrategies()).toHaveLength(0);
    expect(store.getAllTrades()).toHaveLength(0);
  });

  test('auto-increments ids', () => {
    store = createTradeStore();
    const t1 = store.insertTrade({ strategy: 'a', regime: 'trending', volatility: 0.1, pnl: 10, success: true });
    const t2 = store.insertTrade({ strategy: 'b', regime: 'calm', volatility: 0.2, pnl: 20, success: true });
    expect(t2.id).toBe(t1.id + 1);
  });
});
