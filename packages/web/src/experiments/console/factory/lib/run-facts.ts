/**
 * What one run contributes to its item's board card, from the run's record
 * (`GET /api/workflows/runs/records`): its deepest running step, its check rounds, how often
 * and why it sent the item back, and the change it named. Every name read here (steps,
 * outcomes, pointers into the run's result) comes from the pack's own declarations, through
 * the graph (`graph-view.ts`); nothing here names a pack's step or reads prose. Ported from v1 (`origin/main`, `factory/lib/run-facts.ts`).
 */
import type { RunRecord } from '../api';
import type { ChangeSource, DecisionPoint, FactoryWords, RoundsSource } from './graph-view';
import { valueAt } from './result-pointer';

type Outcomes = RunRecord['node_outcomes']['nodes'];

/**
 * How one check round ended: `returned` when a declared return point sent the item back,
 * `approved` when a declared approval approved it, `undecided` when it completed with
 * neither, `running` while it goes on, `stopped` when the run ended inside it.
 */
export type RoundVerdict = 'approved' | 'returned' | 'undecided' | 'running' | 'stopped';

export interface Round {
  iteration: number;
  verdict: RoundVerdict;
}

/** A run's check rounds and the bound its latest round recorded (null when none). */
export interface RunRounds {
  max: number | null;
  rounds: Round[];
}

/** The run as its item read gives it. */
export interface RunState {
  status: RunRecord['status'];
}

export interface RunFacts {
  /** The deepest running step; null when none runs. */
  active: string | null;
  rounds: RunRounds | null;
  /** Each time a declared return point sent the item back, with that step's own summary. */
  returns: { summary: string | null }[];
  /** The URL at the declared change pointer; null when the run names none. */
  change: string | null;
}

function field(output: unknown, name: string): unknown {
  return typeof output === 'object' && output !== null && name in output
    ? (output as Record<string, unknown>)[name]
    : undefined;
}
const outcomeOf = (output: unknown): unknown => field(output, 'outcome');
function summaryOf(output: unknown): string | null {
  const summary = field(output, 'summary');
  return typeof summary === 'string' && summary.trim() !== '' ? summary.trim() : null;
}

/** The entries in which `point`'s step recorded `point`'s outcome. */
function decidedIn(outcomes: Outcomes, point: DecisionPoint): Outcomes {
  return outcomes.filter(
    entry => entry.node_id === point.node && outcomeOf(entry.output) === point.outcome
  );
}

/** The rounds of `loop` an entry ran in. */
function iterationsIn(entry: Outcomes[number], loop: string): number[] {
  return entry.loop_group_path?.filter(f => f.groupId === loop).map(f => f.iteration) ?? [];
}

/** The deepest running step: most `.`-separated segments, ties to the latest started, then by id. */
function deepestRunning(running: readonly string[]): string | null {
  const depth = (step: string): number => step.split('.').length;
  const order = new Map(running.map((step, index) => [step, index]));
  const [deepest] = [...running].sort(
    (a, b) =>
      depth(b) - depth(a) || (order.get(b) ?? -1) - (order.get(a) ?? -1) || a.localeCompare(b)
  );
  return deepest ?? null;
}

interface Points {
  returns: DecisionPoint[];
  approves: DecisionPoint[];
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** A loop-form source's rounds: the loop's iterations, each decided by its declared points. */
function loopRounds(loop: string, points: Points, run: RunState, record: RunRecord): RunRounds {
  const outcomes = record.node_outcomes.nodes;
  const iterations = record.loop_iterations.filter(entry => entry.group === loop);
  const started = new Map(iterations.map(entry => [entry.iteration, entry.max]));
  const completed = new Set(iterations.filter(e => e.completed).map(e => e.iteration));
  const roundsDecided = (list: readonly DecisionPoint[]): Set<number> =>
    new Set(
      list
        .filter(point => point.node.startsWith(`${loop}.`))
        .flatMap(point => decidedIn(outcomes, point).flatMap(entry => iterationsIn(entry, loop)))
    );
  const returnedIn = roundsDecided(points.returns);
  const approvedIn = roundsDecided(points.approves);
  const unfinished = TERMINAL.has(run.status) ? 'stopped' : 'running';
  const verdict = (iteration: number): RoundVerdict => {
    if (returnedIn.has(iteration)) return 'returned';
    if (approvedIn.has(iteration)) return 'approved';
    // Approved only by a declared approval; one that completed without it needs a decision.
    return completed.has(iteration) ? 'undecided' : unfinished;
  };
  const numbers = [...started.keys()].sort((a, b) => a - b);
  const last = numbers.at(-1);
  return {
    max: (last === undefined ? undefined : started.get(last)) ?? null,
    rounds: numbers.map(iteration => ({ iteration, verdict: verdict(iteration) })),
  };
}

/** A positive whole number at `pointer` in the run's result; null otherwise. */
function countAt(record: RunRecord, pointer: string): number | null {
  const found = valueAt(record, pointer);
  return typeof found === 'number' && Number.isInteger(found) && found > 0 ? found : null;
}

/**
 * A stage-form run as its one round, numbered and bounded by its own result: only a run that
 * completed with a result naming a positive whole round is one.
 */
function stageRound(
  source: Extract<RoundsSource, { round: string }>,
  points: Points,
  run: RunState,
  record: RunRecord
): RunRounds | null {
  if (run.status !== 'completed') return null;
  const iteration = countAt(record, source.round);
  if (iteration === null) return null;
  const outcomes = record.node_outcomes.nodes;
  const decides = (list: readonly DecisionPoint[]): boolean =>
    list.some(point => decidedIn(outcomes, point).length > 0);
  const verdict: RoundVerdict = decides(points.returns)
    ? 'returned'
    : decides(points.approves)
      ? 'approved'
      : 'undecided';
  return {
    max: source.allowance === undefined ? null : countAt(record, source.allowance),
    rounds: [{ iteration, verdict }],
  };
}

function runChange(sources: readonly ChangeSource[], record: RunRecord): string | null {
  for (const source of sources) {
    const url = valueAt(record, source.pointer);
    if (typeof url === 'string' && url.trim() !== '') return url.trim();
  }
  return null;
}

/** The facts of one run of `workflow`, as the pack declares it (null for none it declares). */
export function runFacts(
  view: FactoryWords,
  workflow: string | null,
  run: RunState,
  record: RunRecord
): RunFacts {
  const ofWorkflow = (list: readonly DecisionPoint[]): DecisionPoint[] =>
    list.filter(point => point.workflow === workflow);
  const points = { returns: ofWorkflow(view.returns), approves: ofWorkflow(view.approves) };
  const outcomes = record.node_outcomes.nodes;
  const source = view.rounds.find(entry => entry.workflow === workflow);
  return {
    active: deepestRunning(record.running),
    rounds:
      source === undefined
        ? null
        : 'loop' in source
          ? loopRounds(source.loop, points, run, record)
          : stageRound(source, points, run, record),
    // In the order the run recorded them, so the last is the latest send-back.
    returns: outcomes
      .filter(entry =>
        points.returns.some(
          point => entry.node_id === point.node && outcomeOf(entry.output) === point.outcome
        )
      )
      .map(entry => ({ summary: summaryOf(entry.output) })),
    change: runChange(
      view.change.filter(entry => entry.workflow === workflow),
      record
    ),
  };
}
