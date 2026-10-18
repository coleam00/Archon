// @archon-test-isolated
import { describe, expect, it } from 'bun:test';
import {
  admitRunBudgetAttempt,
  createRunBudgetLedger,
  describeRunBudgetRefusal,
  emptyRunBudgetUsage,
  runBudgetStartRefusal,
  settleRunBudgetAttempt,
} from './run-budget';
import {
  executionMetadata,
  finishNodeExecution,
  newNodeInvocation,
  startNodeExecution,
} from './node-execution';
import type { NodeExecutionMetadata } from './schemas/node-execution';

function agentAttempt(observations: {
  costUsd?: number;
  costPartial?: boolean;
}): NodeExecutionMetadata {
  const start = startNodeExecution({
    runId: 'run-1',
    path: 'a',
    node: { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
    invocation: newNodeInvocation(),
    provider: 'claude',
  });
  return executionMetadata(finishNodeExecution(start, { status: 'completed' }, observations));
}

function unsupportedCostAttempt(): NodeExecutionMetadata {
  const attempt = agentAttempt({});
  return {
    ...attempt,
    spend: { ...attempt.spend, costUsd: { source: 'unavailable', reason: 'unsupported' } },
  };
}

describe('admitRunBudgetAttempt', () => {
  it('reserves synchronously, so the last unit goes to exactly one sibling', () => {
    const ledger = createRunBudgetLedger({ max_work_units: 2 }, emptyRunBudgetUsage());
    expect(admitRunBudgetAttempt(ledger, 'a')).toBeUndefined();
    expect(admitRunBudgetAttempt(ledger, 'b')).toBeUndefined();
    expect(admitRunBudgetAttempt(ledger, 'c')).toEqual({
      reason: 'work_units_exhausted',
      path: 'c',
      limit: 2,
      consumed: 2,
    });
    expect(ledger.usage.workUnits).toBe(2);
  });

  it('refuses once spend reaches the ceiling, and refuses unknown spend first', () => {
    const ledger = createRunBudgetLedger(
      { max_work_units: 10, max_spend_usd: 1 },
      { workUnits: 10, spendUsd: 1.2 }
    );
    expect(admitRunBudgetAttempt(ledger, 'b')?.reason).toBe('work_units_exhausted');

    const spent = createRunBudgetLedger({ max_spend_usd: 1 }, { workUnits: 2, spendUsd: 1 });
    expect(admitRunBudgetAttempt(spent, 'b')?.reason).toBe('spend_exhausted');

    const unknown = createRunBudgetLedger(
      { max_work_units: 1, max_spend_usd: 1 },
      { workUnits: 1, spendUsd: 0, costUnavailable: { path: 'a', reason: 'not_reported' } }
    );
    expect(admitRunBudgetAttempt(unknown, 'b')).toMatchObject({
      reason: 'cost_unavailable',
      path: 'b',
      costPath: 'a',
      cause: 'not_reported',
    });
  });
});

describe('settleRunBudgetAttempt', () => {
  it('charges a finite reported cost and nothing for exec attempts', () => {
    const ledger = createRunBudgetLedger({ max_spend_usd: 1 }, emptyRunBudgetUsage());
    expect(settleRunBudgetAttempt(ledger, 'agent', 'a', agentAttempt({ costUsd: 0.25 }))).toBe(
      undefined
    );
    expect(settleRunBudgetAttempt(ledger, 'exec', 'b', undefined)).toBeUndefined();
    expect(ledger.usage).toEqual({ workUnits: 0, spendUsd: 0.25 });
  });

  it('charges nothing for an attempt that failed before any provider was bound', () => {
    const ledger = createRunBudgetLedger({ max_spend_usd: 1 }, emptyRunBudgetUsage());
    const preProvider = executionMetadata(
      finishNodeExecution(
        startNodeExecution({
          runId: 'run-1',
          path: 'a',
          node: { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
          invocation: newNodeInvocation(),
        }),
        { status: 'failed', error: 'unknown provider', failureKind: 'config' }
      )
    );
    expect(settleRunBudgetAttempt(ledger, 'agent', 'a', preProvider)).toBeUndefined();
    expect(ledger.usage).toEqual({ workUnits: 0, spendUsd: 0 });
  });

  it.each([
    ['unreported', agentAttempt({}), 'unknown'],
    ['unsupported', unsupportedCostAttempt(), 'unsupported'],
    ['partial', agentAttempt({ costUsd: 0.2, costPartial: true }), 'partial'],
    ['negative', agentAttempt({ costUsd: -1 }), 'invalid'],
    ['missing execution', undefined, 'unknown'],
  ] as const)('treats a %s cost as unknown, never as zero', (_label, execution, cause) => {
    const spendLimited = createRunBudgetLedger({ max_spend_usd: 5 }, emptyRunBudgetUsage());
    expect(settleRunBudgetAttempt(spendLimited, 'agent', 'a', execution)).toMatchObject({
      reason: 'cost_unavailable',
      cause,
    });
    expect(spendLimited.usage.spendUsd).toBe(0);

    // Without a spend ceiling the unknown cost is recorded but does not refuse.
    const unitsOnly = createRunBudgetLedger({ max_work_units: 5 }, emptyRunBudgetUsage());
    expect(settleRunBudgetAttempt(unitsOnly, 'agent', 'a', execution)).toBeUndefined();
    expect(unitsOnly.usage.costUnavailable).toEqual({ path: 'a', reason: cause });
  });
});

describe('runBudgetStartRefusal', () => {
  it('refuses a spend-limited run whose recorded spend is unknown, not an exhausted one', () => {
    const unknown = {
      workUnits: 1,
      spendUsd: 0,
      costUnavailable: { path: 'a', reason: 'interrupted' },
    } as const;
    expect(
      runBudgetStartRefusal(createRunBudgetLedger({ max_spend_usd: 1 }, unknown))
    ).toMatchObject({ reason: 'cost_unavailable', cause: 'interrupted' });
    expect(runBudgetStartRefusal(createRunBudgetLedger({ max_work_units: 1 }, unknown))).toBe(
      undefined
    );
    expect(
      runBudgetStartRefusal(
        createRunBudgetLedger({ max_spend_usd: 1 }, { workUnits: 3, spendUsd: 9 })
      )
    ).toBeUndefined();
  });
});

describe('describeRunBudgetRefusal', () => {
  it('states units as counts and spend in dollars, and names the refused node', () => {
    const units = describeRunBudgetRefusal(
      { reason: 'work_units_exhausted', path: 'c', limit: 2, consumed: 2 },
      'wf'
    );
    expect(units).toContain('2 work units');
    expect(units).toContain("node 'c' was not started");
    expect(units).not.toContain('$');

    const spend = describeRunBudgetRefusal(
      { reason: 'spend_exhausted', path: 'c', limitUsd: 1, consumedUsd: 1.2 },
      'wf'
    );
    expect(spend).toContain('$1.0000');
    expect(spend).toContain('$1.2000');

    const unknown = describeRunBudgetRefusal(
      {
        reason: 'cost_unavailable',
        path: 'b',
        costPath: 'a',
        cause: 'partial',
        consumedUsd: 0.2,
        limitUsd: 1,
      },
      'wf'
    );
    expect(unknown).toContain("node 'a' is unknown");
    expect(unknown).toContain('max_work_units');
  });
});
