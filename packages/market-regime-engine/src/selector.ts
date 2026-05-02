import type {
  PerformanceMetrics,
  StrategyPerformance,
  Regime,
  Recommendation,
  EngineConfig,
} from './types';

/**
 * Score = expected_return * confidence * stability
 *
 * - expected_return: average PnL (avg_return)
 * - confidence: trade count / minTrades, capped at 1.0 — ramps up as data grows
 * - stability: win rate (winrate) — penalises volatile strategies
 *
 * Sharpe is deliberately excluded: it already factors into strategy selection via
 * the `isDisabled` gate, and including it here would double-penalise high-variance
 * strategies that pass the win-rate filter.
 */
export function scoreStrategy(metrics: PerformanceMetrics, minTrades: number): number {
  const expectedReturn = metrics.avg_return;
  const confidence = Math.min(metrics.trades_count / minTrades, 1.0);
  const stability = metrics.winrate;
  return expectedReturn * confidence * stability;
}

export function isDisabled(metrics: PerformanceMetrics, minWinRate: number): boolean {
  return metrics.avg_return < 0 || metrics.winrate < minWinRate;
}

type SelectorConfig = Required<
  Pick<EngineConfig, 'explorationRate' | 'minTradesForConfidence' | 'minWinRate'>
>;

export function selectStrategy(
  performance: StrategyPerformance,
  regime: Regime,
  config: SelectorConfig
): Recommendation {
  const candidates: { strategy: string; score: number; metrics: PerformanceMetrics }[] = [];

  for (const [strategy, regimeMap] of Object.entries(performance)) {
    const metrics = regimeMap[regime];
    if (!metrics) continue;
    if (isDisabled(metrics, config.minWinRate)) continue;

    const score = scoreStrategy(metrics, config.minTradesForConfidence);
    candidates.push({ strategy, score, metrics });
  }

  if (candidates.length === 0) {
    return { selected_strategy: null, confidence: 0, alternatives: [] };
  }

  candidates.sort((a, b) => b.score - a.score);

  const isExploring = Math.random() < config.explorationRate;
  let selected: (typeof candidates)[number];

  if (isExploring && candidates.length > 1) {
    // Explore: pick random from non-top candidates
    const explorePool = candidates.slice(1);
    selected = explorePool[Math.floor(Math.random() * explorePool.length)];
  } else {
    // Exploit: pick top scorer
    selected = candidates[0];
  }

  const confidence = Math.min(
    (selected.metrics.trades_count / config.minTradesForConfidence) * selected.metrics.winrate,
    1.0
  );

  const alternatives = candidates
    .filter(c => c.strategy !== selected.strategy)
    .map(c => ({ strategy: c.strategy, score: c.score, metrics: c.metrics }));

  return {
    selected_strategy: selected.strategy,
    confidence,
    alternatives,
  };
}
