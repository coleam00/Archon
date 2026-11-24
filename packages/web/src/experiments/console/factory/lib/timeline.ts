/**
 * What each run on an item did to it, in words and as a kind (sent on, returned, asked you,
 * failed, running, stopped), with its running step and its shadow steps' decisions. The item
 * page's story (`item-story.ts`) and its rounds grid read these rows; placement stays
 * `placement.ts`'s.
 */
import type { FactoryItemDetail } from '../../skills/factory';
import { placedStage } from './placement';
import { shadowOf, shadowWords, type ShadowWords } from './shadows';
import { stepLabel } from './step-label';
import { boardSeats, isSendBack, type Seat } from './stage-direction';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
type ItemRun = FactoryItemDetail['item']['runs'][number];
type RunFacts = FactoryItemDetail['runs'][number];

/**
 * An outcome as a person reads it. Where the declaration says what an outcome means, its
 * words (`mono` false); a pack's own token the declaration does not map stays as that
 * identifier, drawn in mono (`mono` true). Console code never words a pack's tokens itself.
 */
interface OutcomeWords {
  text: string;
  mono: boolean;
}

/** One decision a shadow step recorded on a run: what it would have done. */
export interface TimelineShadow {
  /** The run, step and round, unique on the run. */
  key: string;
  /** The shadow's declared label, else the step's engine id. */
  label: string;
  /** The loop round it decided in; null outside a loop. */
  round: number | null;
  words: ShadowWords;
}

/**
 * What a run's outcome did to the item, for its icon and colour. Derived from the same
 * branches as its words, never from the words: `sent-on` and `returned` by where `placement`
 * put the item, forward or back by the board's order (`isSendBack`, the map's rule), judged
 * from the furthest stage the run works, a placement into that stage itself sent on
 * (`placedKind`).
 */
export type RunKind = 'sent-on' | 'returned' | 'asked' | 'failed' | 'running' | 'stopped' | 'other';

export interface TimelineRow {
  runId: string;
  /** The workflow as the view names it, else as the run recorded it. */
  workflow: string;
  status: ItemRun['status'];
  /** How the run ended, or what it is doing (`runOutcome`). */
  outcome: OutcomeWords;
  kind: RunKind;
  /** The questions this run left on the item, for the hover of an outcome that reads "asked you". */
  asked: string[];
  /** The running step's engine id while the run runs, for the hover title. */
  liveStep: string | null;
  /** The running step's name, with its round when it is of the rounds loop. */
  liveStepName: string | null;
  /** What the shadow steps the view declares decided on this run, in recording order. */
  shadows: TimelineShadow[];
}

export const runHref = (projectId: string, runId: string): string =>
  `/console/p/${projectId}/r/${runId}`;

const words = (text: string): OutcomeWords => ({ text, mono: false });

/** An outcome's words with what it did to the item. */
type Outcome = { words: OutcomeWords; kind: RunKind };
const outcome = (text: string, kind: RunKind): Outcome => ({ words: words(text), kind });
const token = (text: string): Outcome => ({ words: { text, mono: true }, kind: 'other' });

/** The words for a run that stopped to ask. */
const ASKED_YOU = 'asked you';

/**
 * The questions a run left on the item: its answered or withdrawn asks, then its open ones.
 * An open question counts only by `askedIn`; a gate's own question names its run in `run`,
 * and that is not an ask the run left.
 */
function askedQuestions(detail: FactoryItemDetail, runId: string): string[] {
  const closed = detail.item.answers.flatMap(answer =>
    answer.kind === 'ask' && answer.runId === runId ? [answer.question] : []
  );
  const open = detail.item.questions.flatMap(question =>
    question.kind === 'attention' && question.askedIn?.runId === runId ? [question.message] : []
  );
  return [...closed, ...open];
}

/**
 * Whether `asked` declares this completed outcome, exactly or by `workflow:*`. As in
 * `endings`, `*` takes every outcome, not a run that recorded none.
 */
const declaredAsked = (view: Declaration, workflow: string, outcome: string | null): boolean =>
  outcome !== null &&
  (view.asked ?? []).some(key => key === `${workflow}:*` || key === `${workflow}:${outcome}`);

/**
 * The label of the `awaits` or `parked` entry a completed outcome takes, exactly or by
 * `workflow:*`; as in `asked`, `*` takes every outcome, not a run that recorded none.
 */
function declaredHeld(
  view: Declaration,
  workflow: string,
  outcome: string | null
): string | undefined {
  if (outcome === null) return undefined;
  const label = (entries: Record<string, { label: string }> | undefined): string | undefined =>
    (entries?.[`${workflow}:${outcome}`] ?? entries?.[`${workflow}:*`])?.label;
  return label(view.awaits) ?? label(view.parked);
}

