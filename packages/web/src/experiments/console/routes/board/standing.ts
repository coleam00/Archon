/**
 * How Rasmus's board reads an item's standing in the engine's own facts: its chip, the run it
 * stands at, and why it needs a decision. Shared by the board's card and its column headings.
 */
import type { ItemRead } from '../../skills/items';

export type Chip = ItemRead['standing']['state'] | 'needs_you';

/** The states of an item that is on a stage: something runs, is queued or waits on it. */
export const MOVING = ['running', 'waiting', 'queued'] as const;

export const isMoving = (read: ItemRead): boolean =>
  (MOVING as readonly string[]).includes(read.standing.state);

/**
 * Each chip's words, in the order chips are counted on a stage heading, and its tone: the
 * state's colour as text on its soft background, with Needs you the one filled chip (Visual
 * standard, rule 5).
 */
export const CHIP: Record<Chip, { label: string; tone: string }> = {
  needs_you: { label: 'Needs you', tone: 'bg-warning font-semibold text-surface-inset' },
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

/** An item that waits on the operator says so, whatever else is true of it. */
export function chipOf(read: ItemRead): Chip {
  const asked = read.questions.some(question => question.kind !== 'stopped');
  return asked && read.standing.state === 'waiting' ? 'needs_you' : read.standing.state;
}

/** The run the engine says the item stands at. */
export function standingRun(read: ItemRead): ItemRead['runs'][number] | undefined {
  return read.runs.find(run => run.id === read.standing.runId);
}

/**
 * A workflow the pack no longer has whose runs still count, and the stage (by workflow name)
 * an item standing on one of its runs is placed at; null places it nowhere. The factory view's
 * `retired`, as `retiredOf` (`factory/lib/item-card.ts`) reads it.
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

/** Why the item needs a decision, in the engine's own facts: what failed, or how its run ended. */
export function decisionReason(read: ItemRead): string {
  const run = standingRun(read);
  const stage = run?.pack?.workflow ?? run?.workflow ?? 'A run';
  if (read.standing.state === 'failed') return `${stage} failed`;
  const [stop] = read.questions.flatMap(question =>
    question.kind === 'stopped' ? [question] : []
  );
  if (stop === undefined)
    return `${stage} ended ${run?.outcome ?? 'with no outcome'} and nothing followed`;
  const ended = `${stage} ended ${stop.stoppedIn.outcome} and nothing followed`;
  return stop.summary === null ? ended : `${ended}: ${stop.summary}`;
}

export const runPath = (projectId: string, runId: string): string =>
  `/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(runId)}`;

/** How a done item ended, in the engine's facts: its change merged, or the outcome that finished it. */
export function howItEnded(read: ItemRead): string {
  if (read.merged !== null) return 'Merged';
  return standingRun(read)?.outcome ?? CHIP.done.label;
}
