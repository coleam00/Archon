/**
 * What a board card shows of an item beyond its standing: its title, the step running now,
 * its check rounds, how often it was sent back and why, its pull request, and how many asks
 * are open on it. Composed here, in the web, from generic reads:
 * the item read, run records, the forge's answers, the attention list's asks, and the pack's
 * factory view for every name and word. The engine knows none of these words.
 *
 * The board furniture builds on `cardProgress` and `CardProgress`: keep them stable.
 */
import type { ItemRead } from '../../skills/items';
import type { ItemAsk } from '../../primitives/run';
import type { FactoryView, ForgeSubjects, RunRecord } from '../api';
import { displayItemKey, issueNumber } from '../../lib/item-key';
import { retiredRun, type Retired } from '../../routes/board/standing';
import { listOf, runFacts, type RoundVerdict, type RunFacts, type RunRounds } from './run-facts';

type ReadRun = { run: ItemRun; workflow: string | null; facts: RunFacts };

type ItemRun = ItemRead['runs'][number];

const byStart = (a: ItemRun, b: ItemRun): number =>
  Date.parse(a.startedAt) - Date.parse(b.startedAt);
/** A graph stage as cards read it: its published name, its workflow and whether it is in flow. */
export type PackGraphStage = { name: string; workflow: string; inFlow: boolean };

/** The pack the board reads an item under: its graph's stages and its view, when it ships one. */
export interface CardPack {
  stages: readonly PackGraphStage[];
  view: FactoryView | null;
}

export interface CardProgress {
  /** The issue's title, the item's own, or its readable key when neither is known. */
  title: string;
  /** Whether `title` is the readable key, so the card does not print it twice. */
  titleIsKey: boolean;
  /** The item's key as a person reads it: `#123`, `#199 · board furniture`. */
  keyText: string;
  /** The newest running run's stage and step, in the view's words. */
  running: {
    stage: string;
    step: string | null;
    stepId?: string | null;
    workflow?: string | null;
  } | null;
  round: { dots: { iteration: number; verdict: RoundVerdict }[]; text: string } | null;
  returned: { count: number; text: string; reason: string | null } | null;
  /** The pull request, with the run that named it (null for the merge the item recorded). */
  pr: { url: string; number: number | null; run: string | null } | null;
  /** How many asks are open on the item; null when none are. */
  asks: { count: number } | null;
  /** A run record the card needs could not be read: its rounds and returns are unknown. */
  unread: boolean;
}

/** What was read for a list of cards, keyed for lookup. */
export interface CardReads {
  /** Records by run id; a run asked for and not here could not be read. */
  records: ReadonlyMap<string, RunRecord>;
  /** Run ids the records read was asked for. */
  asked: ReadonlySet<string>;
  forge: ForgeSubjects | null;
}

/**
 * The view workflow a run is: the graph stage whose `name` the run recorded, or, for a run of
 * a retired workflow, `<the graph's stage name prefix><retired>`. Structural names, never prose.
 */
export function viewWorkflow(
  pack: CardPack,
  run: Pick<ItemRun, 'workflow' | 'pack'>
): string | null {
  if (run.pack !== null) return run.pack.workflow;
  const stage = pack.stages.find(entry => entry.name === run.workflow);
  if (stage !== undefined) return stage.workflow;
  return retiredRun(pack.stages, retiredOf(pack.view), run.workflow)?.workflow ?? null;
}

/**
 * The view's `retired` entries in one shape: a bare name places nowhere, `{ workflow, stage }`
 * at that stage. Every reader of `retired` goes through this.
 */
export function retiredOf(view: Pick<FactoryView, 'retired'> | null | undefined): Retired[] {
  return (view?.retired ?? []).map(entry =>
    typeof entry === 'string' ? { workflow: entry, stage: null } : entry
  );
}

/**
 * The pack an item is read under: the one the engine says it stands at, else the newest run's
 * recorded pack, else the pack whose graph (or retired workflows) a run's workflow name
 * belongs to. Null when none of `packs` does.
 */
export function packOf(packs: ReadonlyMap<string, CardPack>, read: ItemRead): CardPack | null {
  const standing = read.standing.pack === null ? undefined : packs.get(read.standing.pack);
  if (standing !== undefined) return standing;
  for (const run of [...read.runs].sort(byStart).reverse()) {
    if (run.pack !== null) {
      const recorded = packs.get(run.pack.key);
      if (recorded !== undefined) return recorded;
      continue;
    }
    for (const pack of packs.values()) if (viewWorkflow(pack, run) !== null) return pack;
  }
  return null;
}

/** The workflows whose runs' records the card reads: every one the view's progress names. */
export function declaredWorkflows(view: FactoryView): Set<string> {
  return new Set([
    ...listOf(view.rounds).map(s => s.workflow),
    ...(view.returns ?? []).map(p => p.workflow),
    ...(view.approves ?? []).map(p => p.workflow),
    ...listOf(view.change).map(s => s.workflow),
  ]);
}

