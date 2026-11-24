/**
 * The item page's story (DESIGN.md, The item page): one panel per stage visit in the order it
 * ran (`item-visits.ts`), each opening with one plain sentence of what happened. The sentence
 * is the view's (`story.outcomes`, `story.steps`); the console adds only clauses about its own
 * concepts: run status, the pull request a run opened, why the checks sent it back, how many
 * rounds they took, and what you answered. An outcome the view does not tell falls back to a
 * neutral sentence from the timeline's words.
 */
import type { FactoryItemDetail } from '../../skills/factory';
import { answerStarts } from './answer-starts';
import { answerWords, restartOf } from './answered';
import { answererName } from './item-answers';
import { gridShadowKeys, roundsGrid, type RoundsGrid } from './item-rounds-grid';
import { storyVisits, type RunFacts, type StoryVisit } from './item-visits';
import { isStopped, stageOfWorkflow, stoppedStage } from './placement';
import { stoppedLine } from './step-label';
import { runHref, type TimelineRow, type TimelineShadow } from './timeline';
import type { FactoryStage } from './stage-steps';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
type ItemRun = FactoryItemDetail['item']['runs'][number];
type AskAnswer = Extract<FactoryItemDetail['item']['answers'][number], { kind: 'ask' }>;

/** A sentence, and the pack's own token after it in mono where the view does not word it. */
export interface Sentence {
  text: string;
  mono: string | null;
}

/** A long text cut to its first sentence, with the whole of it for "More". */
export interface Reason {
  short: string;
  full: string;
}

/** An ask a panel's run left, answered: what was asked, what you chose, who, and what it started. */
export interface AnsweredAsk {
  question: string;
  chosen: string;
  /** The chosen option's own words, when it had them. */
  does: string | null;
  /** The chosen option's id, for its tag; null for an answer in words. */
  optionId: string | null;
  by: string | null;
  at: string;
  /** What the answer started: the view's sentence for its option (`answers`), else the stage started again. */
  started: string;
  /** The run that asked. */
  runId: string;
}

export interface PanelDetails {
  start: string;
  end: string | null;
  durationMs: number | null;
  costUsd: number | null;
  /**
   * A run of this panel worked other stages too (a loop-form delivery): its cost and models are
   * the whole run's, recorded once per run, so they cannot be split by stage.
   */
  wholeRun: boolean;
  models: string[];
  runs: { id: string; href: string }[];
}

interface PanelBase {
  key: string;
  sentence: Sentence;
  details: PanelDetails;
  shadows: TimelineShadow[];
}

export interface StagePanel extends PanelBase {
  kind: 'stage';
  stage: FactoryStage;
  number: number;
  /** The pull request a run of this panel named first on the item. */
  pr: { url: string; label: string } | null;
  /** Why it was sent back, when the panel ended so. */
  reason: Reason | null;
  answered: AnsweredAsk[];
  /** What you answered the panel's last run, for the sentence's "; you said" clause. */
  youSaid: string | null;
  /** The runs whose open asks show in this panel: those whose last panel it is. */
  runIds: string[];
  grid: RoundsGrid | null;
  /**
   * On a panel with no rounds grid that went round more than once (CI and the reviews sent the
   * change back, the builder fixed it, they looked again): each earlier send-back with its reason,
   * and each folded fix in the view's words, in the order they ran. Empty otherwise.
   */
  happened: PanelEvent[];
  /** When the change merged, on the Merged stage's panel. */
  merged: string | null;
}

export interface DrainPanel extends PanelBase {
  kind: 'drain';
}

/** The change merged with no run of the Merged stage to tell it (a person merged it). */
export interface MergedPanel {
  kind: 'merged';
  key: string;
  stage: FactoryStage | undefined;
  at: string | null;
}

export type StoryPanel = StagePanel | DrainPanel | MergedPanel;

/** A send-back or a fix inside one panel without a grid. */
export type PanelEvent =
  | { kind: 'sent-back'; runId: string; reason: Reason }
  | { kind: 'fixed'; runId: string; text: string };

interface StoryContext {
  view: Declaration;
  projectId: string;
  detail: FactoryItemDetail;
  runs: ReadonlyMap<string, ItemRun>;
  facts: ReadonlyMap<string, RunFacts>;
  rows: ReadonlyMap<string, TimelineRow>;
  now: number;
  /**
   * Each run's last panel, by index: where the run ended, or is now. A run that works several
   * stages tells its status, its asks and answers and why it sent the item back there only;
   * its earlier panels tell what it did on their stage.
   */
  home: ReadonlyMap<string, number>;
}

