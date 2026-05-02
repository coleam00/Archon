import type { StoredTrade, PerformanceMetrics, StrategyPerformance, ITradeStore } from './types';
import { regimeSchema } from './schemas';

export function calculateMetrics(trades: StoredTrade[]): PerformanceMetrics {
  if (trades.length === 0) {
    return { avg_return: 0, winrate: 0, sharpe: 0, trades_count: 0 };
  }

  const pnls = trades.map(t => t.pnl);
  const avgReturn = pnls.reduce((sum, v) => sum + v, 0) / pnls.length;
  const winrate = trades.filter(t => t.success).length / trades.length;

  let sharpe = 0;
  if (pnls.length >= 2) {
    const mean = avgReturn;
    const variance = pnls.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pnls.length;
    const stddev = Math.sqrt(variance);
    if (stddev > 0) {
      sharpe = mean / stddev;
    }
  }

  return { avg_return: avgReturn, winrate, sharpe, trades_count: trades.length };
}

export function aggregatePerformance(store: ITradeStore): StrategyPerformance {
  const strategies = store.getAllStrategies();
  const regimes = regimeSchema.options;
  const result: StrategyPerformance = {};

  for (const strategy of strategies) {
    result[strategy] = {};
    for (const regime of regimes) {
      const trades = store.getTradesByStrategyAndRegime(strategy, regime);
      if (trades.length > 0) {
        result[strategy][regime] = calculateMetrics(trades);
      }
    }
  }

  return result;
}
