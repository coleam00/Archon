import { describe, it, expect } from 'bun:test';
import { validateConfig, createDefaultConfig, mergeConfig } from '../config';
import { ThresholdConfigError } from '../types';

describe('validateConfig', () => {
  it('returns valid config with defaults when no overrides', () => {
    const config = validateConfig({});
    const defaults = createDefaultConfig();
    expect(config).toEqual(defaults);
  });

  it('rejects zero threshold value', () => {
    expect(() =>
      validateConfig({ thresholds: { ...createDefaultConfig().thresholds, priceDeviationPct: 0 } })
    ).toThrow(ThresholdConfigError);
  });

  it('rejects negative threshold value', () => {
    expect(() =>
      validateConfig({ thresholds: { ...createDefaultConfig().thresholds, pnlDeviationPct: -0.5 } })
    ).toThrow(ThresholdConfigError);
  });

  it('rejects each invalid threshold field individually', () => {
    const fields = [
      'priceDeviationPct',
      'pnlDeviationPct',
      'winrateDriftPct',
      'sharpeDriftThreshold',
      'drawdownDriftPct',
      'frequencyDriftPct',
    ] as const;

    for (const field of fields) {
      expect(() =>
        validateConfig({ thresholds: { ...createDefaultConfig().thresholds, [field]: -1 } })
      ).toThrow(ThresholdConfigError);
    }
  });

  it('includes field name and value in error message', () => {
    try {
      validateConfig({
        thresholds: { ...createDefaultConfig().thresholds, priceDeviationPct: -0.01 },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ThresholdConfigError);
      expect((error as ThresholdConfigError).message).toContain('priceDeviationPct');
      expect((error as ThresholdConfigError).message).toContain('-0.01');
    }
  });
});

describe('mergeConfig', () => {
  it('preserves base values when no overrides given', () => {
    const base = createDefaultConfig();
    const merged = mergeConfig(base, {});
    expect(merged).toEqual(base);
  });

  it('overrides only specified fields', () => {
    const base = createDefaultConfig();
    const merged = mergeConfig(base, { rollingWindowSize: 100 });
    expect(merged.rollingWindowSize).toBe(100);
    expect(merged.thresholds).toEqual(base.thresholds);
    expect(merged.actions).toEqual(base.actions);
  });
});
