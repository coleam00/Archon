import { describe, test, expect, afterEach } from 'bun:test';
import { RegimeEngine } from './engine';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RegimeEngine', () => {
  let engine: RegimeEngine;

  afterEach(() => {
    engine?.close();
  });

  test('records trade and returns stored trade', () => {
    engine = new RegimeEngine();
    const stored = engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 250,
      success: true,
    });
    expect(stored.id).toBe(1);
    expect(stored.strategy).toBe('momentum');
    expect(typeof stored.timestamp).toBe('string');
  });

  test('validates trade input with Zod', () => {
    engine = new RegimeEngine();
    expect(() =>
      engine.recordTrade({
        strategy: '',
        regime: 'trending',
        volatility: 0.15,
        pnl: 100,
        success: true,
      })
    ).toThrow();
  });

  test('validates market state with Zod', () => {
    engine = new RegimeEngine();
    expect(() =>
      // @ts-expect-error intentionally invalid regime
      engine.getRecommendation({ regime: 'invalid', volatility: 0.1 })
    ).toThrow();
  });

  test('getRecommendation returns valid recommendation', () => {
    engine = new RegimeEngine();
    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 250,
      success: true,
    });
    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.18,
      pnl: 150,
      success: true,
    });
    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.12,
      pnl: -50,
      success: false,
    });

    const rec = engine.getRecommendation({ regime: 'trending', volatility: 0.16 });
    expect(rec).toHaveProperty('selected_strategy');
    expect(rec).toHaveProperty('confidence');
    expect(rec).toHaveProperty('alternatives');
  });

  test('empty engine returns null recommendation', () => {
    engine = new RegimeEngine();
    const rec = engine.getRecommendation({ regime: 'trending', volatility: 0.1 });
    expect(rec.selected_strategy).toBeNull();
    expect(rec.confidence).toBe(0);
    expect(rec.alternatives).toHaveLength(0);
  });

  test('getPerformance returns aggregated data', () => {
    engine = new RegimeEngine();
    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 100,
      success: true,
    });
    engine.recordTrade({
      strategy: 'mean-revert',
      regime: 'ranging',
      volatility: 0.08,
      pnl: 200,
      success: true,
    });

    const perf = engine.getPerformance();
    expect(perf['momentum']?.trending).toBeDefined();
    expect(perf['mean-revert']?.ranging).toBeDefined();
  });

  test('getStrategyPerformance returns specific metrics', () => {
    engine = new RegimeEngine();
    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 100,
      success: true,
    });

    const metrics = engine.getStrategyPerformance('momentum', 'trending');
    expect(metrics).not.toBeNull();
    expect(metrics!.avg_return).toBe(100);
    expect(metrics!.trades_count).toBe(1);
  });

  test('getStrategyPerformance returns null for unknown', () => {
    engine = new RegimeEngine();
    expect(engine.getStrategyPerformance('unknown', 'trending')).toBeNull();
  });

  test('getTradeHistory returns all trades', () => {
    engine = new RegimeEngine();
    engine.recordTrade({
      strategy: 'a',
      regime: 'trending',
      volatility: 0.1,
      pnl: 10,
      success: true,
    });
    engine.recordTrade({ strategy: 'b', regime: 'calm', volatility: 0.2, pnl: 20, success: false });

    const history = engine.getTradeHistory();
    expect(history).toHaveLength(2);
  });

  test('performance cache invalidated after recordTrade', () => {
    engine = new RegimeEngine();
    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 100,
      success: true,
    });

    const perf1 = engine.getPerformance();
    expect(perf1['momentum']?.trending?.trades_count).toBe(1);

    engine.recordTrade({
      strategy: 'momentum',
      regime: 'trending',
      volatility: 0.15,
      pnl: 200,
      success: true,
    });

    const perf2 = engine.getPerformance();
    expect(perf2['momentum']?.trending?.trades_count).toBe(2);
  });

  test('auto-disables strategy with negative expectancy', () => {
    engine = new RegimeEngine();
    // Record losing trades to make momentum disabled in trending
    for (let i = 0; i < 5; i++) {
      engine.recordTrade({
        strategy: 'momentum',
        regime: 'trending',
        volatility: 0.15,
        pnl: -100,
        success: false,
      });
    }
    // Record winning trades for mean-revert
    for (let i = 0; i < 5; i++) {
      engine.recordTrade({
        strategy: 'mean-revert',
        regime: 'trending',
        volatility: 0.15,
        pnl: 100,
        success: true,
      });
    }

    const rec = engine.getRecommendation({ regime: 'trending', volatility: 0.15 });
    expect(rec.selected_strategy).toBe('mean-revert');
  });

  test('persists data to file', () => {
    const dbPath = join(tmpdir(), `regime-test-${Date.now()}.db`);
    try {
      engine = new RegimeEngine({ dbPath });
      engine.recordTrade({
        strategy: 'momentum',
        regime: 'trending',
        volatility: 0.15,
        pnl: 100,
        success: true,
      });
      engine.close();

      // Reopen and verify data persists
      engine = new RegimeEngine({ dbPath });
      const history = engine.getTradeHistory();
      expect(history).toHaveLength(1);
      expect(history[0].strategy).toBe('momentum');
    } finally {
      engine?.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      // Clean up WAL files
      if (existsSync(dbPath + '-wal')) unlinkSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) unlinkSync(dbPath + '-shm');
    }
  });

  test('supports all four regime types', () => {
    engine = new RegimeEngine();
    const regimes = ['trending', 'ranging', 'volatile', 'calm'] as const;
    for (const regime of regimes) {
      engine.recordTrade({ strategy: 'test', regime, volatility: 0.1, pnl: 100, success: true });
    }
    const perf = engine.getPerformance();
    for (const regime of regimes) {
      expect(perf['test']?.[regime]).toBeDefined();
    }
  });
});