/**
 * A completed run's outcome: "asked you" when it stopped to ask (a declared `asked` outcome,
 * or asks it left on the item), else the `awaits` or `parked` label when it kept the item open
 * ("Needs shaping", "Parked by triage", not the stage it sits in), else where `placement` sent the item ("sent to
 * Plan"), the label of the `endings` entry that closed it, else the pack's token as an identifier.
 */
function completedOutcome(
  view: Declaration,
  workflow: string | null,
  result: string | null,
  asked: readonly string[]
): Outcome {
  if (asked.length > 0 || (workflow !== null && declaredAsked(view, workflow, result)))
    return outcome(ASKED_YOU, 'asked');
  const held = workflow === null ? undefined : declaredHeld(view, workflow, result);
  if (held !== undefined) return outcome(held, 'other');
  const stage = workflow === null ? undefined : placedStage(view, workflow, result);
  if (workflow !== null && stage !== undefined)
    return outcome(`sent to ${stage.label}`, placedKind(view, workflow, stage.id));
  if (result === null) return outcome('completed', 'other');
  if (workflow === null) return token(result);
  const ending = view.endings[`${workflow}:${result}`] ?? view.endings[`${workflow}:*`];
  return ending === undefined ? token(result) : outcome(ending, 'stopped');
}

/**
 * Whether placing the item in `stage` after a run of `workflow` sent it back or on, by the
 * board's order (`isSendBack`, the map's rule). A run is judged from the furthest stage its
 * workflow works, since it may have reached any of them: `deliver:returned` lands in Build
 * from Checks, `deliver:replan` in Plan. A placement into that furthest stage itself is no
 * send-back: the land gate places the item in Ready to merge, the stage it works.
 */
function placedKind(view: Declaration, workflow: string, stage: string): RunKind {
  const seats = boardSeats(view);
  const to = seats.get(stage);
  const from = view.stages
    .filter(candidate => candidate.workflows.includes(workflow))
    .map(candidate => seats.get(candidate.id))
    .reduce<Seat | undefined>(
      (furthest, seat) =>
        seat === undefined || (furthest !== undefined && isSendBack(furthest, seat))
          ? furthest
          : seat,
      undefined
    );
  if (from === undefined || to === undefined) return 'sent-on';
  const same = from.card === to.card && from.row === to.row;
  return !same && isSendBack(from, to) ? 'returned' : 'sent-on';
}

/** How a run ended, or what it is doing; `workflow` as the view names it, null if it does not. */
function runOutcome(
  view: Declaration,
  workflow: string | null,
  run: ItemRun,
  asked: readonly string[]
): Outcome {
  if (run.awaitingExecution !== null) return outcome('waiting to start', 'other');
  switch (run.status) {
    case 'pending':
      return outcome('waiting to start', 'other');
    case 'running':
    case 'paused':
      return outcome(run.status, 'running');
    case 'failed':
    case 'cancelled':
      return outcome(run.status, 'failed');
    case 'completed':
      return completedOutcome(view, workflow, run.outcome, asked);
  }
}

function timelineShadows(view: Declaration, fact: RunFacts | undefined): TimelineShadow[] {
  return (fact?.shadows ?? []).map(decision => {
    const shadow = shadowOf(view, decision.workflow, decision.node);
    return {
      key: `${decision.runId}|${decision.node}|${String(decision.round)}`,
      label: shadow?.label ?? decision.node,
      round: decision.round,
      words: shadowWords(shadow, decision),
    };
  });
}

/**
 * One row per run in the item read's order (start order): what it did to the item, its running
 * step, and what its shadow steps decided.
 */
export function buildTimeline(view: Declaration, detail: FactoryItemDetail): TimelineRow[] {
  const facts = new Map(detail.runs.map(run => [run.runId, run]));
  return detail.item.runs.map((run): TimelineRow => {
    const fact = facts.get(run.id);
    const workflow = fact?.workflow ?? null;
    const liveStep = run.status === 'running' ? (fact?.step ?? null) : null;
    const iteration = fact?.rounds?.rounds.at(-1)?.iteration;
    const asked = askedQuestions(detail, run.id);
    const result = runOutcome(view, workflow, run, asked);
    return {
      runId: run.id,
      workflow: workflow ?? run.workflow,
      status: run.status,
      outcome: result.words,
      kind: result.kind,
      asked,
      liveStep,
      liveStepName:
        liveStep === null ? null : stepLabel(view, workflow ?? run.workflow, liveStep, iteration),
      // Not gated on a declared workflow: the discoveries workflow is on no stage.
      shadows: timelineShadows(view, fact),
    };
  });
}
