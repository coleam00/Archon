/**
 * Run budget (#2814): a run-wide ceiling on work units and provider spend.
 *
 * One work unit is one started attempt of an `agent` or `exec` node. Spend is the
 * provider-reported cost of `agent` attempts; `exec` attempts cost a known zero. A
 * cost the engine cannot prove (not reported, partial, invalid, or an attempt that
 * never finished) is unavailable, never zero: a spend-limited run fails on it.
 *
 * The ledger is rebuilt from the run's own durable rows on every pass
 * (`foldDagResumeSnapshot`), so a resumed run continues from the same totals.
 */
import type { WorkflowRunBudget } from './schemas/workflow';
import type { NodeExecutionMetadata } from './schemas/node-execution';

export const RUN_BUDGET_WORK_UNIT_EVENT_TYPE = 'run_budget_work_unit';
export const RUN_BUDGET_REFUSED_EVENT_TYPE = 'run_budget_refused';

/** The durable record of one admitted work unit; written before the attempt starts. */
export interface RunBudgetWorkUnitEvent {
  workflow_run_id: string;
  step_name: string;
  event_type: typeof RUN_BUDGET_WORK_UNIT_EVENT_TYPE;
  data: Record<string, never>;
}

export function runBudgetWorkUnitEvent(runId: string, path: string): RunBudgetWorkUnitEvent {
  return {
    workflow_run_id: runId,
    step_name: path,
    event_type: RUN_BUDGET_WORK_UNIT_EVENT_TYPE,
    data: {},
  };
}

/** Why an `agent` attempt's cost is unknown: the measurement's own reason, or the budget's. */
export type CostUnavailableReason =
  | Exclude<
      Extract<NodeExecutionMetadata['spend']['costUsd'], { source: 'unavailable' }>['reason'],
      'not_applicable'
    >
  | 'partial'
  | 'interrupted';

export interface RunBudgetUsage {
  workUnits: number;
  spendUsd: number;
  /** The first `agent` attempt whose cost could not be proven. */
  costUnavailable?: { path: string; reason: CostUnavailableReason };
}

export function emptyRunBudgetUsage(): RunBudgetUsage {
  return { workUnits: 0, spendUsd: 0 };
}

export type AttemptSpend =
  | { kind: 'known'; usd: number }
  | { kind: 'unavailable'; reason: CostUnavailableReason };

/** The single spend rule for an `agent` attempt, used live and by the resume fold. */
export function attemptSpend(execution: NodeExecutionMetadata | undefined): AttemptSpend {
  if (execution === undefined) return { kind: 'unavailable', reason: 'unknown' };
  const cost = execution.spend.costUsd;
  if (cost.source === 'unavailable') {
    // `not_applicable` records an attempt that made no provider call: it failed before a
    // provider was bound or before the bound provider was called. Its cost is a known zero.
    return cost.reason === 'not_applicable'
      ? { kind: 'known', usd: 0 }
      : { kind: 'unavailable', reason: cost.reason };
  }
  if (!Number.isFinite(cost.value) || cost.value < 0) {
    return { kind: 'unavailable', reason: 'invalid' };
  }
  if (cost.partial === true) return { kind: 'unavailable', reason: 'partial' };
  return { kind: 'known', usd: cost.value };
}

/** Folds one finished `agent` attempt's spend into `usage`. */
export function addAttemptSpend(
  usage: RunBudgetUsage,
  path: string,
  execution: NodeExecutionMetadata | undefined
): AttemptSpend {
  const spend = attemptSpend(execution);
  if (spend.kind === 'known') usage.spendUsd += spend.usd;
  else usage.costUnavailable ??= { path, reason: spend.reason };
  return spend;
}

export type RunBudgetRefusal =
  | { reason: 'work_units_exhausted'; path: string; limit: number; consumed: number }
  | { reason: 'spend_exhausted'; path: string; limitUsd: number; consumedUsd: number }
  | {
      reason: 'cost_unavailable';
      /** The node that was refused, or whose settlement surfaced the unknown cost. */
      path: string;
      /** The attempt whose cost is unknown. */
      costPath: string;
      cause: CostUnavailableReason;
      consumedUsd: number;
      limitUsd: number;
    };

export class RunBudgetRefusedError extends Error {
  constructor(readonly refusal: RunBudgetRefusal) {
    super(`Run budget refused node '${refusal.path}': ${refusal.reason}`);
    this.name = 'RunBudgetRefusedError';
  }
}

export interface RunBudgetLedger {
  readonly limits: WorkflowRunBudget;
  /** Mutated in place as attempts are admitted and settled. */
  readonly usage: RunBudgetUsage;
}

export function createRunBudgetLedger(
  limits: WorkflowRunBudget,
  seed: RunBudgetUsage
): RunBudgetLedger {
  return { limits, usage: { ...seed } };
}

