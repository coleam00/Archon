/**
 * The asks an item settled lately, and the stage each settling started again. Settling the
 * last open ask a run left starts that stage again (engine #5834): the item read records the
 * settled set as an `asks_settled` answer naming the asking run, and the run it started
 * records `cause: { kind: 'asks_settled', runId }` naming the same run. Derived from reads
 * alone, so an answer given through the CLI or by an agent shows as one given here does. It
 * reads the engine's item read, so it needs no factory view: with one, a run is named by its
 * stage; without, by its workflow. An answer whose option the view words (`answers`) says what
 * it started in the view's sentence instead.
 */
import type { FactoryItem } from '../../skills/factory';
import type { ItemRead } from '../../skills/items';
import { humaniseId, shortWorkflow } from '../../lib/ask-card';
import { answerStarts } from './answer-starts';
import { answererName } from './item-answers';
import { stageOfWorkflow } from './placement';
import { membershipOf } from './work-orders';
import type { FactoryViewListed } from './views';

type Answer = ItemRead['answers'][number];
type Settled = Extract<Answer, { kind: 'asks_settled' }>;
type AskAnswer = Extract<Answer, { kind: 'ask' }>;
type RunStatus = ItemRead['runs'][number]['status'];
type Declaration = FactoryViewListed['declaration'];

/** An item as the answered read takes it: the engine's read, with the board's progress when a view applies. */
export type AnsweredSource = ItemRead & { progress?: FactoryItem['progress'] };

/** How many answers Needs you's Answered lately lists, one row each. */
export const ANSWERED_ROWS = 8;

export interface SettledAsks {
  itemKey: string;
  /** The asking run: the run whose open asks this set closed. */
  runId: string;
  /** The item's title when the board's progress names one. */
  title: string | null;
  /** The work order the item is a member of, which its key reads under; null when in none. */
  partOf: string | null;
  answered: number;
  withdrawn: number;
  /** When the last ask of the set closed. */
  at: string;
  /** When the asking run finished, which is when it asked; null when the read lacks it. */
  askedAt: string | null;
  /** The questions of the set, each with what it was answered with, when, and by whom. */
  asks: {
    question: string;
    answer: string;
    withdrawn: boolean;
    at: string;
    /** Who answered, as the read records them; null when unsaid. */
    by: string | null;
    /** What the chosen option starts, in the view's words (`answers`); null when it words none. */
    starts: string | null;
  }[];
  /** The run the settling started; null until one has. */
  restart: {
    runId: string;
    status: RunStatus;
    /** The stage the run starts on when a view names it, else its workflow in words. */
    label: string;
  } | null;
  /** How many runs settling the set started: one per route its answers took. */
  restarts: number;
}

/**
 * The asking run a run's cause names when settling that run's asks started it; null for any
 * other cause. The generated type reads this nullable union as `unknown`, so it is narrowed
 * here rather than asserted.
 */
export function asksSettledRunId(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null || !('kind' in cause)) return null;
  if (cause.kind !== 'asks_settled' || !('runId' in cause)) return null;
  return typeof cause.runId === 'string' ? cause.runId : null;
}

/** The run settling `askingRunId`'s asks started, named by its stage; null until one has. */
export function restartOf(
  view: Declaration | null,
  item: AnsweredSource,
  askingRunId: string
): SettledAsks['restart'] {
  const run = item.runs.find(entry => asksSettledRunId(entry.cause) === askingRunId);
  if (run === undefined) return null;
  // The view names workflows as the progress read reports them.
  const workflow = item.progress?.runs.find(entry => entry.runId === run.id)?.workflow;
  const stage =
    view === null || workflow === undefined ? undefined : stageOfWorkflow(view, workflow, null);
  return {
    runId: run.id,
    status: run.status,
    label: stage?.label ?? humaniseId(shortWorkflow(run.workflow)),
  };
}

/** What an ask was answered with, in words: the chosen option humanised, else the text. */
export function answerWords(answer: AskAnswer): string {
  if (answer.withdrawn) return 'withdrawn';
  if (answer.chosen !== null)
    return answer.chosen.id === 'other' ? 'Something else' : humaniseId(answer.chosen.id);
  return 'answered';
}

