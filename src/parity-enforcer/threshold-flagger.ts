import type {
  RollingDriftMetrics,
  Severity,
  TradeComparison,
  TradeFlag,
  ThresholdConfig,
} from './types';

export function flagComparison(comparison: TradeComparison, config: ThresholdConfig): TradeFlag[] {
  const flags: TradeFlag[] = [];

  if (comparison.entryDeviationPct > config.priceDeviationPct) {
    flags.push({
      metric: 'entryDeviationPct',
      threshold: config.priceDeviationPct,
      actual: comparison.entryDeviationPct,
      severity: 'MEDIUM',
      message: `Entry price deviation ${(comparison.entryDeviationPct * 100).toFixed(3)}% exceeds threshold ${(config.priceDeviationPct * 100).toFixed(3)}%`,
    });
  }

  if (comparison.exitDeviationPct > config.priceDeviationPct) {
    flags.push({
      metric: 'exitDeviationPct',
      threshold: config.priceDeviationPct,
      actual: comparison.exitDeviationPct,
      severity: 'MEDIUM',
      message: `Exit price deviation ${(comparison.exitDeviationPct * 100).toFixed(3)}% exceeds threshold ${(config.priceDeviationPct * 100).toFixed(3)}%`,
    });
  }

  if (
    comparison.pnlDiffPct !== Infinity &&
    Math.abs(comparison.pnlDiffPct) > config.pnlDeviationPct
  ) {
    flags.push({
      metric: 'pnlDiffPct',
      threshold: config.pnlDeviationPct,
      actual: Math.abs(comparison.pnlDiffPct),
      severity: 'HIGH',
      message: `PnL deviation ${(Math.abs(comparison.pnlDiffPct) * 100).toFixed(2)}% exceeds threshold ${(config.pnlDeviationPct * 100).toFixed(2)}%`,
    });
  } else if (comparison.pnlDiffPct === Infinity) {
    flags.push({
      metric: 'pnlDiffPct',
      threshold: config.pnlDeviationPct,
      actual: Infinity,
      severity: 'HIGH',
      message: 'PnL deviation is infinite (expected PnL was zero)',
    });
  }

  return flags;
}

export function flagRollingDrift(
  metrics: RollingDriftMetrics,
  config: ThresholdConfig
): TradeFlag[] {
  const flags: TradeFlag[] = [];

  if (metrics.sharpeDrift > config.sharpeDriftThreshold) {
    flags.push({
      metric: 'sharpeDrift',
      threshold: config.sharpeDriftThreshold,
      actual: metrics.sharpeDrift,
      severity: 'MEDIUM',
      message: `Sharpe drift ${metrics.sharpeDrift.toFixed(3)} exceeds threshold ${config.sharpeDriftThreshold}`,
    });
  }

  if (metrics.drawdownDrift > config.drawdownDriftPct) {
    flags.push({
      metric: 'drawdownDrift',
      threshold: config.drawdownDriftPct,
      actual: metrics.drawdownDrift,
      severity: 'HIGH',
      message: `Drawdown drift ${(metrics.drawdownDrift * 100).toFixed(2)}% exceeds threshold ${(config.drawdownDriftPct * 100).toFixed(2)}%`,
    });
  }

  if (metrics.frequencyDrift > config.frequencyDriftPct) {
    flags.push({
      metric: 'frequencyDrift',
      threshold: config.frequencyDriftPct,
      actual: metrics.frequencyDrift,
      severity: 'LOW',
      message: `Trade frequency drift ${(metrics.frequencyDrift * 100).toFixed(2)}% exceeds threshold ${(config.frequencyDriftPct * 100).toFixed(2)}%`,
    });
  }

  if (metrics.winrateDrift > config.winrateDriftPct) {
    flags.push({
      metric: 'winrateDrift',
      threshold: config.winrateDriftPct,
      actual: metrics.winrateDrift,
      severity: 'HIGH',
      message: `Win rate drift ${(metrics.winrateDrift * 100).toFixed(2)}% exceeds threshold ${(config.winrateDriftPct * 100).toFixed(2)}%`,
    });
  }

  return flags;
}

export function determineSeverity(flags: TradeFlag[]): Severity {
  if (flags.length === 0) return 'LOW';
  let highest: Severity = 'LOW';
  for (const flag of flags) {
    if (flag.severity === 'HIGH') return 'HIGH';
    if (flag.severity === 'MEDIUM') highest = 'MEDIUM';
  }
  return highest;
}
