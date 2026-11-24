/**
 * The declared check rounds on one run, from its node outcomes, loop events and result: each
 * round's verdict through the view's declared returns and approvals, the outcome and summary of
 * the step that decided it, and the steps that recorded an outcome in it. A loop-form source
 * reads the loop's iterations (`roundFacts`); a stage-form one reads the run as one round
 * (`stageRoundFacts`), and an item's stage rounds are gathered across its runs
 * (`stageRoundsOf`). Split from `factory-items.ts`, which owns the shapes these fill.
 */
import { z } from 'zod';
import type {
  FactoryItemProgress,
  FactoryRound,
  FactoryRoundVerdict,
  FactoryRunFacts,
} from './factory-items';
import { resolveJsonPointer } from './json-pointer';
import type { JsonValue } from './output-ref';
import {
  isLoopRounds,
  roundsSources,
  type FactoryStageRounds,
  type FactoryView,
} from './schemas/factory-view';
import { isTerminalRunStatus } from './schemas/run-status';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';
import { getTerminalRecord, type buildNodeOutcomes } from './terminal-record';

const loopRowSchema = z.object({
  iteration: z.number().int().positive(),
  maxIterations: z.number().int().positive().optional(),
});

/** The structured output's `outcome`, when the output is an object that has one. */
function outputOutcome(output: unknown): unknown {
  return typeof output === 'object' && output !== null && 'outcome' in output
    ? output.outcome
    : undefined;
}

/** The structured output's `summary` when it is a string; null otherwise. */
function outputSummary(output: unknown): string | null {
  const summary =
    typeof output === 'object' && output !== null && 'summary' in output
      ? output.summary
      : undefined;
  return typeof summary === 'string' ? summary : null;
}

export type Outcomes = ReturnType<typeof buildNodeOutcomes>['nodes'];
/** A declared return or approval: a step, and the outcome it records that decides. */
export type DecisionPoint = NonNullable<FactoryView['returns']>[number];
/** The declared returns and approvals of one workflow. */
interface DecisionPoints {
  returns: readonly DecisionPoint[];
  approves: readonly DecisionPoint[];
}

/** The entries in which `point`'s step recorded `point`'s outcome. */
export function decidedIn(outcomes: Outcomes, point: DecisionPoint): Outcomes {
  return outcomes.filter(
    entry => entry.node_id === point.node && outputOutcome(entry.output) === point.outcome
  );
}

/** The loop's rounds as its own events record them: each started round's bound, and those that completed. */
function loopRows(
  loop: string,
  events: readonly WorkflowEventRow[]
): { started: Map<number, number | undefined>; completed: Set<number> } {
  const started = new Map<number, number | undefined>();
  const completed = new Set<number>();
  for (const row of events) {
    if (row.step_name !== loop) continue;
    const parsed = loopRowSchema.safeParse(row.data);
    if (!parsed.success) continue;
    if (row.event_type === 'loop_iteration_started')
      started.set(parsed.data.iteration, parsed.data.maxIterations);
    else if (row.event_type === 'loop_iteration_completed') completed.add(parsed.data.iteration);
  }
  return { started, completed };
}

/** The rounds of `loop` an entry ran in. */
function iterationsIn(entry: Outcomes[number], loop: string): number[] {
  return entry.loop_group_path?.filter(frame => frame.groupId === loop).map(f => f.iteration) ?? [];
}

/**
 * What the loop's declared return and approval steps decided in each round, with that
 * step's summary. Outcomes are in recording order, so the last one recorded in a round is
 * that round's decision.
 */
function roundDecisions(
  loop: string,
  points: readonly DecisionPoint[],
  outcomes: Outcomes
): Map<number, { outcome: string; summary: string | null }> {
  const nodes = new Set(points.map(point => point.node));
  const decided = new Map<number, { outcome: string; summary: string | null }>();
  for (const entry of outcomes) {
    const outcome = outputOutcome(entry.output);
    if (!nodes.has(entry.node_id) || typeof outcome !== 'string') continue;
    for (const iteration of iterationsIn(entry, loop))
      decided.set(iteration, { outcome, summary: outputSummary(entry.output) });
  }
  return decided;
}