function asksOf(
  view: Declaration | null,
  item: AnsweredSource,
  settled: Settled
): SettledAsks['asks'] {
  const workflow = item.runs.find(run => run.id === settled.runId)?.workflow;
  return item.answers
    .filter(
      (answer): answer is AskAnswer => answer.kind === 'ask' && answer.runId === settled.runId
    )
    .map(answer => ({
      question: answer.question,
      answer: answerWords(answer),
      withdrawn: answer.withdrawn,
      at: answer.at,
      by: answererName(answer.by),
      starts:
        answer.withdrawn || answer.chosen === null
          ? null
          : (answerStarts(view, workflow, answer.chosen.id) ?? null),
    }));
}

/** Every item's settled asks, newest first, the first `limit`, each with what it started. */
export function recentlySettled(
  view: Declaration | null,
  items: readonly AnsweredSource[],
  limit = ANSWERED_ROWS
): SettledAsks[] {
  const all = items.flatMap(item =>
    item.answers
      .filter((answer): answer is Settled => answer.kind === 'asks_settled')
      .map(settled => ({ item, settled }))
  );
  return all
    .sort((a, b) => Date.parse(b.settled.at) - Date.parse(a.settled.at))
    .slice(0, limit)
    .map(({ item, settled }) => ({
      itemKey: item.item.key,
      runId: settled.runId,
      title: item.progress?.title ?? null,
      partOf: membershipOf(item)?.order ?? null,
      answered: settled.answered,
      withdrawn: settled.withdrawn,
      at: settled.at,
      askedAt: item.runs.find(run => run.id === settled.runId)?.completedAt ?? null,
      asks: asksOf(view, item, settled),
      restart: restartOf(view, item, settled.runId),
      restarts: item.runs.filter(run => asksSettledRunId(run.cause) === settled.runId).length,
    }));
}

/** One answer, as Answered lately lists it: the ask, what it was answered with, and what its set started. */
export interface AnsweredRow {
  itemKey: string;
  title: string | null;
  partOf: string | null;
  /** The asking run, which with the row's place in its set keys it. */
  runId: string;
  question: string;
  answer: string;
  withdrawn: boolean;
  at: string;
  by: string | null;
  /** What the chosen option starts, in the view's words; null when it words none. */
  starts: string | null;
  /** What settling the set this answer closed started; null when nothing has. */
  restart: SettledAsks['restart'];
  /** How many runs settling the set started. */
  restarts: number;
}

/**
 * The settled sets as one row per answer, newest answer first, the first `limit`. Each row
 * carries its set's restart: settling the set, not one answer, starts the stage again.
 */
export function answeredRows(
  settled: readonly SettledAsks[],
  limit = ANSWERED_ROWS
): AnsweredRow[] {
  return settled
    .flatMap(entry =>
      entry.asks.map(ask => ({
        itemKey: entry.itemKey,
        title: entry.title,
        partOf: entry.partOf,
        runId: entry.runId,
        ...ask,
        restart: entry.restart,
        restarts: entry.restarts,
      }))
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * How many questions were answered on `now`'s local day across the items: answered waits,
 * resolved gates and answered asks. A withdrawn ask was not answered; a ruling answers no
 * question, and a settled set is the answers it closed, already counted.
 */
export function answeredToday(items: readonly Pick<ItemRead, 'answers'>[], now: Date): number {
  return items
    .flatMap(item => item.answers)
    .filter(answer => {
      if (answer.kind === 'ask' && answer.withdrawn) return false;
      if (answer.kind !== 'ask' && answer.kind !== 'attention' && answer.kind !== 'gate')
        return false;
      return sameDay(new Date(answer.at), now);
    }).length;
}

/** When something was last asked: the newest asking run's end among the settled sets; null when none says. */
export function lastAsked(settled: readonly SettledAsks[]): string | null {
  const times = settled.flatMap(entry => (entry.askedAt === null ? [] : [entry.askedAt]));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
