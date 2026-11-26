/**
 * The attention queue's items that no run holds: the asks completed runs left
 * (`returns.asks`, see `schemas/item-ask.ts`) and their waits still open past a deadline
 * (`returns.waits`, see `schemas/item-wait.ts`). A host joins them to the one reader through
 * `AttentionQueueSource.itemsWithoutRun`. A wait's deadline raises attention and wakes
 * nothing; the set stays open until an event meets it, a newer run of its workflow replaces
 * it, or it is withdrawn by its `wait:` ref. A completed step that stopped its item (see
 * `readItemStopped`), or a failed top-level step, is listed while it is the newest step on
 * the item (a run that observes it is no step), the item's end does not hold (`item-end.ts`) and no merge is recorded on it
 * (`getItemMerge`); it takes no answer. Asks and waits on an item whose end holds are left
 * out too: an item at rest asks nothing.
 */
import { createLogger } from '@archon/paths';
import { isOwnerProvablyGone } from '@archon/paths/process-owner';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  askItemRef,
  preparingItemRef,
  refusedStartRef,
  stoppedItemRef,
  unreadableStartRef,
  waitItemRef,
} from './attention-item-refs';
import { isAttentionDegraded, type AttentionRead } from './schemas/attention-degraded';
import {
  projectRef,
  projectRefForRun,
  runProject,
  type AskQueueItem,
  type AttentionQueueItemSources,
  type AttentionQueueItemWithoutRun,
  type CodebaseCache,
  type OverdueWaitQueueItem,
  type PreparationLostQueueItem,
  type RefusedStartQueueItem,
  type StoppedQueueItem,
  type UnreadableStartQueueItem,
} from './attention-queue';
import { readHoldingItemEnd, type ItemEndStore } from './item-end';
import { readItemStopped, type ItemStopped } from './schemas/run-metadata';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { getTerminalRecord, terminalReason } from './terminal-record';
import type { TerminalRecord } from './schemas/terminal-record';
import {
  isOutcomeUnknownRun,
  liveUnknownOutcomes,
  UNKNOWN_OUTCOME_EVENT_TYPES,
} from './unknown-outcome';
import type { WorkflowRun } from './schemas/workflow-run';
import type { StoredItemAsk } from './schemas/item-ask';
import type { StoredItemWait } from './schemas/item-wait';
import { OTHER_ATTENTION_OPTION } from './schemas/wait-node';
import { stateProjectKeySchema } from './state-document-store';
import type { IWorkflowStore } from './store';

/** The store reads an ask's queue item needs. */
export type AskItemStore = Pick<
  IWorkflowStore,
  'listOpenItemAsks' | 'getItem' | 'getWorkflowRun' | 'getCodebase'
>;

/**
 * Whether the end on item `itemId` holds, read once per item for one listing. An item at
 * rest asks nothing: its open asks and waits stay recorded, and show again if a newer step
 * opens it.
 */
function endHoldsOn(store: ItemEndStore): (itemId: string) => Promise<boolean> {
  const read = new Map<string, Promise<boolean>>();
  return itemId => {
    let holds = read.get(itemId);
    if (holds === undefined) {
      holds = readHoldingItemEnd(store, itemId).then(end => end !== null && !('type' in end));
      read.set(itemId, holds);
    }
    return holds;
  };
}

/**
 * The queue item an ask is: a `select` question with the reserved `other` option, held by
 * no run. Its project is the run's that left it, by the rule every item uses, or, once
 * that run is gone, the item's own project key.
 */
export async function askQueueItem(
  store: Omit<AskItemStore, 'listOpenItemAsks'>,
  ask: StoredItemAsk,
  codebases: CodebaseCache = new Map()
): Promise<AskQueueItem> {
  const item = await store.getItem(ask.itemId);
  const run = await store.getWorkflowRun(ask.runId);
  const project =
    run !== null
      ? await runProject({ store }, run, codebases)
      : item !== null && stateProjectKeySchema.safeParse(item.projectKey).success
        ? projectRef(item.projectKey, null)
        : null;
  return {
    kind: 'attention',
    ref: askItemRef(ask.id),
    project,
    ...(item === null ? {} : { item }),
    revision: 1,
    labels: {},
    pausedAt: ask.openedAt,
    message: ask.ask.question,
    form: 'select',
    options: [
      ...ask.ask.options.map(option => ({ id: option.id, does: option.does, cost: option.cost })),
      OTHER_ATTENTION_OPTION,
    ],
    other: true,
    ...(ask.ask.recommendation === null
      ? ask.ask.no_recommendation === undefined
        ? {}
        : { noRecommendation: ask.ask.no_recommendation }
      : {
          recommendation: {
            option: ask.ask.recommendation.option,
            why: ask.ask.recommendation.why,
          },
        }),
    context: ask.ask.context,
    artifacts: ask.ask.artifacts.map(({ type, run_id, path }) => ({ type, run_id, path })),
    askedIn: { runId: ask.runId, workflow: ask.workflowName },
  };
}

