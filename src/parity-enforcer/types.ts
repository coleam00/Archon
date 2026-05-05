// Branded types
export type TradeId = string & { readonly __brand: 'TradeId' };
export type Timestamp = number; // Unix milliseconds

// Severity levels
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

// Auto-response actions
export type DriftAction = 'reduce_position' | 'switch_paper' | 'alert' | 'stop_trading';

// Core trade interface
export interface Trade {
  readonly id: TradeId;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly entryTime: Timestamp;
  readonly exitTime: Timestamp;
  readonly quantity: number;
  readonly pnl: number;
}

// Per-trade comparison result
export interface TradeComparison {
  readonly tradeId: TradeId;
  readonly symbol: string;
  readonly entryDeviation: number;
  readonly entryDeviationPct: number;
  readonly exitDeviation: number;
  readonly exitDeviationPct: number;
  readonly slippageDiff: number;
  readonly pnlDiff: number;
  readonly pnlDiffPct: number;
  readonly flags: TradeFlag[];
}

// Flag from threshold check
export interface TradeFlag {
  readonly metric: string;
  readonly threshold: number;
  readonly actual: number;
  readonly severity: Severity;
  readonly message: string;
}

// Rolling drift metrics
export interface RollingDriftMetrics {
  readonly windowSize: number;
  readonly sharpeDrift: number;
  readonly drawdownDrift: number;
  readonly frequencyDrift: number;
  readonly winrateDrift: number;
}

// Structured output format (primary API output)
export interface DriftReport {
  readonly drift: boolean;
  readonly severity: Severity;
  readonly reason: string;
  readonly actionTaken: DriftAction | 'none';
  readonly timestamp: Timestamp;
  readonly tradeComparisons: TradeComparison[];
  readonly rollingMetrics: RollingDriftMetrics | null;
  readonly flags: TradeFlag[];
}

// Threshold configuration
export interface ThresholdConfig {
  readonly priceDeviationPct: number;
  readonly pnlDeviationPct: number;
  readonly winrateDriftPct: number;
  readonly sharpeDriftThreshold: number;
  readonly drawdownDriftPct: number;
  readonly frequencyDriftPct: number;
}

// Severity → action mapping
export interface ActionConfig {
  readonly LOW: DriftAction;
  readonly MEDIUM: DriftAction;
  readonly HIGH: DriftAction;
}

// Full enforcer config
export interface EnforcerConfig {
  readonly thresholds: ThresholdConfig;
  readonly actions: ActionConfig;
  readonly rollingWindowSize: number;
  readonly enabled: boolean;
}

// Action handler callback type
export type ActionHandler = (action: DriftAction, report: DriftReport) => void | Promise<void>;

// Custom error classes
export class ParityEnforcerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParityEnforcerError';
  }
}

export class ThresholdConfigError extends ParityEnforcerError {
  constructor(field: string, value: number) {
    super(`Invalid threshold: ${field} = ${value}`);
    this.name = 'ThresholdConfigError';
  }
}
