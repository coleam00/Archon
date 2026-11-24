/**
 * The item's journey through the board's columns, for the strip across the top of its page
 * (DESIGN.md, The item page): how long it spent in each column, where it is now, each time it
 * was sent back to an earlier column, each ask it waited on, and where it stopped when it was
 * parked, ended or failed. Positions come from `item-visits.ts` (each stage a run worked, as
 * its steps started) and from `placement` (where each completed run left the item), so the
 * strip, the board and the story place alike.
 */
import type { FactoryItemDetail } from '../../skills/factory';
import { boardColumns, type ColumnTone } from './board-columns';
import { restartOf } from './answered';
import { itemPositions, stageWorkflow } from './item-visits';
import { placedStage, type ItemColumn } from './placement';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];

interface JourneyLoop {
  /** The earlier column it was sent back to. */
  to: string;
  count: number;
}

interface JourneyPause {
  /** How long it waited on you; to now while the ask is open. */
  ms: number;
  open: boolean;
}

export interface JourneySegment {
  id: string;
  label: string;
  tone: ColumnTone;
  /** Time spent here, all visits together. */
  ms: number;
  /** It was here at some point (or is). */
  reached: boolean;
  /** Where it is now, while it is in flight or once merged. */
  lit: boolean;
  /** Where it stopped, in the view's words ("Parked by triage"); null elsewhere. */
  stopped: string | null;
  loops: JourneyLoop[];
  pauses: JourneyPause[];
}

export interface Journey {
  segments: JourneySegment[];
  /** From its first run's start to its merge, its stop, or now. */
  totalMs: number;
  /** How the total ends: merged, stopped where it is, or still going. */
  until: 'merge' | 'stop' | 'now';
  /** Why it stopped, in the view's words or the console's ("Nothing started after your answer"); else null. */
  stopped: string | null;
}

interface Mark {
  stage: string;
  at: number;
}

/** Where it was, in time order: each stage worked, and where each completed run left it. */
function marks(view: Declaration, detail: FactoryItemDetail): Mark[] {
  const facts = new Map(detail.runs.map(run => [run.runId, run]));
  const worked = itemPositions(view, detail).map(p => ({ stage: p.stage.id, at: p.at }));
  const left = detail.item.runs.flatMap((run): Mark[] => {
    const workflow = stageWorkflow(view, facts.get(run.id));
    if (workflow === null || run.status !== 'completed' || run.completedAt === null) return [];
    const stage = placedStage(view, workflow, run.outcome);
    return stage === undefined ? [] : [{ stage: stage.id, at: Date.parse(run.completedAt) }];
  });
  const change = detail.item.progress?.change;
  const merged =
    change?.merged === true && change.mergedAt !== null
      ? [{ stage: view.landed.stage, at: Date.parse(change.mergedAt) }]
      : [];
  return [...worked, ...left, ...merged].sort((a, b) => a.at - b.at);
}

/** Where the time ends: the merge, the last run's end when the item stopped, else now. */
function endOf(
  view: Declaration,
  detail: FactoryItemDetail,
  stopped: boolean,
  now: number
): { at: number; until: Journey['until'] } {
  const change = detail.item.progress?.change;
  if (change?.merged === true && change.mergedAt !== null)
    return { at: Date.parse(change.mergedAt), until: 'merge' };
  const last = lastStageRun(view, detail)?.completedAt ?? null;
  if (stopped && last !== null) return { at: Date.parse(last), until: 'stop' };
  return { at: now, until: 'now' };
}

/**
 * The item's last run of a workflow a stage lists: the one placement reads, so a discoveries
 * drain that ran after it never hides where the item stopped.
 */
function lastStageRun(view: Declaration, detail: FactoryItemDetail) {
  const facts = new Map(detail.runs.map(run => [run.runId, run]));
  return detail.item.runs.filter(run => stageWorkflow(view, facts.get(run.id)) !== null).at(-1);
}

/** What stopped the item where it is, in the view's words; null for an item in flight. */
function stopWords(
  view: Declaration,
  detail: FactoryItemDetail,
  column: ItemColumn | null
): string | null {
  if (column !== null && 'ended' in column) return column.ended;
  // A merged change is where the item ends, however it rested before (a held item a person
  // merged by hand): the strip lights Merged.
  if (detail.item.progress?.change?.merged === true) return null;
  const held = detail.item.progress?.awaits ?? detail.item.progress?.parked;
  if (held != null) return held.label;
  const last = lastStageRun(view, detail);
  if (detail.item.progress?.running != null || last === undefined) return null;
  if (last.status === 'failed') return 'Failed';
  if (last.status === 'cancelled') return 'Stopped';
  return resting(view, detail, last.id) ? RESTING : null;
}

/** What a held item reads where it stopped. */
/**
 * What an item that rests after your answer reads where it stopped. It says what is known:
 * nothing started. The answer's route (hold, take as is) is not on the item read, so the page
 * does not claim the item was held.
 */
const RESTING = 'Nothing started after your answer';

