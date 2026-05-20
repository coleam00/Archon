import type { EnforcerConfig, ThresholdConfig } from './types';
import { ThresholdConfigError } from './types';

export function createDefaultConfig(): EnforcerConfig {
  return {
    thresholds: {
      priceDeviationPct: 0.002,
      pnlDeviationPct: 0.05,
      winrateDriftPct: 0.1,
      sharpeDriftThreshold: 0.5,
      drawdownDriftPct: 0.05,
      frequencyDriftPct: 0.2,
    },
    actions: {
      LOW: 'alert',
      MEDIUM: 'reduce_position',
      HIGH: 'stop_trading',
    },
    rollingWindowSize: 50,
    enabled: true,
  };
}

function validateThresholds(thresholds: ThresholdConfig): void {
  const fields: (keyof ThresholdConfig)[] = [
    'priceDeviationPct',
    'pnlDeviationPct',
    'winrateDriftPct',
    'sharpeDriftThreshold',
    'drawdownDriftPct',
    'frequencyDriftPct',
  ];

  for (const field of fields) {
    const value = thresholds[field];
    if (value <= 0) {
      throw new ThresholdConfigError(field, value);
    }
  }
}

export function validateConfig(config: Partial<EnforcerConfig>): EnforcerConfig {
  const merged = mergeConfig(createDefaultConfig(), config);
  validateThresholds(merged.thresholds);
  return merged;
}

export function mergeConfig(
  base: EnforcerConfig,
  overrides: Partial<EnforcerConfig>
): EnforcerConfig {
  return {
    thresholds: overrides.thresholds
      ? { ...base.thresholds, ...overrides.thresholds }
      : base.thresholds,
    actions: overrides.actions ? { ...base.actions, ...overrides.actions } : base.actions,
    rollingWindowSize: overrides.rollingWindowSize ?? base.rollingWindowSize,
    enabled: overrides.enabled ?? base.enabled,
  };
}
