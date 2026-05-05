import type { Trade, TradeId, EnforcerConfig } from '../types';
import { createDefaultConfig, mergeConfig } from '../config';

let idCounter = 0;

function nextId(): TradeId {
  return `trade-${++idCounter}` as TradeId;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

export function createTrade(overrides?: Partial<Trade>): Trade {
  const now = Date.now();
  return {
    id: nextId(),
    symbol: 'BTC/USD',
    side: 'long',
    entryPrice: 50000,
    exitPrice: 51000,
    entryTime: now,
    exitTime: now + 3600_000,
    quantity: 1,
    pnl: 1000,
    ...overrides,
  } as Trade;
}

export function createTradePair(opts?: {
  symbol?: string;
  entryDeviation?: number;
  pnlDeviation?: number;
  timeOffset?: number;
}): { expected: Trade; actual: Trade } {
  const { symbol = 'BTC/USD', entryDeviation = 0, pnlDeviation = 0, timeOffset = 0 } = opts ?? {};

  const now = Date.now();
  const basePrice = 50000;
  const basePnl = 1000;

  const expected = createTrade({
    symbol,
    entryPrice: basePrice,
    exitPrice: basePrice + basePnl,
    entryTime: now,
    pnl: basePnl,
  });

  const actual = createTrade({
    symbol,
    entryPrice: basePrice + entryDeviation,
    exitPrice: basePrice + basePnl + entryDeviation,
    entryTime: now + timeOffset,
    pnl: basePnl + pnlDeviation,
  });

  return { expected, actual };
}

export function createTradeSeries(
  count: number,
  opts?: {
    basePrice?: number;
    driftAfter?: number;
    driftMagnitude?: number;
  }
): { expected: Trade; actual: Trade }[] {
  const { basePrice = 50000, driftAfter = count, driftMagnitude = 0 } = opts ?? {};
  const pairs: { expected: Trade; actual: Trade }[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < count; i++) {
    const isDrifted = i >= driftAfter;
    const entryTime = baseTime + i * 60_000;
    const pnl = (i % 3 === 0 ? -100 : 200) + (isDrifted ? -driftMagnitude : 0);

    const expected = createTrade({
      symbol: 'BTC/USD',
      entryPrice: basePrice + i * 10,
      exitPrice: basePrice + i * 10 + (i % 3 === 0 ? -100 : 200),
      entryTime,
      exitTime: entryTime + 3600_000,
      pnl: i % 3 === 0 ? -100 : 200,
    });

    const actual = createTrade({
      symbol: 'BTC/USD',
      entryPrice: basePrice + i * 10 + (isDrifted ? driftMagnitude * 0.01 : 0),
      exitPrice: basePrice + i * 10 + (i % 3 === 0 ? -100 : 200),
      entryTime: entryTime + 1000,
      exitTime: entryTime + 3600_000 + 1000,
      pnl,
    });

    pairs.push({ expected, actual });
  }

  return pairs;
}

export function createTestConfig(overrides?: Partial<EnforcerConfig>): EnforcerConfig {
  const tighter: Partial<EnforcerConfig> = {
    thresholds: {
      priceDeviationPct: 0.001,
      pnlDeviationPct: 0.02,
      winrateDriftPct: 0.05,
      sharpeDriftThreshold: 0.3,
      drawdownDriftPct: 0.03,
      frequencyDriftPct: 0.1,
    },
    rollingWindowSize: 10,
  };

  return mergeConfig(createDefaultConfig(), { ...tighter, ...overrides });
}