/**
 * The open asks as queue items, for `AttentionQueueSource.itemsWithoutRun`, but for those on
 * an item whose end holds (`readHoldingItemEnd`).
 */
export async function openAskItems(
  store: AskItemStore & ItemEndStore
): Promise<AttentionRead<AskQueueItem>[]> {
  const codebases: CodebaseCache = new Map();
  const ended = endHoldsOn(store);
  const items: AttentionRead<AskQueueItem>[] = [];
  for (const ask of await store.listOpenItemAsks()) {
    if (isAttentionDegraded(ask)) items.push(ask);
    else if (!(await ended(ask.itemId))) items.push(await askQueueItem(store, ask, codebases));
  }
  return items;
}

/** The store reads an overdue wait's queue item needs. */
export type WaitItemStore = Pick<
  IWorkflowStore,
  'listOpenItemWaits' | 'getItem' | 'getWorkflowRun' | 'getCodebase'
>;

/**
 * The queue item a set of open waits is, held by no run, with its project found as an
 * ask's is. Built for any open set; the queue lists only the overdue ones.
 */
export async function waitQueueItem(
  store: Omit<WaitItemStore, 'listOpenItemWaits'>,
  set: readonly [StoredItemWait, ...StoredItemWait[]],
  codebases: CodebaseCache = new Map()
): Promise<OverdueWaitQueueItem> {
  const [first] = set;
  const item = await store.getItem(first.itemId);
  const run = await store.getWorkflowRun(first.runId);
  const project =
    run !== null
      ? await runProject({ store }, run, codebases)
      : item !== null && stateProjectKeySchema.safeParse(item.projectKey).success
        ? projectRef(item.projectKey, null)
        : null;
  return {
    kind: 'overdue_wait',
    ref: waitItemRef(first.runId),
    project,
    ...(item === null ? {} : { item }),
    revision: 1,
    labels: {},
    pausedAt: first.openedAt,
    waitingIn: { runId: first.runId, workflow: first.workflowName },
    waits: set.map(({ event, about }) => ({ event, about })),
    deadline: set.map(wait => wait.deadlineAt).sort()[0] ?? first.deadlineAt,
  };
}

/** The open waits as sets, one per run that left them, in the store's order. */
export function waitSets(
  waits: readonly StoredItemWait[]
): [StoredItemWait, ...StoredItemWait[]][] {
  const sets = new Map<string, [StoredItemWait, ...StoredItemWait[]]>();
  for (const wait of waits) {
    const set = sets.get(wait.runId);
    if (set === undefined) sets.set(wait.runId, [wait]);
    else set.push(wait);
  }
  return [...sets.values()];
}

/**
 * The sets of open waits past their deadline at `now`, as queue items, for
 * `AttentionQueueSource.itemsWithoutRun`, but for those on an item whose end holds. A wait's
 * deadline raises attention and wakes nothing: the set stays open, and a later event still
 * meets it.
 */
export async function overdueWaitItems(
  store: WaitItemStore & ItemEndStore,
  now: Date = new Date()
): Promise<AttentionQueueItemWithoutRun[]> {
  const codebases: CodebaseCache = new Map();
  const ended = endHoldsOn(store);
  const items: AttentionQueueItemWithoutRun[] = [];
  for (const set of waitSets(await store.listOpenItemWaits()))
    if (
      set.some(wait => Date.parse(wait.deadlineAt) <= now.getTime()) &&
      !(await ended(set[0].itemId))
    )
      items.push(await waitQueueItem(store, set, codebases));
  return items;
}

/** The store reads a stopped item's queue item needs. */
export type StoppedItemStore = Pick<
  IWorkflowStore,
  'listStoppedItemRuns' | 'listEventsForRuns' | 'getItem' | 'getCodebase' | 'getItemMerge'
> &
  ItemEndStore;

/**
 * The queue item of an item `run` stopped, or null when the run has no item, or completed
 * and recorded no stop. A failed run stopped its item by failing: nothing moves it on by
 * itself. A run that failed with stop reason `outcome_unknown` is listed with no item and as
 * a child too. A run that settled asks may have no outcome; a refused start's stop dates from
 * its latest refusal. Nothing here changes the item. Each surface spells the commands that
 * read it and start a new run on it, which closes the item.
 */
