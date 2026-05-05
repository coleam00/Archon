import type { Trade, TradeId } from './types';

export class TradeStore {
  private readonly expected = new Map<TradeId, Trade>();
  private readonly actual = new Map<TradeId, Trade>();
  private readonly matchedPairs: { expected: Trade; actual: Trade }[] = [];
  private readonly matchedExpectedIds = new Set<TradeId>();
  private readonly matchedActualIds = new Set<TradeId>();
  private readonly toleranceMs: number;

  constructor(toleranceMs = 60_000) {
    this.toleranceMs = toleranceMs;
  }

  addExpectedTrade(trade: Trade): void {
    this.expected.set(trade.id, trade);
  }

  addActualTrade(trade: Trade): void {
    this.actual.set(trade.id, trade);
    this.tryMatch(trade);
  }

  private tryMatch(actualTrade: Trade): void {
    if (this.matchedActualIds.has(actualTrade.id)) return;

    let bestMatch: Trade | null = null;
    let bestTimeDiff = Infinity;

    for (const [id, expectedTrade] of this.expected) {
      if (this.matchedExpectedIds.has(id)) continue;
      if (expectedTrade.symbol !== actualTrade.symbol) continue;

      const timeDiff = Math.abs(actualTrade.entryTime - expectedTrade.entryTime);
      if (timeDiff <= this.toleranceMs && timeDiff < bestTimeDiff) {
        bestMatch = expectedTrade;
        bestTimeDiff = timeDiff;
      }
    }

    if (bestMatch) {
      this.matchedExpectedIds.add(bestMatch.id);
      this.matchedActualIds.add(actualTrade.id);
      this.matchedPairs.push({ expected: bestMatch, actual: actualTrade });
    }
  }

  getUnmatchedPairs(): { expected: Trade; actual: Trade }[] {
    // Return newly matched pairs that haven't been processed yet
    // For simplicity, return all matched pairs (caller tracks what's new)
    return [...this.matchedPairs];
  }

  getExpectedTrades(symbol?: string): Trade[] {
    const trades = [...this.expected.values()];
    return symbol ? trades.filter(t => t.symbol === symbol) : trades;
  }

  getActualTrades(symbol?: string): Trade[] {
    const trades = [...this.actual.values()];
    return symbol ? trades.filter(t => t.symbol === symbol) : trades;
  }

  getMatchedPairs(): { expected: Trade; actual: Trade }[] {
    return [...this.matchedPairs];
  }

  clear(): void {
    this.expected.clear();
    this.actual.clear();
    this.matchedPairs.length = 0;
    this.matchedExpectedIds.clear();
    this.matchedActualIds.clear();
  }

  size(): { expected: number; actual: number; matched: number } {
    return {
      expected: this.expected.size,
      actual: this.actual.size,
      matched: this.matchedPairs.length,
    };
  }
}
