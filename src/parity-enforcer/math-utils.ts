import type { Timestamp } from './types';

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  let sumSqDiff = 0;
  for (const v of values) {
    const diff = v - avg;
    sumSqDiff += diff * diff;
  }
  return Math.sqrt(sumSqDiff / (values.length - 1));
}

export function sharpeRatio(returns: number[], riskFreeRate = 0): number {
  if (returns.length === 0) return 0;
  const avg = mean(returns);
  const std = standardDeviation(returns);
  if (std === 0) return 0;
  // Annualize assuming daily returns (252 trading days/year)
  return ((avg - riskFreeRate) / std) * Math.sqrt(252);
}

export function maxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0];
  let worstDrawdown = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const drawdown = peak > 0 ? (peak - value) / peak : 0;
    if (drawdown > worstDrawdown) worstDrawdown = drawdown;
  }
  return worstDrawdown;
}

export function winRate(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  let wins = 0;
  for (const pnl of pnls) {
    if (pnl > 0) wins++;
  }
  return wins / pnls.length;
}

export function tradeFrequency(timestamps: Timestamp[], windowMs: number): number {
  if (timestamps.length <= 1 || windowMs <= 0) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  if (span === 0) return 0;
  return (timestamps.length / span) * windowMs;
}