export async function stoppedQueueItem(
  store: Pick<StoppedItemStore, 'getItem' | 'getCodebase'>,
  run: WorkflowRun,
  codebases: CodebaseCache = new Map(),
  /** A failed run's `workflow_failed` events, which carry what failed first. */
  failedEvents: readonly WorkflowEventRow[] = [],
  /** For a run that failed with an unknown outcome, its live ones (`liveUnknownOutcomes`). */
  unknownNodes: readonly string[] = []
): Promise<StoppedQueueItem | null> {
  const failed = run.status === 'failed';
  const stopped: ItemStopped | undefined = failed
    ? { summary: null }
    : readItemStopped(run.metadata);
  if (stopped === undefined || (run.item_id === null && !isOutcomeUnknownRun(run))) return null;
  const item = run.item_id === null ? null : await store.getItem(run.item_id);
  let codebase: AttentionQueueItemSources['codebase'] = null;
  if (run.codebase_id !== null) {
    const read = codebases.get(run.codebase_id) ?? store.getCodebase(run.codebase_id);
    codebases.set(run.codebase_id, read);
    codebase = await read;
  }
  return {
    kind: 'stopped',
    ref: stoppedItemRef(run.id),
    project: projectRefForRun(run, codebase),
    ...(item === null ? {} : { item }),
    revision: 1,
    labels: {},
    pausedAt: stopped.refused?.at(-1)?.refusedAt ?? run.completed_at?.toISOString() ?? null,
    stoppedIn: { runId: run.id, workflow: run.workflow_name, outcome: run.completed_outcome },
    summary: stopped.summary,
    ...(stopped.limit === undefined ? {} : { limit: stopped.limit }),
    ...(stopped.refused === undefined ? {} : { refused: stopped.refused }),
    ...(failed ? { failed: failedStop(run, failedEvents, unknownNodes) } : {}),
    checkout: codebase?.default_cwd ?? null,
  };
}

/**
 * Why a failed run failed, as `workflow get` says it: the first failed node's error from the
 * terminal record. A run whose record is missing or unreadable falls back to the error the
 * run recorded (`metadata.error`), which `workflow get` shows too; null when it has neither.
 * A run that failed with stop reason `outcome_unknown` also names its live unknown outcomes
 * (`liveUnknownOutcomes`): an instance's or loop body's own step path.
 */
function failedStop(
  run: WorkflowRun,
  events: readonly WorkflowEventRow[],
  unknownNodes: readonly string[]
): NonNullable<StoppedQueueItem['failed']> {
  let record: TerminalRecord | null = null;
  try {
    record = getTerminalRecord('failed', events);
  } catch (error) {
    createLogger('workflow.attention_queue').warn(
      { err: error as Error, runId: run.id },
      'workflow.stopped_item_terminal_record_unreadable'
    );
  }
  const reason = terminalReason(record)[0];
  const recorded = run.metadata.error;
  const error =
    reason !== undefined && reason.trim() !== ''
      ? reason
      : typeof recorded === 'string' && recorded.trim() !== ''
        ? recorded
        : null;
  return isOutcomeUnknownRun(run) ? { error, outcomeUnknown: [...unknownNodes] } : { error };
}

/**
 * The items runs stopped, for `AttentionQueueSource.itemsWithoutRun`, but for an item whose
 * end holds (`readHoldingItemEnd`), where an operator said nothing more happens on it, or
 * whose merge is recorded (`getItemMerge`), where its change landed. Neither compares times:
 * a run that failed after the merge leaves the item done.
 */