/** The runs of `read` whose records a card needs: declared workflows' runs, and running runs. */
export function runsToRead(pack: CardPack, read: ItemRead): string[] {
  if (pack.view === null) return [];
  const declared = declaredWorkflows(pack.view);
  return read.runs
    .filter(run => run.status === 'running' || declared.has(viewWorkflow(pack, run) ?? ''))
    .map(run => run.id);
}

/** The top-level result keys the view's pointers start with: all a records read keeps. */
export function resultKeys(view: FactoryView): string[] {
  const top = (pointer: string): string =>
    (pointer.split('/')[1] ?? '').replaceAll('~1', '/').replaceAll('~0', '~');
  return [
    ...new Set([
      ...listOf(view.rounds).flatMap(s => ('round' in s ? [top(s.round), top(s.allowance)] : [])),
      ...listOf(view.change).map(s => top(s.pointer)),
    ]),
  ];
}

/** The node output fields run facts read. */
export const OUTPUT_KEYS = ['outcome', 'summary'] as const;

/** The work order an item is part of: the key its active `part_of` link points at. */
function orderKey(read: ItemRead): string | null {
  return (
    read.links.find(
      link => link.kind === 'part_of' && link.direction === 'outgoing' && link.ended === null
    )?.other.key ?? null
  );
}

/** An undeclared step id made readable: loop prefixes dropped, a doubled include collapsed. */
function cleanedId(stepId: string): string {
  const step = stepId.split('.').at(-1) ?? '';
  const parts = step
    .split('__')
    .filter((part, index, all) => part !== '' && part !== all[index - 1])
    .map(part => part.replace(/[_-]+/g, ' ').trim())
    .filter(part => part !== '');
  return parts.length === 0 ? stepId : parts.join(': ');
}

/**
 * The item's rounds: the newest run that recorded one gives its source. A loop-form run's
 * rounds are its own; a stage-form source's rounds run across its runs, newest back while each
 * older round is numbered below the one after it (the rounds since the item was last planned).
 */
function itemRound(view: FactoryView, runs: readonly ReadRun[]): RunRounds | null {
  const newestFirst = [...runs].reverse();
  const recorded = newestFirst.find(entry => (entry.facts.rounds?.rounds.length ?? 0) > 0);
  if (recorded?.facts.rounds == null) return null;
  const source = listOf(view.rounds).find(s => s.workflow === recorded.workflow);
  if (source === undefined || 'loop' in source) return recorded.facts.rounds;
  const taken: { iteration: number; verdict: RoundVerdict; max: number | null }[] = [];
  for (const entry of newestFirst) {
    if (entry.workflow !== recorded.workflow) continue;
    const round = entry.facts.rounds?.rounds.at(-1);
    if (round === undefined) continue;
    const after = taken.at(-1);
    if (after !== undefined && round.iteration >= after.iteration) break;
    taken.push({ ...round, max: entry.facts.rounds?.max ?? null });
  }
  taken.reverse();
  return {
    max: taken.at(-1)?.max ?? null,
    rounds: taken.map(({ iteration, verdict }) => ({ iteration, verdict })),
  };
}

/**
 * Whether a run of a stage-form rounds workflow works the item now: a round its result has not
 * numbered yet, so it is never one of `itemRound`'s, which only completed runs give.
 */
function newRoundRunning(view: FactoryView, runs: readonly ReadRun[]): boolean {
  const running = [...runs].reverse().find(entry => entry.run.status === 'running');
  return listOf(view.rounds).some(
    source => !('loop' in source) && source.workflow === running?.workflow
  );
}

/**
 * The round line, read as v1 read it (`origin/main` factory/lib/board.ts `roundField`): "N of M
 * check rounds" for the rounds recorded, "first check round running" when a stage-form round
 * runs before any is recorded, and ", next one running" after the recorded ones. The running
 * round is never numbered: after a replan it is the first of a new count, not N+1, and a round
 * past the allowance is not one the card can name.
 */
function roundField(
  view: FactoryView,
  rounds: RunRounds | null,
  next: boolean
): CardProgress['round'] {
  const round = view.words?.round ?? 'round';
  if (rounds === null || rounds.rounds.length === 0)
    return next
      ? { dots: [{ iteration: 1, verdict: 'running' }], text: `first ${round} running` }
      : null;
  const dots = [...rounds.rounds];
  const last = dots.at(-1)?.iteration ?? 0;
  const words = view.words?.rounds ?? 'rounds';
  const counted =
    rounds.max === null
      ? `${String(last)} ${words}`
      : `${String(last)} of ${String(rounds.max)} ${words}`;
  if (!next) return { dots, text: counted };
  // The running dot's iteration is only its key.
  return {
    dots: [...dots, { iteration: last + 1, verdict: 'running' }],
    text: `${counted}, next one running`,
  };
}

/**
 * An option id in words, for an option that declares no label (Visual standard, rule 8):
 * `send-back` reads "Send back"; the reserved `other` reads "Something else".
 */
