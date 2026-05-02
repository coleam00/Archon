import type {
  ActionHandler,
  DriftReport,
  EnforcerConfig,
  RollingDriftMetrics,
  Trade,
  TradeComparison,
  TradeFlag,
} from './types';
import { validateConfig, mergeConfig } from './config';
import { TradeStore } from './trade-store';
import { compareTrades } from './comparison-engine';
import { flagComparison, flagRollingDrift, determineSeverity } from './threshold-flagger';
import { computeRollingDrift } from './rolling-drift';
import { AutoResponder } from './auto-responder';

export class ParityEnforcer {
  private config: EnforcerConfig;
  private store: TradeStore;
  private responder: AutoResponder;
  private lastMatchedCount = 0;
  private driftListeners: ((report: DriftReport) => void)[] = [];

  constructor(config?: Partial<EnforcerConfig>) {
    this.config = validateConfig(config ?? {});
    this.store = new TradeStore();
    this.responder = new AutoResponder(this.config.actions);
  }

  addExpectedTrade(trade: Trade): void {
    this.store.addExpectedTrade(trade);
  }

  addActualTrade(trade: Trade): DriftReport | null {
    this.store.addActualTrade(trade);

    if (this.responder.isHalted()) {
      const report = this.buildHaltedReport();
      this.emitDrift(report);
      return report;
    }

    const pairs = this.store.getMatchedPairs();
    if (pairs.length === this.lastMatchedCount) {
      return null;
    }

    const newPairs = pairs.slice(this.lastMatchedCount);
    this.lastMatchedCount = pairs.length;

    return this.processNewPairs(newPairs, pairs);
  }

  check(): DriftReport {
    if (this.responder.isHalted()) {
      return this.buildHaltedReport();
    }

    const pairs = this.store.getMatchedPairs();
    if (pairs.length === 0) {
      return this.buildNoDriftReport();
    }

    const newPairs = pairs.slice(this.lastMatchedCount);
    this.lastMatchedCount = pairs.length;

    if (newPairs.length === 0) {
      return this.buildNoDriftReport();
    }

    return this.processNewPairs(newPairs, pairs);
  }

  onAction(handler: ActionHandler): void {
    this.responder.onAction(handler);
  }

  onDrift(handler: (report: DriftReport) => void): void {
    this.driftListeners.push(handler);
  }

  getMetrics(): RollingDriftMetrics | null {
    const pairs = this.store.getMatchedPairs();
    return computeRollingDrift(
      pairs.map(p => p.expected),
      pairs.map(p => p.actual),
      this.config.rollingWindowSize
    );
  }

  getConfig(): EnforcerConfig {
    return this.config;
  }

  isHalted(): boolean {
    return this.responder.isHalted();
  }

  reset(): void {
    this.store.clear();
    this.lastMatchedCount = 0;
    this.responder.resetHalt();
  }

  updateConfig(overrides: Partial<EnforcerConfig>): void {
    this.config = mergeConfig(this.config, overrides);
    this.responder = new AutoResponder(this.config.actions);
  }

  private processNewPairs(
    newPairs: { expected: Trade; actual: Trade }[],
    allPairs: { expected: Trade; actual: Trade }[]
  ): DriftReport {
    const comparisons = compareTrades(newPairs);

    const allFlags: TradeFlag[] = [];
    const flaggedComparisons: TradeComparison[] = comparisons.map(c => {
      const flags = flagComparison(c, this.config.thresholds);
      allFlags.push(...flags);
      return { ...c, flags };
    });

    const rollingMetrics = computeRollingDrift(
      allPairs.map(p => p.expected),
      allPairs.map(p => p.actual),
      this.config.rollingWindowSize
    );

    if (rollingMetrics) {
      const rollingFlags = flagRollingDrift(rollingMetrics, this.config.thresholds);
      allFlags.push(...rollingFlags);
    }

    const severity = allFlags.length > 0 ? determineSeverity(allFlags) : 'LOW';
    const drift = allFlags.length > 0;

    let actionTaken: DriftReport['actionTaken'] = 'none';
    if (drift) {
      // Synchronous wrapper — respond is async only for handler callback
      const action = this.responder.getAction(severity);
      if (action === 'stop_trading') {
        // Mark halted synchronously to prevent race
        void this.responder.respond(severity, null as unknown as DriftReport);
      }
      actionTaken = action;
    }

    const report: DriftReport = {
      drift,
      severity,
      reason: drift ? this.buildReason(allFlags) : 'No drift detected',
      actionTaken,
      timestamp: Date.now(),
      tradeComparisons: flaggedComparisons,
      rollingMetrics,
      flags: allFlags,
    };

    if (drift) {
      // Fire async handler (non-blocking)
      void this.responder.respond(severity, report);
      this.emitDrift(report);
    }

    return report;
  }

  private buildHaltedReport(): DriftReport {
    return {
      drift: true,
      severity: 'HIGH',
      reason: 'Trading halted — stop_trading was triggered',
      actionTaken: 'stop_trading',
      timestamp: Date.now(),
      tradeComparisons: [],
      rollingMetrics: null,
      flags: [],
    };
  }

  private buildNoDriftReport(): DriftReport {
    return {
      drift: false,
      severity: 'LOW',
      reason: 'No drift detected',
      actionTaken: 'none',
      timestamp: Date.now(),
      tradeComparisons: [],
      rollingMetrics: null,
      flags: [],
    };
  }

  private buildReason(flags: TradeFlag[]): string {
    if (flags.length === 1) return flags[0].message;
    return `${flags.length} drift flags detected: ${flags[0].message} (and ${flags.length - 1} more)`;
  }

  private emitDrift(report: DriftReport): void {
    for (const listener of this.driftListeners) {
      try {
        listener(report);
      } catch {
        // Listener errors never crash the enforcer
      }
    }
  }
}
