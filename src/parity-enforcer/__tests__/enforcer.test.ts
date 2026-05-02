import { describe, it, expect, beforeEach } from 'bun:test';
import { ParityEnforcer } from '../enforcer';
import { createTrade, createTestConfig, resetIdCounter } from './helpers';
import type { DriftReport, Timestamp } from '../types';

describe('ParityEnforcer', () => {
  let enforcer: ParityEnforcer;

  beforeEach(() => {
    resetIdCounter();
    enforcer = new ParityEnforcer(createTestConfig());
  });

  it('returns null when no match found', () => {
    const trade = createTrade({ symbol: 'BTC/USD' });
    const result = enforcer.addActualTrade(trade);
    expect(result).toBeNull();
  });

  it('returns a DriftReport when a match is found', () => {
    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp });
    const actual = createTrade({ symbol: 'BTC/USD', entryTime: (now + 1000) as Timestamp });

    enforcer.addExpectedTrade(expected);
    const report = enforcer.addActualTrade(actual);

    expect(report).not.toBeNull();
    expect(report!.tradeComparisons).toHaveLength(1);
  });

  it('reports no drift for identical trades', () => {
    const now = Date.now() as Timestamp;
    const trade = createTrade({
      symbol: 'BTC/USD',
      entryTime: now as Timestamp,
      entryPrice: 100,
      exitPrice: 110,
      pnl: 10,
      quantity: 1,
    });

    enforcer.addExpectedTrade(trade);
    // Same trade data, different ID for actual
    const actual = createTrade({
      symbol: 'BTC/USD',
      entryTime: (now + 100) as Timestamp,
      entryPrice: 100,
      exitPrice: 110,
      pnl: 10,
      quantity: 1,
    });
    const report = enforcer.addActualTrade(actual);

    expect(report).not.toBeNull();
    expect(report!.drift).toBe(false);
    expect(report!.actionTaken).toBe('none');
  });

  it('detects drift and triggers auto-response', () => {
    const now = Date.now() as Timestamp;
    // Big PnL deviation → HIGH → stop_trading
    const expected = createTrade({
      symbol: 'BTC/USD',
      entryTime: now as Timestamp,
      pnl: 1000,
    });
    const actual = createTrade({
      symbol: 'BTC/USD',
      entryTime: (now + 1000) as Timestamp,
      pnl: 500, // 50% PnL deviation, way above 2% threshold
    });

    enforcer.addExpectedTrade(expected);
    const report = enforcer.addActualTrade(actual);

    expect(report).not.toBeNull();
    expect(report!.drift).toBe(true);
    expect(report!.severity).toBe('HIGH');
    expect(report!.actionTaken).toBe('stop_trading');
  });

  it('halts after stop_trading is triggered', () => {
    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp, pnl: 1000 });
    const actual = createTrade({
      symbol: 'BTC/USD',
      entryTime: (now + 1000) as Timestamp,
      pnl: 500,
    });

    enforcer.addExpectedTrade(expected);
    enforcer.addActualTrade(actual);

    expect(enforcer.isHalted()).toBe(true);

    // New trades after halt
    const newTrade = createTrade({ symbol: 'BTC/USD', entryTime: (now + 5000) as Timestamp });
    const haltedReport = enforcer.addActualTrade(newTrade);

    expect(haltedReport).not.toBeNull();
    expect(haltedReport!.severity).toBe('HIGH');
    expect(haltedReport!.reason).toContain('halted');
  });

  it('reset clears halted state and trade data', () => {
    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp, pnl: 1000 });
    const actual = createTrade({
      symbol: 'BTC/USD',
      entryTime: (now + 1000) as Timestamp,
      pnl: 500,
    });

    enforcer.addExpectedTrade(expected);
    enforcer.addActualTrade(actual);
    expect(enforcer.isHalted()).toBe(true);

    enforcer.reset();
    expect(enforcer.isHalted()).toBe(false);
  });

  it('config can be updated at runtime', () => {
    const original = enforcer.getConfig();
    enforcer.updateConfig({ rollingWindowSize: 100 });
    expect(enforcer.getConfig().rollingWindowSize).toBe(100);
    expect(enforcer.getConfig().thresholds).toEqual(original.thresholds);
  });

  it('returns null metrics when window not full', () => {
    expect(enforcer.getMetrics()).toBeNull();
  });

  it('calls onDrift listener when drift detected', () => {
    let receivedReport: DriftReport | null = null;
    enforcer.onDrift(report => {
      receivedReport = report;
    });

    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp, pnl: 1000 });
    const actual = createTrade({
      symbol: 'BTC/USD',
      entryTime: (now + 1000) as Timestamp,
      pnl: 500,
    });

    enforcer.addExpectedTrade(expected);
    enforcer.addActualTrade(actual);

    expect(receivedReport).not.toBeNull();
    expect(receivedReport!.drift).toBe(true);
  });

  it('calls onAction handler when drift triggers response', async () => {
    let actionCalled = false;
    enforcer.onAction(() => {
      actionCalled = true;
    });

    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp, pnl: 1000 });
    const actual = createTrade({
      symbol: 'BTC/USD',
      entryTime: (now + 1000) as Timestamp,
      pnl: 500,
    });

    enforcer.addExpectedTrade(expected);
    enforcer.addActualTrade(actual);

    // Allow async handler to fire
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(actionCalled).toBe(true);
  });

  it('check() returns no-drift report when no new matches', () => {
    const report = enforcer.check();
    expect(report.drift).toBe(false);
    expect(report.actionTaken).toBe('none');
  });
});