export function humaniseId(id: string): string {
  if (id === 'other') return 'Something else';
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The item's own title, else its issue's title as the forge names it; null when neither is known. */
function titleOf(read: ItemRead, issues: ForgeIssues, keyText: string): string | null {
  const own = read.item.title?.trim();
  if (own !== undefined && own !== '') return own;
  const number = issueNumber(read.item.key);
  if (number === null) return null;
  const issue = issues?.find(entry => String(entry.number) === number);
  const title = issue?.title?.trim();
  return title === undefined || title === '' || title === keyText ? null : title;
}

type ForgeIssues = ForgeSubjects['issues'] | null | undefined;

/**
 * How a person reads an item: its title (the item's own, else its issue's) and its key. The
 * card prints these, and the board's filter searches them, so what a card shows is what a
 * filter finds.
 */
export function itemTitle(
  read: ItemRead,
  issues: ForgeIssues
): Pick<CardProgress, 'title' | 'titleIsKey' | 'keyText'> {
  const keyText = displayItemKey(read.item.key, orderKey(read));
  const title = titleOf(read, issues, keyText);
  return { title: title ?? keyText, titleIsKey: title === null, keyText };
}

/** Whether `query` (lower case, trimmed) finds the item by its raw key or what its card shows. */
export function itemMatches(read: ItemRead, issues: ForgeIssues, query: string): boolean {
  if (query === '') return true;
  const { title, keyText } = itemTitle(read, issues);
  return [read.item.key, keyText, title].some(text => text.toLowerCase().includes(query));
}

/** The pull request: the newest declared run's named change, else the merge the item recorded. */
function prOf(
  read: ItemRead,
  runs: readonly { run: ItemRun; facts: RunFacts }[],
  forge: ForgeSubjects | null
): CardProgress['pr'] {
  const named = [...runs].reverse().find(entry => entry.facts.change !== null);
  const url = named?.facts.change ?? read.merged?.change ?? null;
  if (url === null) return null;
  const run = named === undefined ? null : named.run.id;
  const answer = forge?.changes.find(change => change.run === run && change.url === url);
  return { url, number: answer?.number ?? null, run };
}

/** The item's runs whose records were read, in start order, with their facts. */
function readRuns(read: ItemRead, pack: CardPack | null, reads: CardReads): ReadRun[] {
  const view = pack?.view ?? null;
  if (pack === null || view === null) return [];
  return [...read.runs].sort(byStart).flatMap(run => {
    const record = reads.records.get(run.id);
    if (record === undefined) return [];
    const workflow = viewWorkflow(pack, run);
    return [{ run, workflow, facts: runFacts(view, workflow, run, record) }];
  });
}

/**
 * The newest running run's stage and step in the view's words. Only a pack with a view reads
 * records, so with none there is no running line. A stage or step the view gives no words
 * reads as its workflow name or its cleaned step id.
 */
function runningField(view: FactoryView, runs: readonly ReadRun[]): CardProgress['running'] {
  const running = [...runs].reverse().find(entry => entry.run.status === 'running');
  if (running === undefined) return null;
  const words = running.workflow === null ? undefined : view.stages[running.workflow];
  const step = running.facts.active;
  return {
    stage: words?.label ?? running.workflow ?? running.run.workflow,
    step: step === null ? null : (words?.steps?.[step] ?? cleanedId(step)),
    stepId: step,
    workflow: running.workflow,
  };
}

function returnedField(view: FactoryView, runs: readonly ReadRun[]): CardProgress['returned'] {
  const returns = runs.flatMap(entry => entry.facts.returns);
  if (returns.length === 0) return null;
  return {
    count: returns.length,
    text: `${view.words?.sentBack ?? 'sent back'} ${String(returns.length)}x`,
    reason: returns.at(-1)?.summary ?? null,
  };
}

/** The card's progress for one item. `pack` null: the item stands at no pack the board read. */
export function cardProgress(
  read: ItemRead,
  pack: CardPack | null,
  reads: CardReads,
  asks: readonly ItemAsk[]
): CardProgress {
  const view = pack?.view ?? null;
  const wanted = pack === null ? [] : runsToRead(pack, read);
  const unread = wanted.some(id => reads.asked.has(id) && !reads.records.has(id));
  const runs = readRuns(read, pack, reads);
  const declared = view === null ? new Set<string>() : declaredWorkflows(view);
  const progressRuns = runs.filter(entry => declared.has(entry.workflow ?? ''));
  const counted = view !== null && !unread;
  return {
    ...itemTitle(read, reads.forge?.issues),
    running: view === null ? null : runningField(view, runs),
    round: counted
      ? roundField(view, itemRound(view, progressRuns), newRoundRunning(view, progressRuns))
      : null,
    returned: counted ? returnedField(view, progressRuns) : null,
    pr: prOf(read, progressRuns, reads.forge),
    asks: asks.length === 0 ? null : { count: asks.length },
    unread,
  };
}