/**
 * Resting after your answer: the last stage run asked, every ask is settled, nothing waits on
 * you, settling them started no run (`restartOf`, the reading behind Needs you's "Nothing
 * started"), and no start waits for one either: none queued for a slot, none kept back by the
 * install hold. Nothing runs, so the item rests where it is until someone starts it again.
 */
function resting(view: Declaration, detail: FactoryItemDetail, runId: string): boolean {
  const { item } = detail;
  const settled = item.answers.some(
    answer => answer.kind === 'asks_settled' && answer.runId === runId
  );
  return (
    settled &&
    item.questions.length === 0 &&
    item.queued.length === 0 &&
    item.held.length === 0 &&
    restartOf(view, item, runId) === null
  );
}

/** Each ask the item waited on, by the run that asked: from its end to the answer, or to now. */
function askPauses(
  detail: FactoryItemDetail,
  now: number
): { runId: string; pause: JourneyPause }[] {
  const ends = new Map(detail.item.runs.map(run => [run.id, run.completedAt]));
  const answered = new Map<string, number>();
  for (const answer of detail.item.answers)
    if ((answer.kind === 'ask' || answer.kind === 'asks_settled') && answer.runId !== null)
      answered.set(answer.runId, Math.max(answered.get(answer.runId) ?? 0, Date.parse(answer.at)));
  const open = new Set(
    detail.item.questions.flatMap(question =>
      question.kind === 'attention' && question.askedIn != null ? [question.askedIn.runId] : []
    )
  );
  return [...new Set([...answered.keys(), ...open])].flatMap(runId => {
    const asked = ends.get(runId);
    if (asked == null) return [];
    const isOpen = open.has(runId);
    const to = isOpen ? now : (answered.get(runId) ?? now);
    return [{ runId, pause: { ms: Math.max(0, to - Date.parse(asked)), open: isOpen } }];
  });
}

/**
 * The journey of one item. `column` is where placement puts it now (the board's column for
 * its card), so the lit segment is the card's column.
 */
export function itemJourney(
  view: Declaration,
  detail: FactoryItemDetail,
  column: ItemColumn | null,
  now: number
): Journey {
  const columns = boardColumns(view);
  const columnOf = new Map(columns.flatMap((entry, index) => entry.stages.map(id => [id, index])));
  const stopped = stopWords(view, detail, column);
  const end = endOf(view, detail, stopped !== null, now);
  const all = marks(view, detail).filter(mark => mark.at <= end.at);
  const segments: JourneySegment[] = columns.map(entry => ({
    id: entry.id,
    label: entry.label,
    tone: entry.tone,
    ms: 0,
    reached: false,
    lit: false,
    stopped: null,
    loops: [],
    pauses: [],
  }));
  all.forEach((mark, index) => {
    const segment = segments[columnOf.get(mark.stage) ?? -1];
    if (segment === undefined) return;
    segment.reached = true;
    segment.ms += (all[index + 1]?.at ?? end.at) - mark.at;
    const next = all[index + 1];
    const to = next === undefined ? undefined : columnOf.get(next.stage);
    const from = columnOf.get(mark.stage) ?? 0;
    if (to !== undefined && to < from) addLoop(segment, columns[to]?.label ?? '');
  });
  placePauses(view, detail, segments, columnOf, now);
  markNow(segments, columnOf, column, stopped, all.at(-1));
  const first = all[0]?.at ?? end.at;
  return { segments, totalMs: Math.max(0, end.at - first), until: end.until, stopped };
}

function addLoop(segment: JourneySegment, to: string): void {
  const loop = segment.loops.find(entry => entry.to === to);
  if (loop === undefined) segment.loops.push({ to, count: 1 });
  else loop.count += 1;
}

/** Each ask's pause on the column where the asking run left the item. */
function placePauses(
  view: Declaration,
  detail: FactoryItemDetail,
  segments: JourneySegment[],
  columnOf: ReadonlyMap<string, number>,
  now: number
): void {
  const facts = new Map(detail.runs.map(run => [run.runId, run]));
  const runs = new Map(detail.item.runs.map(run => [run.id, run]));
  for (const { runId, pause } of askPauses(detail, now)) {
    const run = runs.get(runId);
    const workflow = stageWorkflow(view, facts.get(runId));
    const stage =
      workflow === null || run === undefined ? undefined : placedStage(view, workflow, run.outcome);
    segments[columnOf.get(stage?.id ?? '') ?? -1]?.pauses.push(pause);
  }
}

/** Light where it is now; or, for an item that stopped, mark where it stopped. */
function markNow(
  segments: JourneySegment[],
  columnOf: ReadonlyMap<string, number>,
  column: ItemColumn | null,
  stopped: string | null,
  last: Mark | undefined
): void {
  if (stopped !== null) {
    const at = column !== null && 'stage' in column ? column.stage.id : last?.stage;
    const segment = segments[columnOf.get(at ?? '') ?? -1];
    if (segment !== undefined) segment.stopped = stopped;
    return;
  }
  if (column === null || !('stage' in column)) return;
  const segment = segments[columnOf.get(column.stage.id) ?? -1];
  if (segment !== undefined) {
    segment.lit = true;
    segment.reached = true;
  }
}
