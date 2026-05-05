import { describe, it, expect } from 'bun:test';
import { AutoResponder } from '../auto-responder';
import type { ActionConfig, DriftAction, DriftReport, Severity, Timestamp } from '../types';

const defaultActions: ActionConfig = {
  LOW: 'alert',
  MEDIUM: 'reduce_position',
  HIGH: 'stop_trading',
};

function makeDriftReport(severity: Severity): DriftReport {
  return {
    drift: true,
    severity,
    reason: 'test',
    actionTaken: 'none',
    timestamp: Date.now() as Timestamp,
    tradeComparisons: [],
    rollingMetrics: null,
    flags: [],
  };
}

describe('AutoResponder', () => {
  it('maps LOW severity to alert', () => {
    const responder = new AutoResponder(defaultActions);
    expect(responder.getAction('LOW')).toBe('alert');
  });

  it('maps MEDIUM severity to reduce_position', () => {
    const responder = new AutoResponder(defaultActions);
    expect(responder.getAction('MEDIUM')).toBe('reduce_position');
  });

  it('maps HIGH severity to stop_trading', () => {
    const responder = new AutoResponder(defaultActions);
    expect(responder.getAction('HIGH')).toBe('stop_trading');
  });

  it('calls handler with correct arguments', async () => {
    let receivedAction: DriftAction | null = null;
    let receivedReport: DriftReport | null = null;

    const responder = new AutoResponder(defaultActions, (action, report) => {
      receivedAction = action;
      receivedReport = report;
    });

    const report = makeDriftReport('MEDIUM');
    await responder.respond('MEDIUM', report);

    expect(receivedAction).not.toBeNull();
    expect(receivedAction!).toBe('reduce_position');
    expect(receivedReport).not.toBeNull();
    expect(receivedReport!).toEqual(report);
  });

  it('does not crash when handler throws', async () => {
    const responder = new AutoResponder(defaultActions, () => {
      throw new Error('handler error');
    });

    const report = makeDriftReport('LOW');
    const action = await responder.respond('LOW', report);
    expect(action).toBe('alert');
  });

  it('works without a handler', async () => {
    const responder = new AutoResponder(defaultActions);
    const report = makeDriftReport('MEDIUM');
    const action = await responder.respond('MEDIUM', report);
    expect(action).toBe('reduce_position');
  });

  it('sets halted state on stop_trading', async () => {
    const responder = new AutoResponder(defaultActions);
    expect(responder.isHalted()).toBe(false);

    const report = makeDriftReport('HIGH');
    await responder.respond('HIGH', report);

    expect(responder.isHalted()).toBe(true);
  });

  it('allows setting handler after construction', async () => {
    const responder = new AutoResponder(defaultActions);
    let called = false;

    responder.onAction(() => {
      called = true;
    });

    const report = makeDriftReport('LOW');
    await responder.respond('LOW', report);
    expect(called).toBe(true);
  });

  it('resetHalt clears halted state', async () => {
    const responder = new AutoResponder(defaultActions);
    const report = makeDriftReport('HIGH');
    await responder.respond('HIGH', report);
    expect(responder.isHalted()).toBe(true);

    responder.resetHalt();
    expect(responder.isHalted()).toBe(false);
  });

  it('halt() sets halted state without invoking handler', () => {
    let handlerCalled = false;
    const responder = new AutoResponder(defaultActions, () => {
      handlerCalled = true;
    });

    responder.halt();
    expect(responder.isHalted()).toBe(true);
    expect(handlerCalled).toBe(false);
  });

  it('calls onError handler when action handler throws', async () => {
    const handlerError = new Error('handler broke');
    let receivedError: unknown = null;
    let receivedAction: DriftAction | null = null;

    const responder = new AutoResponder(defaultActions, () => {
      throw handlerError;
    });
    responder.onError((error, action) => {
      receivedError = error;
      receivedAction = action;
    });

    const report = makeDriftReport('LOW');
    await responder.respond('LOW', report);

    expect(receivedError).toBe(handlerError);
    expect(receivedAction).toBe('alert');
  });

  it('does not crash when onError handler itself throws', async () => {
    const responder = new AutoResponder(defaultActions, () => {
      throw new Error('handler error');
    });
    responder.onError(() => {
      throw new Error('error handler also broken');
    });

    const report = makeDriftReport('LOW');
    const action = await responder.respond('LOW', report);
    expect(action).toBe('alert');
  });
});
