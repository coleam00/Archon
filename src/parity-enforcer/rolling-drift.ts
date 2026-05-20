import type { RollingDriftMetrics, Trade } from './types';
import { maxDrawdown, sharpeRatio, tradeFrequency, winRate } from './math-utils';

export function computeRollingDrift(
  expectedTrades: Trade[],
  actualTrades: Trade[],
  windowSize: number
): RollingDriftMetrics | null {
  if (expectedTrades.length < windowSize || actualTrades.length < windowSize) {
    return null;
  }

  const expectedWindow = expectedTrades.slice(-windowSize);
  const actualWindow = actualTrades.slice(-windowSize);

  const expectedReturns = expectedWindow.map(t => t.pnl);
  const actualReturns = actualWindow.map(t => t.pnl);

  const sharpeDrift = computeSharpeDrift(expectedReturns, actualReturns);
  const drawdownDrift = computeDrawdownDrift(expectedReturns, actualReturns);
  const frequencyDrift = computeFrequencyDrift(
    expectedWindow.map(t => t.entryTime),
    actualWindow.map(t => t.entryTime),
    expectedWindow[expectedWindow.length - 1].entryTime - expectedWindow[0].entryTime
  );
  const expectedWinRate = winRate(expectedReturns);
  const actualWinRate = winRate(actualReturns);
  const winrateDrift = Math.abs(actualWinRate - expectedWinRate);

  return {
    windowSize,
    sharpeDrift,
    drawdownDrift,
    frequencyDrift,
    winrateDrift,
  };
}

function computeSharpeDrift(expectedReturns: number[], actualReturns: number[]): number {
  return Math.abs(sharpeRatio(actualReturns) - sharpeRatio(expectedReturns));
}

function computeDrawdownDrift(expectedPnls: number[], actualPnls: number[]): number {
  const expectedEquity = cumulativeSum(expectedPnls);
  const actualEquity = cumulativeSum(actualPnls);
  return Math.abs(maxDrawdown(actualEquity) - maxDrawdown(expectedEquity));
}

function computeFrequencyDrift(
  expectedTimes: number[],
  actualTimes: number[],
  windowMs: number
): number {
  if (windowMs <= 0) return 0;
  const expectedFreq = tradeFrequency(expectedTimes, windowMs);
  if (expectedFreq === 0) return 0;
  const actualFreq = tradeFrequency(actualTimes, windowMs);
  return Math.abs(actualFreq - expectedFreq) / expectedFreq;
}

function cumulativeSum(values: number[]): number[] {
  const result: number[] = [];
  let sum = 0;
  for (const v of values) {
    sum += v;
    result.push(sum);
  }
  return result;
}
