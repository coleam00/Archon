import { describe, it, expect, beforeEach } from 'bun:test';
import { TradeStore } from '../trade-store';
import { createTrade, resetIdCounter } from './helpers';
import type { Timestamp } from '../types';

describe('TradeStore', () => {
  let store: TradeStore;

  beforeEach(() => {
    store = new TradeStore(60_000); // 60s tolerance
    resetIdCounter();
  });

  it('stores expected and actual trades', () => {
    store.addExpectedTrade(createTrade());
    store.addActualTrade(createTrade());
    expect(store.size().expected).toBe(1);
    expect(store.size().actual).toBe(1);
  });

  it('matches trades by symbol and closest time within tolerance', () => {
    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp });
    const actual = createTrade({ symbol: 'BTC/USD', entryTime: (now + 5000) as Timestamp });

    store.addExpectedTrade(expected);
    store.addActualTrade(actual);

    const pairs = store.getMatchedPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].expected.id).toBe(expected.id);
    expect(pairs[0].actual.id).toBe(actual.id);
  });

  it('does not match trades outside tolerance window', () => {
    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp });
    const actual = createTrade({ symbol: 'BTC/USD', entryTime: (now + 120_000) as Timestamp });

    store.addExpectedTrade(expected);
    store.addActualTrade(actual);

    expect(store.getMatchedPairs()).toHaveLength(0);
  });

  it('does not cross-match different symbols', () => {
    const now = Date.now() as Timestamp;
    const expected = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp });
    const actual = createTrade({ symbol: 'ETH/USD', entryTime: now as Timestamp });

    store.addExpectedTrade(expected);
    store.addActualTrade(actual);

    expect(store.getMatchedPairs()).toHaveLength(0);
  });

  it('matches closest time when multiple expected trades exist', () => {
    const now = Date.now() as Timestamp;
    const expected1 = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp });
    const expected2 = createTrade({ symbol: 'BTC/USD', entryTime: (now + 30_000) as Timestamp });
    const actual = createTrade({ symbol: 'BTC/USD', entryTime: (now + 28_000) as Timestamp });

    store.addExpectedTrade(expected1);
    store.addExpectedTrade(expected2);
    store.addActualTrade(actual);

    const pairs = store.getMatchedPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].expected.id).toBe(expected2.id);
  });

  it('filters trades by symbol', () => {
    store.addExpectedTrade(createTrade({ symbol: 'BTC/USD' }));
    store.addExpectedTrade(createTrade({ symbol: 'ETH/USD' }));

    expect(store.getExpectedTrades('BTC/USD')).toHaveLength(1);
    expect(store.getExpectedTrades('ETH/USD')).toHaveLength(1);
    expect(store.getExpectedTrades()).toHaveLength(2);
  });

  it('clear removes all data', () => {
    store.addExpectedTrade(createTrade());
    store.addActualTrade(createTrade());
    store.clear();

    const size = store.size();
    expect(size.expected).toBe(0);
    expect(size.actual).toBe(0);
    expect(size.matched).toBe(0);
  });

  it('maintains matched pairs in insertion order', () => {
    const now = Date.now() as Timestamp;
    const e1 = createTrade({ symbol: 'BTC/USD', entryTime: now as Timestamp });
    const e2 = createTrade({ symbol: 'BTC/USD', entryTime: (now + 60_000) as Timestamp });
    const a1 = createTrade({ symbol: 'BTC/USD', entryTime: (now + 1000) as Timestamp });
    const a2 = createTrade({ symbol: 'BTC/USD', entryTime: (now + 61_000) as Timestamp });

    store.addExpectedTrade(e1);
    store.addExpectedTrade(e2);
    store.addActualTrade(a1);
    store.addActualTrade(a2);

    const pairs = store.getMatchedPairs();
    expect(pairs).toHaveLength(2);
    expect(pairs[0].expected.id).toBe(e1.id);
    expect(pairs[1].expected.id).toBe(e2.id);
  });
});
