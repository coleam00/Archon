import type { FactoryItem } from '../skills/factory';
import type { AttentionQueue, AttentionQueueItem } from '../skills/runs';

/** A queue item a person acts on: everything but a usage limit. */
export type NeedsYouItem = Exclude<AttentionQueueItem, { kind: 'usage_limit' }>;

/** What an `overdue_wait` entry says: a stage is still waiting for an event past its deadline. */
export function overdueWaitMessage(item: Extract<NeedsYouItem, { kind: 'overdue_wait' }>): string {
  const what = item.waits.map(wait => wait.about || wait.event).join(', ');
  return `The ${item.waitingIn.workflow} run is still waiting for ${what || 'an event'} past its deadline.`;
}

/** The run an entry sits on, whatever its kind: the run holding the wait or the ask. */
function entryRun(entry: NeedsYouItem): { id: string; workflow: string } | undefined {
  if (entry.kind === 'overdue_wait')
    return { id: entry.waitingIn.runId, workflow: entry.waitingIn.workflow };
  return entry.run;
}

/**
 * What an `owner_lost` entry says: a run holds its item with no process to carry it on. The
 * sentence does not name the item: every place it is drawn names the item right above it (the
 * card's header, the Needs you panel, the popover's group, or the item's own page), and a
 * second spelling here could disagree with that one, such as a split member's raw key.
 */
export function ownerLostMessage(item: Extract<NeedsYouItem, { kind: 'owner_lost' }>): string {
  return `The ${item.run.workflow} run lost its owner and still holds its item.`;
}

/**
 * What needs a person in a project's attention queue, newest first. Every list and every
 * count of it reads this, so they cannot disagree.
 *
 * A `usage_limit` wait is left out: it takes no answer (the answer route refuses one) and
 * retries by itself when the limit resets. Items with no `pausedAt` (a gate records no
 * time) follow every timed item, in the order the server sent them.
 */
export function needsYou(items: readonly AttentionQueueItem[]): NeedsYouItem[] {
  const open = items.filter((item): item is NeedsYouItem => item.kind !== 'usage_limit');
  const time = (item: NeedsYouItem): number =>
    item.pausedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(item.pausedAt);
  // Array.prototype.sort is stable, so equal times keep the server's order.
  return open.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta === tb) return 0;
    return tb > ta ? 1 : -1;
  });
}

/**
 * What on the live queue waits on one item: an entry the item read lists among its questions
 * (it reads the item's whole run tree, so a wait inside a child run is one), or one the queue
 * itself names the item on. The item page and the map's chips both read this.
 */
export function itemAsks(
  item: Pick<FactoryItem, 'item' | 'questions'>,
  queue: readonly AttentionQueueItem[]
): NeedsYouItem[] {
  const refs = new Set(item.questions.map(question => question.ref));
  return needsYou(queue).filter(entry => refs.has(entry.ref) || entry.item?.id === item.item.id);
}

/**
 * The factory items waiting on a person with no ask open: their last run completed with an
 * outcome the view declares `awaits` (for example, an item waiting to be shaped again). An item that also has an
 * open question is not among them: its ask is what needs you, and it is counted once, there.
 * The board's `awaits` pill takes the same items.
 */
export function awaitingItems<T extends Pick<FactoryItem, 'questions' | 'progress'>>(
  items: readonly T[]
): T[] {
  return items.filter(
    item => item.progress?.awaits != null && needsYou(item.questions).length === 0
  );
}

/**
 * How many things need a person: the asks and waits, and, given a factory's items, the items
 * waiting on a person (`awaitingItems`). The one count the Needs you tab's badge, the Needs you
 * heading and the Factory Overview's number all read, so they never disagree.
 */
export function needsYouCount(
  queue: Pick<AttentionQueue, 'items'>,
  items: readonly Pick<FactoryItem, 'questions' | 'progress'>[] = []
): number {
  return needsYou(queue.items).length + awaitingItems(items).length;
}

/**
 * What the asks and waits sit on: how many items (each once), and how many runs that hold a
 * wait no item holds (each run once). A run with no item is a run, never counted as an item.
 */
export function needsYouSubjects(entries: readonly NeedsYouItem[]): {
  items: number;
  runs: number;
} {
  const items = new Set<string>();
  const runs = new Set<string>();
  for (const entry of entries) {
    if (entry.item !== undefined) items.add(entry.item.id);
    else runs.add(entryRun(entry)?.id ?? entry.ref);
  }
  return { items: items.size, runs: runs.size };
}

/** "on 2 items and 1 run": the Needs you heading's line, naming items and item-less runs apart. */
export function needsYouSubjectWords({ items, runs }: { items: number; runs: number }): string {
  const count = (n: number, word: string): string => `${n.toString()} ${word}${n === 1 ? '' : 's'}`;
  const parts = [
    ...(items > 0 ? [count(items, 'item')] : []),
    ...(runs > 0 ? [count(runs, 'run')] : []),
  ];
  return `on ${parts.join(' and ')}`;
}

/** The project's Needs you tab; `ask` names one ask (by its ref) for the page to bring forward. */
export function needsYouPath(projectId: string, ask?: string): string {
  const path = `/console/p/${projectId}/needs-you`;
  return ask === undefined ? path : `${path}?ask=${encodeURIComponent(ask)}`;
}

/** The workflow an ask or wait came from: the run that asked, else the run holding the wait. */
export function askWorkflow(entry: NeedsYouItem): string | undefined {
  if (entry.kind === 'attention' && entry.askedIn !== undefined) return entry.askedIn.workflow;
  return entryRun(entry)?.workflow;
}

/** The run an ask or wait belongs to: the run holding the wait, else the run that asked. */
export function askRunId(entry: NeedsYouItem): string | undefined {
  const run = entryRun(entry);
  if (run !== undefined) return run.id;
  return entry.kind === 'attention' ? entry.askedIn?.runId : undefined;
}

/** When the longest-waiting entry paused; undefined when none records a time (a gate records none). */
export function oldestWait(entries: readonly NeedsYouItem[]): string | undefined {
  const times = entries.flatMap(entry => (entry.pausedAt === null ? [] : [entry.pausedAt]));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}