/**
 * The loop's steps that recorded a structured `outcome` in each round, in recording order,
 * the last entry per step and round kept. The loop's own node is not one of its steps.
 */
function roundSteps(
  loop: string,
  outcomes: Outcomes
): Map<number, Map<string, FactoryRound['steps'][number]>> {
  const steps = new Map<number, Map<string, FactoryRound['steps'][number]>>();
  for (const entry of outcomes) {
    const outcome = outputOutcome(entry.output);
    if (!entry.node_id.startsWith(`${loop}.`) || typeof outcome !== 'string') continue;
    for (const iteration of iterationsIn(entry, loop)) {
      const round = steps.get(iteration) ?? new Map<string, FactoryRound['steps'][number]>();
      round.set(entry.node_id, {
        node: entry.node_id,
        outcome,
        summary: outputSummary(entry.output),
      });
      steps.set(iteration, round);
    }
  }
  return steps;
}

function roundFacts(
  loop: string,
  points: DecisionPoints,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[],
  outcomes: Outcomes
): NonNullable<FactoryRunFacts['rounds']> {
  const { started, completed } = loopRows(loop, events);
  const inLoop = (list: readonly DecisionPoint[]): DecisionPoint[] =>
    list.filter(point => point.node.startsWith(`${loop}.`));
  const roundsDecided = (list: readonly DecisionPoint[]): Set<number> =>
    new Set(
      inLoop(list).flatMap(point =>
        decidedIn(outcomes, point).flatMap(entry => iterationsIn(entry, loop))
      )
    );
  const decided = roundDecisions(loop, inLoop([...points.returns, ...points.approves]), outcomes);
  const steps = roundSteps(loop, outcomes);
  const returnedIn = roundsDecided(points.returns);
  const approvedIn = roundsDecided(points.approves);
  const unfinished = isTerminalRunStatus(run.status) ? ('stopped' as const) : ('running' as const);
  const verdict = (iteration: number): FactoryRoundVerdict => {
    if (returnedIn.has(iteration)) return 'returned';
    if (approvedIn.has(iteration)) return 'approved';
    // A round is approved only by a declared approval; one that completed without it needs a decision.
    return completed.has(iteration) ? 'undecided' : unfinished;
  };
  const iterations = [...started.keys()].sort((a, b) => a - b);
  const rounds = iterations.map(
    (iteration): FactoryRound => ({
      iteration,
      verdict: verdict(iteration),
      outcome: decided.get(iteration)?.outcome ?? null,
      summary: decided.get(iteration)?.summary ?? null,
      steps: [...(steps.get(iteration)?.values() ?? [])],
    })
  );
  const last = iterations.at(-1);
  return { max: (last === undefined ? undefined : started.get(last)) ?? null, rounds };
}

/** A positive whole number at `pointer` in `value`; null otherwise. */
function countAt(value: unknown, pointer: string): number | null {
  const found = resolveJsonPointer(value as JsonValue, pointer);
  return typeof found === 'number' && Number.isInteger(found) && found > 0 ? found : null;
}

/**
 * A stage-form run as its one round: numbered and bounded by its own result, so only a run that
 * completed with a result naming a positive whole round is one; null for any other run. Its
 * verdict is the loop form's, read over the whole run; its steps are every step that recorded a
 * structured outcome but the one that returns the result, which restates the decision.
 */
