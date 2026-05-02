import type { z } from '@hono/zod-openapi';
import type {
  regimeSchema,
  tradeRecordSchema,
  marketStateSchema,
  performanceMetricsSchema,
  recommendationSchema,
} from './schemas';

export type Regime = z.infer<typeof regimeSchema>;
export type TradeRecord = z.infer<typeof tradeRecordSchema>;
export type MarketState = z.infer<typeof marketStateSchema>;
export type PerformanceMetrics = z.infer<typeof performanceMetricsSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;

export interface StoredTrade extends TradeRecord {
  id: number;
  timestamp: string;
}

export type StrategyPerformance = Record<string, Partial<Record<Regime, PerformanceMetrics>>>;

export interface ITradeStore {
  initialize(): void;
  insertTrade(trade: TradeRecord): StoredTrade;
  getTradesByStrategyAndRegime(strategy: string, regime: Regime): StoredTrade[];
  getAllStrategies(): string[];
  getAllTrades(): StoredTrade[];
  close(): void;
}

export interface EngineConfig {
  dbPath?: string;
  explorationRate?: number;
  minTradesForConfidence?: number;
  minWinRate?: number;
}