export async function stoppedItems(
  store: StoppedItemStore
): Promise<AttentionRead<StoppedQueueItem>[]> {
  const codebases: CodebaseCache = new Map();
  const items: AttentionRead<StoppedQueueItem>[] = [];
  const runs = await store.listStoppedItemRuns();
  const failedIds = runs.flatMap(run =>
    !isAttentionDegraded(run) && run.status === 'failed' ? [run.id] : []
  );
  const failedEvents =
    failedIds.length === 0
      ? new Map<string, WorkflowEventRow[]>()
      : await store.listEventsForRuns(failedIds, ['workflow_failed']);
  const unknownRuns = runs.filter(
    (run): run is WorkflowRun => !isAttentionDegraded(run) && isOutcomeUnknownRun(run)
  );
  const unknownEvents =
    unknownRuns.length === 0
      ? new Map<string, WorkflowEventRow[]>()
      : await store.listEventsForRuns(
          unknownRuns.map(run => run.id),
          UNKNOWN_OUTCOME_EVENT_TYPES
        );
  for (const run of runs) {
    if (isAttentionDegraded(run)) {
      items.push(run);
      continue;
    }
    // A run whose outcome is unknown stays until resumed or abandoned, even past an item end.
    if (!isOutcomeUnknownRun(run) && (await isItemDone(store, run.item_id))) continue;
    const unknownNodes = isOutcomeUnknownRun(run)
      ? liveUnknownOutcomes(run, unknownEvents.get(run.id) ?? [])
      : [];
    const item = await stoppedQueueItem(
      store,
      run,
      codebases,
      failedEvents.get(run.id),
      unknownNodes
    );
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Whether item `itemId` needs nothing more: its end holds or its merge is recorded. An
 * unreadable end or merge row reads as not done, so it does not hide the stop.
 */
async function isItemDone(store: StoppedItemStore, itemId: string | null): Promise<boolean> {
  if (itemId === null) return false;
  const end = await readHoldingItemEnd(store, itemId);
  if (end !== null && !('type' in end)) return true;
  const merge = await store.getItemMerge(itemId);
  return merge !== null && !('type' in merge);
}

/** The store reads a lost preparation's queue item needs. */
export type PreparingItemStore = Pick<IWorkflowStore, 'listPreparingStarts' | 'getStartReceipt'>;

/**
 * The binding starts whose preparer this process can prove gone, as queue items, for
 * `AttentionQueueSource.itemsWithoutRun`. A preparer is gone only when it ran on this host
 * and no process with its pid and instance exists (`isOwnerProvablyGone`); one with no
 * record, or on another host, is unknown and never listed. A binding that left `preparing`
 * or changed owner after the list was read is not listed: its preparer finished.
 */
export async function preparationLostItems(
  store: PreparingItemStore
): Promise<PreparationLostQueueItem[]> {
  const items: PreparationLostQueueItem[] = [];
  for (const start of await store.listPreparingStarts()) {
    if (start.preparer === null || !isOwnerProvablyGone(start.preparer)) continue;
    const { receiptId, bindingId, hostId, workflow, itemKey, ownerId } = start;
    const binding = (await store.getStartReceipt(receiptId))?.bindings.find(
      found => found.bindingId === bindingId
    );
    if (binding?.status !== 'preparing' || binding.ownerId !== ownerId) continue;
    const { codebase } = start;
    items.push({
      kind: 'preparation_lost',
      ref: preparingItemRef(receiptId, bindingId),
      project:
        codebase === null
          ? null
          : projectRef(projectKeyForCodebase(codebase, codebase.default_cwd), codebase),
      ...(start.item === null ? {} : { item: start.item }),
      revision: 1,
      labels: {},
      pausedAt: start.claimedAt,
      start: { receiptId, bindingId, hostId, workflow, itemKey, ownerId },
    });
  }
  return items;
}

/** The store reads an unreadable queued request's queue item needs. */
export type UnreadableStartItemStore = Pick<
  IWorkflowStore,
  'listUnreadableQueuedStarts' | 'getItem'
>;

/**
 * The queued requests whose stored launch does not read, as queue items, for
 * `AttentionQueueSource.itemsWithoutRun`: each holds the queue behind it, and only a
 * withdrawal moves it. On its item, and in that item's project, when its item reads.
 */
export async function unreadableStartItems(
  store: UnreadableStartItemStore
): Promise<UnreadableStartQueueItem[]> {
  const items: UnreadableStartQueueItem[] = [];
  for (const start of await store.listUnreadableQueuedStarts()) {
    const item = start.itemId === null ? null : await store.getItem(start.itemId);
    items.push({
      kind: 'unreadable_start',
      ref: unreadableStartRef(start.requestId),
      project: item === null ? null : projectRef(item.projectKey, null),
      ...(item === null ? {} : { item }),
      revision: 1,
      labels: {},
      pausedAt: start.queuedAt,
      start: {
        requestId: start.requestId,
        resource: start.resource,
        hostId: start.hostId,
        behind: start.behind,
      },
    });
  }
  return items;
}

/** The store read a refused start's queue item needs. */
export type RefusedStartItemStore = Pick<IWorkflowStore, 'listRefusedStarts'>;

/**
 * The refused starts no run caused that are still their item's newest step, as queue items,
 * for `AttentionQueueSource.itemsWithoutRun`. The store decides which those are; nothing
 * here changes them.
 */
export async function refusedStartItems(
  store: RefusedStartItemStore
): Promise<RefusedStartQueueItem[]> {
  return (await store.listRefusedStarts()).map(start => {
    const { receiptId, bindingId, hostId, workflow, itemKey, refusal, codebase } = start;
    return {
      kind: 'refused_start',
      ref: refusedStartRef(receiptId, bindingId),
      project:
        codebase === null
          ? null
          : projectRef(projectKeyForCodebase(codebase, codebase.default_cwd), codebase),
      ...(start.item === null ? {} : { item: start.item }),
      revision: 1,
      labels: {},
      pausedAt: start.refusedAt,
      start: {
        receiptId,
        bindingId,
        hostId,
        workflow,
        itemKey,
        reason: refusal.reason,
        ...(refusal.limit === undefined ? {} : { limit: refusal.limit }),
        ...(refusal.fileSetting === undefined ? {} : { fileSetting: refusal.fileSetting }),
      },
    };
  });
}
