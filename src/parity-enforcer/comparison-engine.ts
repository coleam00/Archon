import type { Trade, TradeComparison } from './types';

export function compareTrade(expected: Trade, actual: Trade): TradeComparison {
  const entryDeviation = Math.abs(actual.entryPrice - expected.entryPrice);
  const entryDeviationPct = expected.entryPrice !== 0 ? entryDeviation / expected.entryPrice : 0;

  const exitDeviation = Math.abs(actual.exitPrice - expected.exitPrice);
  const exitDeviationPct = expected.exitPrice !== 0 ? exitDeviation / expected.exitPrice : 0;

  const expectedSlippage = Math.abs(expected.exitPrice - expected.entryPrice) * expected.quantity;
  const actualSlippage = Math.abs(actual.exitPrice - actual.entryPrice) * actual.quantity;
  const slippageDiff = actualSlippage - expectedSlippage;

  const pnlDiff = actual.pnl - expected.pnl;
  let pnlDiffPct: number;
  if (expected.pnl === 0) {
    pnlDiffPct = actual.pnl !== 0 ? Infinity : 0;
  } else {
    pnlDiffPct = pnlDiff / Math.abs(expected.pnl);
  }

  return {
    tradeId: expected.id,
    symbol: expected.symbol,
    entryDeviation,
    entryDeviationPct,
    exitDeviation,
    exitDeviationPct,
    slippageDiff,
    pnlDiff,
    pnlDiffPct,
    flags: [],
  };
}

export function compareTrades(pairs: { expected: Trade; actual: Trade }[]): TradeComparison[] {
  return pairs.map(({ expected, actual }) => compareTrade(expected, actual));
}
