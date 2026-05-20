// Main class
export { ParityEnforcer } from './enforcer';

// Types (re-export all)
export type {
  Trade,
  TradeId,
  Timestamp,
  Severity,
  DriftAction,
  TradeComparison,
  TradeFlag,
  RollingDriftMetrics,
  DriftReport,
  ThresholdConfig,
  ActionConfig,
  EnforcerConfig,
  ActionHandler,
} from './types';

// Error classes
export { ParityEnforcerError, ThresholdConfigError } from './types';

// Config helpers
export { createDefaultConfig, validateConfig } from './config';

// Individual engines (for advanced usage)
export { TradeStore } from './trade-store';
export { compareTrade, compareTrades } from './comparison-engine';
export { flagComparison, determineSeverity, flagRollingDrift } from './threshold-flagger';
export { computeRollingDrift } from './rolling-drift';
export { AutoResponder } from './auto-responder';