const MAX_SHORT = 140;
/** A first sentence shorter than this ("Return.") says too little alone; the next joins it. */
const MIN_SHORT = 40;

/**
 * A text's opening, for one line: its sentences up to the first line end, until they say at
 * least about 40 characters, cut at about 140. Display only: nothing reads meaning from it.
 */
export function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  const stops = [...line.matchAll(/[.!?](\s|$)/g)].map(stop => (stop.index ?? 0) + 1);
  const end = stops.find(at => at >= MIN_SHORT) ?? line.length;
  const cut = line.slice(0, end);
  return cut.length <= MAX_SHORT ? cut : `${cut.slice(0, MAX_SHORT - 1).trimEnd()}…`;
}

const reasonOf = (text: string | null | undefined): Reason | null =>
  text == null || text.trim() === '' ? null : { short: firstSentence(text), full: text.trim() };

/** "once", "twice", "3 times". */
export function times(count: number): string {
  if (count === 1) return 'once';
  if (count === 2) return 'twice';
  return `${count.toString()} times`;
}

/**
 * What the view says a completed run did: `workflow:outcome`, else `workflow:*`. An entry worded
 * by whether the item has a change (`{ withChange, withoutChange }`) reads `hasChange`.
 */
function toldOutcome(
  view: Declaration,
  workflow: string,
  outcome: string | null,
  hasChange: boolean
): string | undefined {
  const told = view.story?.outcomes;
  if (told === undefined) return undefined;
  const entry =
    (outcome === null ? undefined : told[`${workflow}:${outcome}`]) ?? told[`${workflow}:*`];
  if (entry === undefined || typeof entry === 'string') return entry;
  return hasChange ? entry.withChange : entry.withoutChange;
}

/** Whether the item has a change, which an outcome's sentence may be worded by. */
const hasChange = (ctx: StoryContext): boolean => ctx.detail.item.progress?.change != null;

/**
 * A run that has not finished: what it is doing, in the stage's name. On a stage's panel
 * (`byStage`) a stopped run is named by the stage rule 5 places it in, as its board card names
 * it, so the two never name different stages.
 */
function statusSentence(
  ctx: StoryContext,
  label: string,
  run: ItemRun,
  byStage = false
): string | null {
  const row = ctx.rows.get(run.id);
  if (run.awaitingExecution !== null || run.status === 'pending')
    return `${label} is waiting to start`;
  if (run.status === 'running' || run.status === 'paused') {
    const step = row?.liveStepName;
    return step == null
      ? `${label} is working on it now`
      : `${label} is working on it now: ${step}`;
  }
  if (!isStopped(run.status)) return null;
  const failedStep =
    ctx.detail.item.progress?.runs.find(entry => entry.runId === run.id)?.failedStep ?? null;
  const workflow = ctx.facts.get(run.id)?.workflow ?? null;
  const stage =
    byStage && workflow !== null ? stoppedStage(ctx.view, workflow, failedStep) : undefined;
  return stoppedLine(ctx.view, { workflow, status: run.status, failedStep }, stage?.label ?? label);
}

/**
 * A run not finished, on its stage. On the Merged stage the stage's name is an outcome, not who
 * acts ("Merged failed" would read as if the merge failed), so the factory is the subject, after
 * the merge itself: "The change merged; then the factory failed at <step>".
 */