function costUnavailableRefusal(
  ledger: RunBudgetLedger,
  path: string
): RunBudgetRefusal | undefined {
  const { costUnavailable } = ledger.usage;
  const limitUsd = ledger.limits.max_spend_usd;
  if (limitUsd === undefined || costUnavailable === undefined) return undefined;
  return {
    reason: 'cost_unavailable',
    path,
    costPath: costUnavailable.path,
    cause: costUnavailable.reason,
    consumedUsd: ledger.usage.spendUsd,
    limitUsd,
  };
}

/**
 * Admit one attempt or say why not. Synchronous on purpose: the reservation happens
 * before the caller's first await, so parallel siblings cannot share the last unit.
 */
export function admitRunBudgetAttempt(
  ledger: RunBudgetLedger,
  path: string
): RunBudgetRefusal | undefined {
  const { limits, usage } = ledger;
  const unknownCost = costUnavailableRefusal(ledger, path);
  if (unknownCost !== undefined) return unknownCost;
  if (limits.max_work_units !== undefined && usage.workUnits >= limits.max_work_units) {
    return {
      reason: 'work_units_exhausted',
      path,
      limit: limits.max_work_units,
      consumed: usage.workUnits,
    };
  }
  if (limits.max_spend_usd !== undefined && usage.spendUsd >= limits.max_spend_usd) {
    return {
      reason: 'spend_exhausted',
      path,
      limitUsd: limits.max_spend_usd,
      consumedUsd: usage.spendUsd,
    };
  }
  usage.workUnits++;
  return undefined;
}

/** Charge a finished attempt; a spend-limited run is refused as soon as its cost is unknown. */
export function settleRunBudgetAttempt(
  ledger: RunBudgetLedger,
  kind: 'agent' | 'exec',
  path: string,
  execution: NodeExecutionMetadata | undefined
): RunBudgetRefusal | undefined {
  if (kind === 'exec') return undefined;
  const spend = addAttemptSpend(ledger.usage, path, execution);
  return spend.kind === 'unavailable' ? costUnavailableRefusal(ledger, path) : undefined;
}

/**
 * A run whose recorded spend is already unknown cannot prove a spend ceiling, so it is
 * refused before any node runs. Exhaustion is not refused here: the remaining nodes may
 * be gates, waits or halts, which do no work.
 */
export function runBudgetStartRefusal(ledger: RunBudgetLedger): RunBudgetRefusal | undefined {
  const costPath = ledger.usage.costUnavailable?.path;
  return costPath === undefined ? undefined : costUnavailableRefusal(ledger, costPath);
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

const COST_UNAVAILABLE_CAUSE: Record<CostUnavailableReason, string> = {
  not_reported:
    'its provider reported no cost (Claude reports none after resuming a session created by an earlier process, or for an attempt that failed with a provider error such as a rate limit)',
  unsupported: 'its provider does not report cost',
  unknown: 'its provider did not say whether it reports cost',
  invalid: 'its provider reported an invalid cost',
  incomplete: 'its cost record is incomplete',
  partial: 'only part of its provider calls reported cost',
  interrupted: 'the attempt never finished, so its cost was never reported',
};

export function describeRunBudgetRefusal(refusal: RunBudgetRefusal, workflowName: string): string {
  const fixed =
    "Resuming this run refuses again: the ceiling is fixed by the run's captured workflow source. Start a new run with a higher ceiling to continue.";
  switch (refusal.reason) {
    case 'work_units_exhausted':
      return `Workflow '${workflowName}' reached its run budget of ${String(refusal.limit)} work units (${String(refusal.consumed)} used); node '${refusal.path}' was not started. ${fixed}`;
    case 'spend_exhausted':
      return `Workflow '${workflowName}' reached its run budget of ${usd(refusal.limitUsd)} (${usd(refusal.consumedUsd)} spent); node '${refusal.path}' was not started. ${fixed}`;
    case 'cost_unavailable':
      return `Workflow '${workflowName}' declares max_spend_usd: ${String(refusal.limitUsd)}, but the cost of node '${refusal.costPath}' is unknown: ${COST_UNAVAILABLE_CAUSE[refusal.cause]}. ${usd(refusal.consumedUsd)} of known spend is a floor, so the ceiling cannot be enforced and no further work starts. A spend ceiling needs a complete cost for every attempt; use max_work_units alone where that cannot be guaranteed.`;
  }
}

export function runBudgetRefusalEventData(
  refusal: RunBudgetRefusal,
  limits: WorkflowRunBudget,
  usage: RunBudgetUsage
): Record<string, unknown> {
  return {
    reason: refusal.reason,
    node: refusal.path,
    limits,
    consumed: { work_units: usage.workUnits, spend_usd: usage.spendUsd },
    ...(usage.costUnavailable !== undefined
      ? {
          cost_unavailable: {
            node: usage.costUnavailable.path,
            reason: usage.costUnavailable.reason,
          },
        }
      : {}),
  };
}