function stageRoundFacts(
  source: FactoryStageRounds,
  points: DecisionPoints,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[],
  outcomes: Outcomes
): NonNullable<FactoryRunFacts['rounds']> | null {
  if (run.status !== 'completed') return null;
  const record = getTerminalRecord(run.status, events);
  if (record?.returns.availability !== 'available') return null;
  const iteration = countAt(record.returns.value, source.round);
  if (iteration === null) return null;
  const returnsNode = record.returns.node_id;
  const decides = (list: readonly DecisionPoint[]): boolean =>
    list.some(point => decidedIn(outcomes, point).length > 0);
  const verdict: FactoryRoundVerdict = decides(points.returns)
    ? 'returned'
    : decides(points.approves)
      ? 'approved'
      : 'undecided';
  const deciders = new Set([...points.returns, ...points.approves].map(point => point.node));
  let decided: { outcome: string; summary: string | null } | undefined;
  const steps = new Map<string, FactoryRound['steps'][number]>();
  for (const entry of outcomes) {
    const outcome = outputOutcome(entry.output);
    if (typeof outcome !== 'string') continue;
    const summary = outputSummary(entry.output);
    if (deciders.has(entry.node_id)) decided = { outcome, summary };
    if (entry.node_id !== returnsNode)
      steps.set(entry.node_id, { node: entry.node_id, outcome, summary });
  }
  return {
    max: countAt(record.returns.value, source.allowance),
    rounds: [
      {
        iteration,
        verdict,
        outcome: decided?.outcome ?? null,
        summary: decided?.summary ?? null,
        steps: [...steps.values()],
      },
    ],
  };
}

/**
 * An item's stage-form rounds: its runs' rounds (newest first, each a run's one round), taken
 * while each older round is numbered below the one after it, so the rounds since the item was
 * last planned and no earlier cycle's, as the pack numbered them. Oldest first; empty when no
 * run recorded a round.
 */
function stageRoundsOf(
  newestFirst: readonly { runId: string; rounds: FactoryRunFacts['rounds'] }[]
): { runId: string; max: number | null; round: FactoryRound }[] {
  const taken: { runId: string; max: number | null; round: FactoryRound }[] = [];
  for (const { runId, rounds } of newestFirst) {
    const round = rounds?.rounds.at(-1);
    if (rounds === null || round === undefined) continue;
    const after = taken.at(-1);
    if (after !== undefined && round.iteration >= after.round.iteration) break;
    taken.push({ runId, max: rounds.max, round });
  }
  return taken.reverse();
}

/** The run's check rounds, read by the rounds source naming its workflow; null when none does. */
export function runRounds(
  view: FactoryView,
  workflow: string | null,
  points: DecisionPoints,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[],
  outcomes: Outcomes
): FactoryRunFacts['rounds'] {
  const source = roundsSources(view).find(entry => entry.workflow === workflow);
  if (source === undefined) return null;
  return isLoopRounds(source)
    ? roundFacts(source.loop, points, run, events, outcomes)
    : stageRoundFacts(source, points, run, events, outcomes);
}

/**
 * The item's rounds, from the rounds source of the newest declared run that recorded one: the
 * loop on that run, or the stage rounds gathered across the runs of its workflow.
 */
export function itemRound(
  view: FactoryView,
  declared: readonly WorkflowRun[],
  facts: ReadonlyMap<string, FactoryRunFacts>,
  /** The workflow the view declares a run is (`declaredWorkflow`). */
  workflowOf: (run: WorkflowRun) => string | null
): FactoryItemProgress['round'] {
  const newestFirst = [...declared].reverse();
  // The board's contract: each round's verdict and decision, not its steps.
  const board = (
    rounds: readonly FactoryRound[]
  ): NonNullable<FactoryItemProgress['round']>['rounds'] =>
    rounds.map(({ iteration, verdict, outcome }) => ({ iteration, verdict, outcome }));
  for (const run of newestFirst) {
    const rounds = facts.get(run.id)?.rounds;
    const last = rounds?.rounds.at(-1);
    if (rounds == null || last === undefined) continue;
    const workflow = workflowOf(run);
    const source = roundsSources(view).find(entry => entry.workflow === workflow);
    if (source === undefined || isLoopRounds(source))
      return {
        runId: run.id,
        iteration: last.iteration,
        max: rounds.max,
        rounds: board(rounds.rounds),
      };
    const taken = stageRoundsOf(
      newestFirst
        .filter(other => workflowOf(other) === workflow)
        .map(other => ({ runId: other.id, rounds: facts.get(other.id)?.rounds ?? null }))
    );
    const newest = taken.at(-1);
    if (newest === undefined) return null;
    return {
      runId: newest.runId,
      iteration: newest.round.iteration,
      max: newest.max,
      rounds: board(taken.map(entry => entry.round)),
    };
  }
  return null;
}