function stageStatus(ctx: StoryContext, stage: FactoryStage, run: ItemRun): string | null {
  if (stage.id !== ctx.view.landed.stage) return statusSentence(ctx, stage.label, run, true);
  const status = statusSentence(ctx, 'the factory', run);
  if (status === null) return null;
  const merged = ctx.detail.item.progress?.change?.merged === true;
  return merged ? `The change merged; then ${status}` : capitalised(status);
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The checks' rounds in a sentence: how often they sent it back, and how the last round ended.
 * A round with neither a return nor an approval reads "asked you" only when one of its checks
 * recorded an outcome the view means as asked; a replan, or a round that stopped, is null, so
 * the run's own sentence tells it.
 */
function roundsSentence(label: string, grid: RoundsGrid): string | null {
  const last = grid.columns.at(-1)?.verdict;
  const index = grid.columns.length - 1;
  const asked = grid.rows.some(
    row => !row.shadow && row.cells[index]?.some(cell => cell.meaning === 'asked') === true
  );
  const back = grid.columns.filter(column => column.verdict === 'returned').length;
  if (last === 'returned') return `${label} sent it back${back > 1 ? ` ${times(back)}` : ''}`;
  const then = back === 0 ? `${label} ` : `${label} sent it back ${times(back)}, then `;
  if (last === 'approved') return `${then}approved it`;
  if (last === 'undecided' && asked) return `${then}asked you`;
  return null;
}

/**
 * A completed run's sentence on this panel: the view's for its outcome when this is the last
 * stage the run worked; for an earlier stage of a run that works several, the view's for the
 * step it started that stage on; else the neutral words.
 */
function runSentence(ctx: StoryContext, panel: StoryVisit, index: number, run: ItemRun): Sentence {
  const facts = ctx.facts.get(run.id);
  const workflow = facts?.workflow ?? null;
  const row = ctx.rows.get(run.id);
  const neutral: Sentence =
    row?.outcome.mono === true
      ? { text: `${panel.stage.label} finished:`, mono: row.outcome.text }
      : { text: `${panel.stage.label} finished: ${row?.outcome.text ?? 'done'}`, mono: null };
  if (workflow === null) return neutral;
  // The run's outcome is told on its home panel only: a run whose fix step put it back on Build
  // ends there, not on its first Build panel.
  if (ctx.home.get(run.id) === index) {
    const told = toldOutcome(ctx.view, workflow, run.outcome, hasChange(ctx));
    return told === undefined ? neutral : { text: told, mono: null };
  }
  // An earlier stage of a run that works several: its outcome is a later stage's to tell.
  const steps = ctx.view.story?.steps?.[workflow] ?? {};
  const started = panel.positions.find(p => p.runId === run.id && p.node !== null && steps[p.node]);
  const told = started?.node == null ? undefined : steps[started.node];
  return { text: told ?? `${panel.stage.label} did its part`, mono: null };
}

/** The runs whose last panel this is (`StoryContext.home`). */
const ownRuns = (ctx: StoryContext, panel: StoryVisit, index: number): string[] =>
  panel.allRunIds.filter(id => ctx.home.get(id) === index);

/**
 * Whether the panel's last run has not finished (waiting, running or paused) here: a run that
 * went on to another panel goes on there, and this panel's round reasons stand.
 */
function stillGoing(ctx: StoryContext, panel: StoryVisit, index: number): boolean {
  const runId = panel.runIds.at(-1) ?? '';
  const run = ctx.runs.get(runId);
  if (run === undefined || ctx.home.get(runId) !== index) return false;
  return run.awaitingExecution !== null || ['pending', 'running', 'paused'].includes(run.status);
}

function panelSentence(
  ctx: StoryContext,
  panel: StoryVisit,
  index: number,
  grid: RoundsGrid | null
): Sentence {
  const runId = panel.runIds.at(-1) ?? '';
  const run = ctx.runs.get(runId);
  if (run === undefined) return { text: panel.stage.label, mono: null };
  const own = ctx.home.get(runId) === index;
  const status = own ? stageStatus(ctx, panel.stage, run) : null;
  if (status !== null) return { text: status, mono: null };
  const rounds = grid === null ? null : roundsSentence(panel.stage.label, grid);
  return rounds === null ? runSentence(ctx, panel, index, run) : { text: rounds, mono: null };
}

/**
 * Why the panel sent the item back, when it ended so: its last round's words, else its last
 * run's, when that run ended here. Nothing while its last run is still going: an earlier
 * round's reason is not what the running check is doing.
 */
function panelReason(
  ctx: StoryContext,
  panel: StoryVisit,
  index: number,
  grid: RoundsGrid | null
): Reason | null {
  if (stillGoing(ctx, panel, index)) return null;
  const last = grid?.columns.at(-1);
  if (last !== undefined) return last.verdict === 'returned' ? reasonOf(last.reason) : null;
  const runId = panel.runIds.at(-1) ?? '';
  if (ctx.home.get(runId) !== index || ctx.rows.get(runId)?.kind !== 'returned') return null;
  return reasonOf(ctx.facts.get(runId)?.said);
}

/** Each pull request the item's runs named, by the run that named it first. */
function firstNamers(detail: FactoryItemDetail): Map<string, string> {
  const first = new Map<string, string>();
  for (const run of detail.runs)
    if (run.change !== null && ![...first.values()].includes(run.change))
      first.set(run.runId, run.change);
  return first;
}

const prLabel = (url: string): string => {
  const number = /\/(\d+)\/?$/.exec(url)?.[1];
  return number === undefined ? 'the change' : `PR #${number}`;
};

function answeredAsks(ctx: StoryContext, ownIds: readonly string[]): AnsweredAsk[] {
  const runs = new Set(ownIds);
  return ctx.detail.item.answers
    .filter((answer): answer is AskAnswer => answer.kind === 'ask' && !answer.withdrawn)
    .filter(answer => answer.runId !== null && runs.has(answer.runId))
    .map(answer => {
      const restart = restartOf(ctx.view, ctx.detail.item, answer.runId ?? '');
      const workflow = ctx.detail.item.runs.find(run => run.id === answer.runId)?.workflow;
      const starts =
        answer.chosen === null ? undefined : answerStarts(ctx.view, workflow, answer.chosen.id);
      return {
        question: answer.question,
        chosen: answerWords(answer),
        does: answer.chosen?.does ?? null,
        optionId: answer.chosen?.id ?? null,
        by: answererName(answer.by),
        at: answer.at,
        started:
          starts ?? (restart === null ? 'Nothing started' : `${restart.label} started again`),
        runId: answer.runId ?? '',
      };
    });
}

/** The answer to the panel's last run's ask, when that run asked: the sentence ends on it. */
function lastAnswer(answered: readonly AnsweredAsk[], panel: StoryVisit): string | null {
  const last = panel.runIds.at(-1);
  return answered.filter(answer => answer.runId === last).at(-1)?.chosen ?? null;
}

/** When a stretch of work started and ended, as ISO times; a null end while it goes on. */
interface Span {
  start: string;
  end: string | null;
}

/** The runs' own span: the first start to the last end. */
function runsSpan(ctx: StoryContext, runIds: readonly string[]): Span {
  const runs = runIds.flatMap(id => ctx.runs.get(id) ?? []);
  const ends = runs.map(run => run.completedAt);
  return {
    start: runs[0]?.startedAt ?? '',
    end: ends.includes(null) ? null : (ends.at(-1) ?? null),
  };
}

/**
 * A panel's span: from its first position, to where the item moved on when its last run went
 * on to the next panel (a run that works several stages), else to its runs' end.
 */
function panelSpan(ctx: StoryContext, panel: StoryVisit, next: StoryVisit | undefined): Span {
  const own = runsSpan(ctx, panel.allRunIds);
  const first = panel.positions[0]?.at;
  const start = first === undefined ? own.start : new Date(first).toISOString();
  const last = panel.allRunIds.at(-1);
  const onward = next?.positions[0]?.at;
  if (last !== undefined && onward !== undefined && next?.allRunIds.includes(last))
    return { start, end: new Date(onward).toISOString() };
  return { start, end: own.end };
}

function details(
  ctx: StoryContext,
  runIds: readonly string[],
  span: Span,
  wholeRun: boolean
): PanelDetails {
  const costs = runIds.flatMap(id => ctx.facts.get(id)?.costUsd ?? []);
  const until = span.end === null ? ctx.now : Date.parse(span.end);
  return {
    ...span,
    durationMs: span.start === '' ? null : Math.max(0, until - Date.parse(span.start)),
    costUsd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
    wholeRun,
    models: [...new Set(runIds.flatMap(id => ctx.facts.get(id)?.models ?? []))],
    runs: runIds.map(id => ({ id, href: runHref(ctx.projectId, id) })),
  };
}

/**
 * The shadow decisions that belong in this panel and its grid does not show already: each
 * decision sits with the stage its step is on, so a delivery's round checks go to its Checks
 * panel, not to the Build panel the same run opened.
 */
function panelShadows(
  ctx: StoryContext,
  panel: StoryVisit,
  grid: RoundsGrid | null
): TimelineShadow[] {
  const shown = gridShadowKeys(grid, ctx.facts);
  const here = new Set(
    panel.allRunIds.flatMap(id => {
      const facts = ctx.facts.get(id);
      return (facts?.shadows ?? [])
        .filter(decision => {
          const stage = stageOfWorkflow(ctx.view, facts?.workflow ?? '', decision.node);
          return stage === undefined || stage.id === panel.stage.id;
        })
        .map(decision => `${decision.runId}|${decision.node}|${String(decision.round)}`);
    })
  );
  return panel.allRunIds
    .flatMap(id => ctx.rows.get(id)?.shadows ?? [])
    .filter(shadow => here.has(shadow.key) && !shown.has(shadow.key));
}

/**
 * What happened inside a panel with no grid, before its last run: each run that sent the item
 * back with its own words (`story.said`), and each fix folded into the panel with its outcome's
 * sentence. The panel's last run tells its own ending in the sentence.
 */
function panelEvents(ctx: StoryContext, panel: StoryVisit, grid: RoundsGrid | null): PanelEvent[] {
  if (grid !== null) return [];
  const last = panel.runIds.at(-1);
  return panel.allRunIds.flatMap((runId): PanelEvent[] => {
    if (runId === last) return [];
    const run = ctx.runs.get(runId);
    const workflow = ctx.facts.get(runId)?.workflow;
    if (run === undefined || workflow == null) return [];
    if (panel.fixRunIds.includes(runId) && !panel.runIds.includes(runId)) {
      const told =
        run.status === 'completed'
          ? toldOutcome(ctx.view, workflow, run.outcome, hasChange(ctx))
          : undefined;
      return told === undefined ? [] : [{ kind: 'fixed', runId, text: told }];
    }
    if (ctx.rows.get(runId)?.kind !== 'returned') return [];
    const reason = reasonOf(ctx.facts.get(runId)?.said);
    return reason === null ? [] : [{ kind: 'sent-back', runId, reason }];
  });
}

function stagePanel(
  ctx: StoryContext,
  panel: StoryVisit,
  index: number,
  next: StoryVisit | undefined,
  firsts: Map<string, string>,
  shared: boolean
): StagePanel {
  const own = ownRuns(ctx, panel, index);
  const grid = roundsGrid(ctx.view, ctx.detail, [...ctx.rows.values()], panel, next);
  const named = panel.allRunIds.find(id => firsts.has(id));
  const url = named === undefined ? undefined : firsts.get(named);
  if (named !== undefined) firsts.delete(named);
  const change = ctx.detail.item.progress?.change;
  const answered = answeredAsks(ctx, own);
  return {
    kind: 'stage',
    key: `${panel.stage.id}:${panel.number.toString()}`,
    stage: panel.stage,
    number: panel.number,
    sentence: panelSentence(ctx, panel, index, grid),
    pr: url === undefined ? null : { url, label: prLabel(url) },
    reason: panelReason(ctx, panel, index, grid),
    answered,
    youSaid: lastAnswer(answered, panel),
    runIds: own,
    grid,
    happened: panelEvents(ctx, panel, grid),
    details: details(ctx, panel.allRunIds, panelSpan(ctx, panel, next), shared),
    shadows: panelShadows(ctx, panel, grid),
    merged:
      panel.stage.id === ctx.view.landed.stage && change?.merged === true
        ? (change.mergedAt ?? null)
        : null,
  };
}

/** The discoveries drain's runs: on no stage, told quietly after the stage that started them. */
function drainPanels(ctx: StoryContext): (DrainPanel & { at: number })[] {
  const drain = ctx.view.discoveries?.workflow;
  if (drain === undefined) return [];
  return ctx.detail.item.runs
    .filter(run => ctx.facts.get(run.id)?.workflow === drain)
    .map(run => ({
      kind: 'drain',
      key: `drain:${run.id}`,
      at: Date.parse(run.startedAt),
      sentence: {
        text:
          statusSentence(ctx, 'The factory', run) ??
          toldOutcome(ctx.view, drain, run.outcome, hasChange(ctx)) ??
          'The factory looked for other work',
        mono: null,
      },
      details: details(ctx, [run.id], runsSpan(ctx, [run.id]), false),
      shadows: ctx.rows.get(run.id)?.shadows ?? [],
    }));
}

/**
 * Every panel of the story in the order it ran: the stage visits, the drains among them by
 * start, and a last Merged panel when the change merged and no run of the Merged stage tells it.
 */
export function itemStory(
  view: Declaration,
  projectId: string,
  detail: FactoryItemDetail,
  timeline: readonly TimelineRow[],
  now: number
): StoryPanel[] {
  const visits = storyVisits(view, detail);
  const home = new Map<string, number>();
  visits.forEach((visit, index) => {
    for (const id of visit.allRunIds) home.set(id, index);
  });
  const ctx: StoryContext = {
    view,
    projectId,
    detail,
    runs: new Map(detail.item.runs.map(run => [run.id, run])),
    facts: new Map(detail.runs.map(run => [run.runId, run])),
    rows: new Map(timeline.map(row => [row.runId, row])),
    now,
    home,
  };
  const firsts = firstNamers(detail);
  const panelsOf = (id: string) => visits.filter(visit => visit.allRunIds.includes(id)).length;
  const stages = visits.map((visit, index) => ({
    panel: stagePanel(
      ctx,
      visit,
      index,
      visits[index + 1],
      firsts,
      visit.allRunIds.some(id => panelsOf(id) > 1)
    ),
    at: visit.positions[0]?.at ?? 0,
  }));
  const ordered = [...stages, ...drainPanels(ctx).map(panel => ({ panel, at: panel.at }))]
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.panel);
  const change = detail.item.progress?.change;
  const told = stages.some(entry => entry.panel.stage.id === view.landed.stage);
  if (change?.merged !== true || told) return ordered;
  const stage = view.stages.find(entry => entry.id === view.landed.stage);
  return [...ordered, { kind: 'merged', key: 'merged', stage, at: change.mergedAt }];
}
