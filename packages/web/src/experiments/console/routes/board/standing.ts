/**
 * How Rasmus's board reads an item's standing in the engine's own facts: its state's words and
 * tone, the run it stands at, and why it needs a decision. Shared by the board's card and its
 * column headings. Whether an item has open asks is not read here (`factory/lib/item-asks.ts`).
 */
import type { ItemRead } from '../../skills/items';

export type Chip = ItemRead['standing']['state'] | 'needs_you';

/** The states of an item that is on a stage: something runs, is queued or waits on it. */
export const MOVING = ['running', 'waiting', 'queued'] as const;

export const isMoving = (read: ItemRead): boolean =>
  (MOVING as readonly string[]).includes(read.standing.state);

/**
 * Each chip's words, in the order chips are counted on a stage heading, and its tone: the
 * state's colour as text on its soft background (Visual standard, rule 5). A card's label is
 * its item's state; `needs_you` is the words and tone where a surface says an item has open
 * asks (a column header's chip, a stage's item line, a work-order dot), soft like the others.
 */
export const CHIP: Record<Chip, { label: string; tone: string }> = {
  needs_you: { label: 'Needs you', tone: 'bg-[color:var(--warning-soft)] text-warning' },
  running: { label: 'Running', tone: 'bg-[color:var(--running-soft)] text-[color:var(--running)]' },
  waiting: { label: 'Waiting', tone: 'bg-surface-inset text-text-tertiary' },
  queued: { label: 'Queued', tone: 'bg-surface-inset text-text-tertiary' },
  failed: { label: 'Failed', tone: 'bg-[color:var(--error-soft)] text-error' },
  stopped: { label: 'Stopped', tone: 'bg-[color:var(--error-soft)] text-error' },
  done: { label: 'Done', tone: 'bg-[color:var(--success-soft)] text-success' },
  resting: {
    label: 'At rest',
    tone: 'bg-surface-inset text-text-secondary ring-1 ring-inset ring-border',
  },
};

/** The run the engine says the item stands at. */
export function standingRun(read: ItemRead): ItemRead['runs'][number] | undefined {
  return read.runs.find(run => run.id === read.standing.runId);
}

/**
 * A workflow the pack no longer has whose runs still count, and the stage (by workflow name)
 * an item standing on one of its runs is placed at; null places it nowhere. The graph words'
 * `retired`, from each stage's `display.replaces` (`factory/lib/graph-view.ts`).
 */
export interface Retired {
  workflow: string;
  stage: string | null;
}

type StageNames = readonly { name: string; workflow: string }[];

/**
 * The retired workflow a run is, by its published name: `<the graph's stage name prefix><retired>`
 * (a run from an older build recorded no workflow name). Structural names, never prose.
 */
export function retiredRun(
  stages: StageNames,
  retired: readonly Retired[],
  runWorkflow: string
): Retired | undefined {
  for (const entry of retired)
    for (const stage of stages)
      if (stage.name.endsWith(`:${stage.workflow}`)) {
        const prefix = stage.name.slice(0, stage.name.length - stage.workflow.length);
        if (runWorkflow === `${prefix}${entry.workflow}`) return entry;
      }
  return undefined;
}

/**
 * The stage an item stands at: the workflow its run recorded in its pack, else the graph stage
 * whose published name the run carries (a run from an older build recorded no workflow name).
 * A run of a retired workflow stands at the stage `retired` maps it to, else at none. The
 * board's columns, its Set aside strip and the overview's flow all place by it.
 */
export function stageAt(
  read: ItemRead,
  stages: StageNames | undefined,
  retired: readonly Retired[] = []
): string | undefined {
  const run = standingRun(read);
  if (run === undefined) return undefined;
  const mapped = (entry: Retired | undefined): string | undefined => entry?.stage ?? undefined;
  if (run.pack !== null) {
    const recorded = run.pack.workflow;
    const old = retired.find(entry => entry.workflow === recorded);
    return old === undefined ? recorded : mapped(old);
  }
  const stage = stages?.find(entry => entry.name === run.workflow);
  if (stage !== undefined) return stage.workflow;
  return stages === undefined ? undefined : mapped(retiredRun(stages, retired, run.workflow));
}

/** The run a card or a row opens: the one the item stands at, else its newest. */
export function runToOpen(read: ItemRead): ItemRead['runs'][number] | undefined {
  return (
    standingRun(read) ??
    [...read.runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
  );
}

/**
 * A failed or stopped item stays so until a newer run starts on it or its change merges, so an
 * operator has to decide.
 */
export const needsDecision = (read: ItemRead): boolean =>
  read.standing.state === 'failed' || read.standing.state === 'stopped';

/**
 * A run's outcome in words (`runOutcomeWords` in `factory/lib/item-card.ts`, by
 * `outcomeWords` in `factory/lib/graph-structure.ts`). It arrives as a callback, as `stageOf` does, because
 * `item-card.ts` imports this file.
 */
export type OutcomeWords = (
  run: Pick<ItemRead['runs'][number], 'workflow' | 'pack'>,
  outcome: string
) => string;

/**
 * Why the item needs a decision, in the engine's own facts: what failed, or how its run ended.
 * `stageOf` names the run's stage (`runStageName`, which words even a run no pack places) and
 * `outcomeOf` its outcome, so the reason prints neither a workflow id nor a raw outcome. A label
 * is a phrase of its own, so it sits in parentheses mid-sentence.
 */
export function decisionReason(
  read: ItemRead,
  stageOf: (run: ItemRead['runs'][number]) => string,
  outcomeOf: OutcomeWords
): string {
  const run = standingRun(read);
  const stage = run === undefined ? 'A run' : stageOf(run);
  if (read.standing.state === 'failed') return `${stage} failed`;
  const [stop] = read.questions.flatMap(question =>
    question.kind === 'stopped' ? [question] : []
  );
  const how = (
    of: Parameters<OutcomeWords>[0] | undefined,
    outcome: string | null | undefined
  ): string =>
    of === undefined || outcome == null ? 'with no outcome' : `(${outcomeOf(of, outcome)})`;
  if (stop === undefined) return `${stage} ended ${how(run, run?.outcome)} and nothing followed`;
  // The words are keyed on the run that stopped, which the question names.
  const stopped = read.runs.find(entry => entry.id === stop.stoppedIn.runId) ?? {
    workflow: stop.stoppedIn.workflow,
    pack: null,
  };
  const ended = `${stage} ended ${how(stopped, stop.stoppedIn.outcome)} and nothing followed`;
  return stop.summary === null ? ended : `${ended}: ${stop.summary}`;
}

export const runPath = (projectId: string, runId: string): string =>
  `/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(runId)}`;

/**
 * How a done item ended: its change merged, or the outcome that finished it in `outcomeOf`'s
 * words; Done when its run recorded none.
 */
export function howItEnded(read: ItemRead, outcomeOf: OutcomeWords): string {
  if (read.merged !== null) return 'Merged';
  const run = standingRun(read);
  return run?.outcome == null ? CHIP.done.label : outcomeOf(run, run.outcome);
}
