/**
 * How Rasmus's board reads an item's standing in the engine's own facts: its chip, the run it
 * stands at, and why it needs a decision. Shared by the board's card and its column headings.
 */
import type { ItemRead } from '../../skills/items';

export type Chip = ItemRead['standing']['state'] | 'needs_you';

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

/** How a done item ended, in the engine's facts: its change merged, or its run's final outcome. */
export function howItEnded(read: ItemRead): string {
  if (read.merged !== null) return 'Merged';
  return standingRun(read)?.outcome ?? CHIP.done.label;
}
