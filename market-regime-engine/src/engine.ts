import { createTradeStore } from './db';
import { aggregatePerformance } from './aggregator';
import { selectStrategy } from './selector';
import { tradeRecordSchema, marketStateSchema } from './schemas';
import { createLogger } from './logger';
import type {
  ITradeStore,
  TradeRecord,
  StoredTrade,
  MarketState,
  Recommendation,
  StrategyPerformance,
  PerformanceMetrics,
  Regime,
  EngineConfig,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('engine');
  return cachedLog;
}

const DEFAULTS: Required<EngineConfig> = {
  dbPath: ':memory:',
  explorationRate: 0.2,
  minTradesForConfidence: 10,
  minWinRate: 0.4,
};

export class RegimeEngine {
  private store: ITradeStore;
  private config: Required<EngineConfig>;
  private cachedPerformance: StrategyPerformance | null = null;

  constructor(config?: EngineConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.store = createTradeStore(this.config.dbPath);
    getLog().info({ dbPath: this.config.dbPath }, 'engine.create_completed');
  }

  recordTrade(trade: TradeRecord): StoredTrade {
    const validated = tradeRecordSchema.parse(trade);
    const stored = this.store.insertTrade(validated);
    this.cachedPerformance = null; // invalidate cache
    getLog().info({ tradeId: stored.id, strategy: stored.strategy, regime: stored.regime }, 'engine.trade_recorded');
    return stored;
  }

  getRecommendation(state: MarketState): Recommendation {
    const validated = marketStateSchema.parse(state);
    const performance = this.getPerformance();
    const recommendation = selectStrategy(performance, validated.regime, {
      explorationRate: this.config.explorationRate,
      minTradesForConfidence: this.config.minTradesForConfidence,
      minWinRate: this.config.minWinRate,
    });
    getLog().info(
      { regime: validated.regime, selected: recommendation.selected_strategy },
      'engine.recommendation_completed'
    );
    return recommendation;
  }

  getPerformance(): StrategyPerformance {
    if (!this.cachedPerformance) {
      this.cachedPerformance = aggregatePerformance(this.store);
    }
    return this.cachedPerformance;
  }

  getStrategyPerformance(strategy: string, regime: Regime): PerformanceMetrics | null {
    const perf = this.getPerformance();
    return perf[strategy]?.[regime] ?? null;
  }

  getTradeHistory(): StoredTrade[] {
    return this.store.getAllTrades();
  }

  close(): void {
    this.store.close();
    getLog().info('engine.close_completed');
  }
}
