import { describe, it, expect } from 'bun:test';
import { flagComparison, flagRollingDrift, determineSeverity } from '../threshold-flagger';
import type { TradeComparison, RollingDriftMetrics, TradeFlag } from '../types';
import { createDefaultConfig } from '../config';

const defaultThresholds = createDefaultConfig().thresholds;

function makeComparison(overrides?: Partial<TradeComparison>): TradeComparison {
  return {
    tradeId: 'test-1' as never,
    symbol: 'BTC/USD',
    entryDeviation: 0,
    entryDeviationPct: 0,
    exitDeviation: 0,
    exitDeviationPct: 0,
    slippageDiff: 0,
    pnlDiff: 0,
    pnlDiffPct: 0,
    flags: [],
    ...overrides,
  };
}

describe('flagComparison', () => {
  it('returns no flags when within thresholds', () => {
    const comparison = makeComparison({
      entryDeviationPct: 0.001, // below 0.002
      exitDeviationPct: 0.001,
      pnlDiffPct: 0.01, // below 0.05
    });
    const flags = flagComparison(comparison, defaultThresholds);
    expect(flags).toHaveLength(0);
  });

  it('flags entry price deviation', () => {
    const comparison = makeComparison({ entryDeviationPct: 0.005 });
    const flags = flagComparison(comparison, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].metric).toBe('entryDeviationPct');
    expect(flags[0].severity).toBe('MEDIUM');
  });

  it('flags exit price deviation', () => {
    const comparison = makeComparison({ exitDeviationPct: 0.005 });
    const flags = flagComparison(comparison, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].metric).toBe('exitDeviationPct');
    expect(flags[0].severity).toBe('MEDIUM');
  });

  it('flags PnL deviation as HIGH', () => {
    const comparison = makeComparison({ pnlDiffPct: 0.1 });
    const flags = flagComparison(comparison, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].metric).toBe('pnlDiffPct');
    expect(flags[0].severity).toBe('HIGH');
  });

  it('flags Infinity pnlDiffPct as HIGH', () => {
    const comparison = makeComparison({ pnlDiffPct: Infinity });
    const flags = flagComparison(comparison, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('HIGH');
  });

  it('produces multiple flags', () => {
    const comparison = makeComparison({
      entryDeviationPct: 0.005,
      exitDeviationPct: 0.005,
      pnlDiffPct: 0.1,
    });
    const flags = flagComparison(comparison, defaultThresholds);
    expect(flags).toHaveLength(3);
  });
});

describe('flagRollingDrift', () => {
  it('flags sharpe drift as MEDIUM', () => {
    const metrics: RollingDriftMetrics = {
      windowSize: 50,
      sharpeDrift: 0.8,
      drawdownDrift: 0,
      frequencyDrift: 0,
      winrateDrift: 0,
    };
    const flags = flagRollingDrift(metrics, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('MEDIUM');
  });

  it('flags drawdown drift as HIGH', () => {
    const metrics: RollingDriftMetrics = {
      windowSize: 50,
      sharpeDrift: 0,
      drawdownDrift: 0.1,
      frequencyDrift: 0,
      winrateDrift: 0,
    };
    const flags = flagRollingDrift(metrics, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('HIGH');
  });

  it('flags frequency drift as LOW', () => {
    const metrics: RollingDriftMetrics = {
      windowSize: 50,
      sharpeDrift: 0,
      drawdownDrift: 0,
      frequencyDrift: 0.3,
      winrateDrift: 0,
    };
    const flags = flagRollingDrift(metrics, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('LOW');
  });

  it('flags winrate drift as HIGH', () => {
    const metrics: RollingDriftMetrics = {
      windowSize: 50,
      sharpeDrift: 0,
      drawdownDrift: 0,
      frequencyDrift: 0,
      winrateDrift: 0.15,
    };
    const flags = flagRollingDrift(metrics, defaultThresholds);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe('HIGH');
  });
});

describe('determineSeverity', () => {
  it('returns LOW for no flags', () => {
    expect(determineSeverity([])).toBe('LOW');
  });

  it('returns the severity of a single flag', () => {
    const flags: TradeFlag[] = [
      { metric: 'test', threshold: 0, actual: 1, severity: 'MEDIUM', message: 'test' },
    ];
    expect(determineSeverity(flags)).toBe('MEDIUM');
  });

  it('returns HIGH when any flag is HIGH', () => {
    const flags: TradeFlag[] = [
      { metric: 'a', threshold: 0, actual: 1, severity: 'LOW', message: 'a' },
      { metric: 'b', threshold: 0, actual: 1, severity: 'HIGH', message: 'b' },
      { metric: 'c', threshold: 0, actual: 1, severity: 'MEDIUM', message: 'c' },
    ];
    expect(determineSeverity(flags)).toBe('HIGH');
  });

  it('returns MEDIUM when highest is MEDIUM', () => {
    const flags: TradeFlag[] = [
      { metric: 'a', threshold: 0, actual: 1, severity: 'LOW', message: 'a' },
      { metric: 'b', threshold: 0, actual: 1, severity: 'MEDIUM', message: 'b' },
    ];
    expect(determineSeverity(flags)).toBe('MEDIUM');
  });
});
