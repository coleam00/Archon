/**
 * The read of one item (`workflow runs --item`): its runs, its starts that have no run yet,
 * the questions open in its runs, the answers recorded in them with the rulings recorded
 * on the item, each oldest first, and the links from and to it. Its starts still waiting
 * are listed with the queue order recorded for them, and its refused starts beside them. A
 * start waiting or refused because another run of its workflow works the item names that
 * run (`item-hold`). Where the item stands (`standing`) is derived here on every read, so
 * each reader places the item the same way; nothing about it is stored.
 */
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import {
  attentionQueueItemSchema,
  compareAge,
  isHeldByRun,
  listAttentionQueue,
  type AttentionQueueSource,
} from './attention-queue';
import {
  attentionDegradedSchema,
  splitAttentionRead,
  type AttentionDegraded,
  type IdentifiedAttentionDegraded,
} from './schemas/attention-degraded';
import { itemActFields } from './schemas/item-act';
import { operatorPause, operatorPauseSchema } from './schemas/operator-pause';
import {
  itemLinkDegradedSchema,
  itemLinkKindSchema,
  type ItemLink,
  type ItemLinkDegraded,
} from './schemas/item-link';
import {
  itemRulingDegradedSchema,
  itemRulingSchema,
  type ItemRulingDegraded,
  type ItemRuling,
} from './schemas/item-ruling';
import {
  itemMergeDegradedSchema,
  itemMergeSchema,
  type ItemMergeDegraded,
} from './schemas/item-merge';
import { itemLandingUnresolvedSchema, resolvedItemLandingSchema } from './schemas/item-landing';
import { ItemLandingUnresolvedError, resolveItemLanding } from './item-landing';
import { recordSurfaceSchema } from './schemas/record-surface';
import { parseRunUsage } from './schemas/run-usage';
import { workflowRunStatusSchema } from './schemas/run-status';
import {
  attentionAnswererSchema,
  attentionAnsweringRunSchema,
  attentionAnswerSchema,
  displayedRunOutcome,
  workflowItemSchema,
  type WorkflowItem,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { awaitingExecutionSchema } from './schemas/start-executor';
import {
  installHoldSchema,
  queuedItemStartSchema,
  type QueuedItemStart,
  readResourceStartReceiptId,
  startCause,
  startCauseSchema,
} from './schemas/resource-start';
import { runLimitSchema } from './schemas/run-limit';
import type { IWorkflowStore } from './store';
import {
  awaitingExecution,
  type StartExecutorObserver,
  type SkippedItemStart,
  type ResourceStartRequestInspection,
} from './resource-start-store';
import { itemHolder, itemHolders } from './item-hold';
import { runOwnerObservationSchema } from './schemas/workflow-run-listing';
import { readCompletedRunResult, resultCommitOf } from './run-result';
import { getTerminalRecord } from './terminal-record';
import { runPack, runPackSchema } from './run-pack';
import { startLimitStandingSchema } from './start-limit';
import { itemStanding, itemStandingSchema, type ItemStanding } from './item-standing';
import { askAnswers, itemAnswer } from './item-answers';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.item-read');
  return cachedLog;
}

/**
 * The run of the same workflow that holds the item, which a start waits behind or was
 * refused for. `owner` is what the reading process observes about that run's execution
 * owner while its state needs one (`observeRunOwner`: running, or paused on a sub-run that
 * runs in its process). `unreachable`: its owner is gone, and only an operator's
 * `archon workflow resume` or `archon workflow abandon` moves it. Null when the run needs
 * no owner now or the reader observes no owners. The engine never ends that run by itself.
 */
export const itemHeldBehindSchema = z.object({
  runId: z.string(),
  workflow: z.string(),
  status: workflowRunStatusSchema,
  owner: runOwnerObservationSchema.nullable(),
});
export type ItemHeldBehind = z.infer<typeof itemHeldBehindSchema>;

export const itemRunSchema = z.object({
  id: z.string(),
  /** The name the run started under: `owner/plugin:<entrypoint>` for an installed pack's workflow. */
  workflow: z.string(),
  /** Match your own pack's runs by `pack.key` and `pack.workflow`; null outside a pack or on older runs. */
  pack: runPackSchema.nullable(),
  status: workflowRunStatusSchema,
  /** The outcome the run completed with, of either form; null until it completes. */
  outcome: z.string().nullable(),
  startedAt: z.string().datetime(),
  /** Null while the run has not ended. */
  completedAt: z.string().datetime().nullable(),
  /**
   * What started the run, read from the start receipt its start recorded: a run that
   * ended (on this item, or on an item linked to it), a node that fired it, or another
   * trigger source. Null for a start by hand, which has no receipt.
   */
  cause: startCauseSchema.nullable(),
  /** Set while the run's start is admitted but no executor has claimed it. */
  awaitingExecution: awaitingExecutionSchema.nullable(),
  /**
   * The name of the start limit the run's start counted under (its binding's `limit`), or
   * null when it counted under none. A run finds where its limit stands in the item read's
   * `startLimits` under this name. `left: 0` allows no further start; starts already queued
   * under the limit are counted in `used` and still run.
   */
  startLimit: z.string().nullable(),
  /** The totals recorded on the run row; null where the run recorded no figure. */
  spend: z.object({
    usd: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
  }),
  /**
   * Set while the run is a pending start waiting for another run of its workflow on the
   * item, and kept on a start that was refused for it (`--no-wait`), which is cancelled.
   */
  heldBehind: itemHeldBehindSchema.nullable(),
  /**
   * An operator's pause: requested on a running run, which pauses once its running nodes
   * finish, or the pause a paused run is in. Null otherwise.
   */
  operatorPause: operatorPauseSchema.nullable(),
  /**
   * The run completed with a readable `returns:` value: the value a `result_of` input
   * naming its workflow reads while it is the latest completed run. Read it with
   * `archon workflow get <id> --json` at `terminal_record.returns.value`, or from the run
   * detail API.
   */
  hasResult: z.boolean(),
  /**
   * The commit the run's result holds at, which an `at: checkout` input matches: the clean
   * checkout its `returns:` node completed on, unchanged when the run completed. Null when the
   * run has not completed, its result holds at no commit, or it was recorded before results
   * held at commits.
   */
  resultCommit: z.string().nullable(),
});
export type ItemRun = z.infer<typeof itemRunSchema>;

/**
 * A start on the item still waiting for admission, which has no run yet. `heldBehind`
 * names the run of its workflow that holds the item now, when one does; null when it
 * waits for capacity or its checkout only, or its workflow does not read. `waitsForRunLimit`:
 * only the run limit holds it now (`RunLimitState.waiting`).
 */
export const itemQueuedStartSchema = queuedItemStartSchema.extend({
  heldBehind: itemHeldBehindSchema.nullable(),
  waitsForRunLimit: z.boolean(),
});
export type ItemQueuedStart = z.infer<typeof itemQueuedStartSchema>;

/**
 * A start on the item that was refused (its binding's `overlap: skip`) and has no run.
 * `heldBehind` names the run of its workflow on the item it was refused for; null when it
 * was refused for capacity or its checkout instead. `workflow` is null when the stored
 * launch does not read.
 */
export const itemSkippedStartSchema = z.object({
  requestId: z.string(),
  workflow: z.string().nullable(),
  resource: z.string(),
  heldBehind: itemHeldBehindSchema.nullable(),
});
export type ItemSkippedStart = z.infer<typeof itemSkippedStartSchema>;

/**
 * A start on the item from a trigger's binding that is not yet prepared, so it has no
 * request or run. Under the install hold it waits for the lift; otherwise for the next
 * drain of its host (`hostId`), which prepares it and admits, queues or skips it by its
 * binding's `overlap`. `workflow` is null when the stored binding does not read.
 */
export const itemHeldStartSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  hostId: z.string().nullable(),
  workflow: z.string().nullable(),
  receivedAt: z.string(),
});
export type ItemHeldStart = z.infer<typeof itemHeldStartSchema>;

/**
 * Where an answer was recorded. A field the event row does not carry is null, so an older
 * row still reads as an answer with its run, node and time.
 */
const answerFields = {
  runId: z.string(),
  node: z.string().nullable(),
  occurrence: z.string().nullable(),
  at: z.string(),
  via: recordSurfaceSchema.nullable(),
};

/**
 * One recorded answer: `attention` answers a question (`wait_answered`), `gate` resolves an
 * approval gate (`approval_received`), `ruling` is a decision recorded on the item with no
 * question asked (`ItemRuling`), which no run holds. `text` on a gate is its comment, or a
 * rejection's reason. A withdrawn ruling stays, with `withdrawn` set. `ask` answers or
 * withdraws an ask a completed run left, and `asks_settled` records that the last open ask
 * of that run's set closed, with how many were answered and withdrawn: `answered: 0` means
 * nothing was. Both read from the item's ask rows, not from run events, so they stay on the
 * item after the run that left the asks is deleted; `runId` names that run, `node` and
 * `occurrence` are null. A set that a newer one replaced before it closed never settles. A
 * set with an ask row that cannot be read does not settle in the read either; `degraded`
 * names its run.
 */
export const itemAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attention'),
    ...answerFields,
    answer: attentionAnswerSchema.nullable(),
    by: attentionAnswererSchema.nullable(),
    /** Reported from the answering run's environment and not verified. */
    fromRun: attentionAnsweringRunSchema.nullable(),
  }),
  z.object({
    kind: z.literal('gate'),
    ...answerFields,
    decision: z.string().nullable(),
    text: z.string().nullable(),
  }),
  itemRulingSchema,
  z.object({
    kind: z.literal('ask'),
    ...answerFields,
    /** The ask's ref, as the queue listed it. */
    ref: z.string(),
    /** What was asked. */
    question: z.string(),
    /** Null for a withdrawal. */
    answer: attentionAnswerSchema.nullable(),
    /** The option the answer chose and what it does; null when none is recorded. */
    chosen: z.object({ id: z.string(), does: z.string() }).nullable(),
    withdrawn: z.boolean(),
    by: attentionAnswererSchema.nullable(),
    /** Reported from the answering run's environment and not verified. */
    fromRun: attentionAnsweringRunSchema.nullable(),
  }),
  z.object({
    kind: z.literal('asks_settled'),
    ...answerFields,
    answered: z.number().int().nonnegative(),
    withdrawn: z.number().int().nonnegative(),
  }),
]);
export type ItemAnswer = z.infer<typeof itemAnswerSchema>;

/** Every answer kind, checked against `ItemAnswer` so a new kind cannot be left out. */
export const itemAnswerKindSchema = z.enum({
  attention: 'attention',
  gate: 'gate',
  ruling: 'ruling',
  ask: 'ask',
  asks_settled: 'asks_settled',
} satisfies { [Kind in ItemAnswer['kind']]: Kind });

/**
 * A link seen from the item read: `outgoing` when this item is the link's `from` (it
 * depends on, is part of, or is a duplicate of `other`), `incoming` when `other` points at
 * this item. An ended link stays, with `ended` set; a link is active while `ended` is null.
 */
/** An open wait on the item, as the item read lists it. */
export const itemOpenWaitSchema = z.object({
  event: z.string(),
  about: z.string(),
  workflow: z.string(),
  runId: z.string(),
  waitingSince: z.string().datetime(),
  deadline: z.string().datetime(),
  overdue: z.boolean(),
});
export type ItemOpenWait = z.infer<typeof itemOpenWaitSchema>;

export const itemReadLinkSchema = z.object({
  id: z.string(),
  kind: itemLinkKindSchema,
  direction: z.enum(['outgoing', 'incoming']),
  other: workflowItemSchema,
  ...itemActFields,
  ended: z.object(itemActFields).nullable(),
});
export type ItemReadLink = z.infer<typeof itemReadLinkSchema>;

/**
 * An item and what is recorded about it. `runs` are the item's own readable runs; a
 * `workflow:` child is left to `workflow get` on its parent. `questions` and `answers` come from the
 * whole run tree, because a question is often asked inside a child; each names the run
 * that holds it. `queued` are the item's starts still waiting, which have no run yet;
 * `archon trigger withdraw <requestId>` withdraws one. `skipped` are its refused starts.
 * `hold` is the install hold while it is set, else null; `held` are the item's trigger
 * starts not yet prepared into `queued` or a run: kept by the hold while it is set, else
 * waiting for their host's next drain. `runLimit`: see `RunLimit`.
 * `degraded` names each part that could not be read: one of the item's own runs, a paused
 * run the queue could not read (`run_unreadable`, by `runId`), a ruling
 * (`ruling_unreadable`, by `rulingId`), a link (`link_unreadable`, by `linkId`), or the
 * merge (`merge_unreadable`), or where the item lands (`landing_unresolved`). The rest
 * still reads. `merged` is the merge the forge reported for the item's change, recorded
 * once; null while none is recorded or when its row could not be read. `landing` is the
 * branch a fresh run on the item is cut from and proposes against, and where it came from:
 * the item's own record, or the nearest item it is `part_of`. Null when neither records
 * one, or when it cannot be resolved. The read does not check that the branch is on the
 * remote; a run does when it starts. `waits` are what the item waits for outside Archon:
 * the open waits completed runs left on it (`returns.waits`), each with when it opened and
 * fell due, and `overdue` once that time has passed. An overdue set is also among
 * `questions`. `startLimits` are the start limits of the bindings that started work on the
 * item: for each, how many starts it allows, how many are used, granted and left, and since
 * when it counts. A binding at `left: 0` is refused its next start on the item, and the
 * refusal is on its receipt (`trigger inspect`). `standing` is where the item stands: see
 * `itemStandingSchema`.
 */
export const itemReadSchema = z.object({
  item: workflowItemSchema,
  standing: itemStandingSchema,
  runs: z.array(itemRunSchema),
  queued: z.array(itemQueuedStartSchema),
  skipped: z.array(itemSkippedStartSchema),
  hold: installHoldSchema.nullable(),
  held: z.array(itemHeldStartSchema),
  runLimit: runLimitSchema.nullable(),
  startLimits: z.array(startLimitStandingSchema),
  waits: z.array(itemOpenWaitSchema),
  questions: z.array(attentionQueueItemSchema),
  answers: z.array(itemAnswerSchema),
  links: z.array(itemReadLinkSchema),
  merged: itemMergeSchema.nullable(),
  landing: resolvedItemLandingSchema.nullable(),
  degraded: z.array(
    z.discriminatedUnion('reason', [
      attentionDegradedSchema,
      itemRulingDegradedSchema,
      itemMergeDegradedSchema,
      itemLinkDegradedSchema,
      itemLandingUnresolvedSchema,
    ])
  ),
});
export type ItemRead = z.infer<typeof itemReadSchema>;

export interface ItemReadSource extends AttentionQueueSource {
  store: AttentionQueueSource['store'] &
    Pick<
      IWorkflowStore,
      | 'getItemRuns'
      | 'listEventsForRuns'
      | 'listItemRulings'
      | 'getItemMerge'
      | 'getItemLanding'
      | 'listItemLinks'
      | 'listItemAsks'
      | 'listOpenItemWaits'
      | 'getStartReceipt'
      | 'getResourceStartRequest'
      | 'listQueuedItemStarts'
      | 'listSkippedItemStarts'
      | 'readItemStartLimits'
      | 'getInstallHold'
      | 'listHeldItemStarts'
      | 'getRunLimit'
    >;
  /** Observes an awaiting start's executor; without it, the start reads `unknown`. */
  startExecutor?: StartExecutorObserver;
}

function readResult(
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): Pick<ItemRun, 'hasResult' | 'resultCommit'> {
  try {
    return {
      hasResult: readCompletedRunResult(run, events).kind === 'result',
      resultCommit:
        run.status === 'completed' ? resultCommitOf(getTerminalRecord(run.status, events)) : null,
    };
  } catch (error) {
    // One unreadable record must not fail the whole item read.
    getLog().warn({ err: error, workflowRunId: run.id }, 'item_read.terminal_record_unreadable');
    return { hasResult: false, resultCommit: null };
  }
}

/** The `workflow_completed` events of the completed runs, which hold their results. */
async function completionEvents(
  source: ItemReadSource,
  runs: readonly WorkflowRun[]
): Promise<ReadonlyMap<string, WorkflowEventRow[]>> {
  const completedIds = runs.filter(run => run.status === 'completed').map(run => run.id);
  if (completedIds.length === 0) return new Map();
  return source.store.listEventsForRuns(completedIds, ['workflow_completed']);
}

async function itemRun(
  source: ItemReadSource,
  run: WorkflowRun,
  request: ResourceStartRequestInspection | null,
  heldBehind: ItemHeldBehind | null,
  terminalEvents: ReadonlyMap<string, WorkflowEventRow[]>,
  startLimit: string | null
): Promise<ItemRun> {
  // The receipt stays the one owner of why a start happened; this only reads it.
  const receiptId = readResourceStartReceiptId(run.metadata);
  const receipt = receiptId ? await source.store.getStartReceipt(receiptId) : null;
  const usage = parseRunUsage(run.metadata);
  return {
    id: run.id,
    workflow: run.workflow_name,
    pack: runPack(run),
    status: run.status,
    outcome: displayedRunOutcome(run),
    startedAt: run.started_at.toISOString(),
    completedAt: run.completed_at?.toISOString() ?? null,
    cause: receipt ? startCause(receipt) : null,
    awaitingExecution: await awaitingExecution(request, run, source.startExecutor),
    startLimit,
    spend: {
      usd: usage.costUsd ?? null,
      inputTokens: usage.tokens?.input ?? null,
      outputTokens: usage.tokens?.output ?? null,
    },
    heldBehind,
    operatorPause: operatorPause(run),
    ...readResult(run, terminalEvents.get(run.id) ?? []),
  };
}

/**
 * Who holds the item for each of its workflows, from the item's own runs (`itemHolders`),
 * and a reader of the run a start is held behind. A pending run's start request says
 * whether it was admitted.
 */
async function itemHolds(source: ItemReadSource, itemId: string, runs: readonly WorkflowRun[]) {
  const requests = new Map<string, ResourceStartRequestInspection | null>();
  for (const run of runs)
    if (run.status === 'pending')
      requests.set(run.id, await source.store.getResourceStartRequest(run.id));
  // A start refused because a run held the item records that run on its cancellation.
  const cancelled = runs.filter(run => run.status === 'cancelled').map(run => run.id);
  const refusedBy = new Map<string, string>();
  if (cancelled.length > 0)
    for (const [runId, events] of await source.store.listEventsForRuns(cancelled, [
      'workflow_cancelled',
    ])) {
      const holder = events.map(event => event.data.held_by_run_id).find(id => id !== undefined);
      if (typeof holder === 'string') refusedBy.set(runId, holder);
    }
  const rows = runs.map(run => ({
    id: run.id,
    workflow_name: run.workflow_name,
    item_id: itemId,
    status: run.status,
    admitted: requests.get(run.id)?.status === 'admitted',
  }));
  const byId = new Map(runs.map(run => [run.id, run]));
  const behind = new Map<string, Promise<ItemHeldBehind>>();
  const describe = (runId: string): Promise<ItemHeldBehind> | null => {
    const run = byId.get(runId);
    if (run === undefined) return null;
    let read = behind.get(runId);
    if (read === undefined) {
      read = (async () => ({
        runId,
        workflow: run.workflow_name,
        status: run.status,
        owner: source.ownerLost === undefined ? null : await source.ownerLost.observe(run),
      }))();
      behind.set(runId, read);
    }
    return read;
  };
  // Leave the start's own run out before choosing the oldest holder, as the claim does: an
  // admitted pending run holds the item itself and would otherwise hide a newer holder.
  const holderOf = (runId: string, workflow: string): Promise<ItemHeldBehind> | null => {
    const held = itemHolders(rows.filter(row => row.id !== runId));
    const holder = itemHolder(held, { runId, workflow, itemId });
    return holder === undefined ? null : describe(holder);
  };
  return {
    request: (runId: string) => requests.get(runId) ?? null,
    /**
     * A pending run waits behind another run of its workflow on the item: a hand start that
     * has not won its turn, or an admitted run whose claim is refused for that holder.
     */
    runHeldBehind: (run: WorkflowRun) => {
      const refused = refusedBy.get(run.id);
      if (refused !== undefined)
        return byId.get(refused)?.workflow_name === run.workflow_name ? describe(refused) : null;
      return run.status === 'pending' ? holderOf(run.id, run.workflow_name) : null;
    },
    /** A queued start waits behind its workflow's holder now, not the blocker it stored. */
    queuedHeldBehind: (start: QueuedItemStart) =>
      start.workflow === null ? null : holderOf(start.requestId, start.workflow),
    /** A skipped start keeps the blocker it was refused for. */
    skippedHeldBehind: (start: SkippedItemStart) => {
      const blocker = start.blockerRunId === null ? undefined : byId.get(start.blockerRunId);
      return blocker !== undefined && blocker.workflow_name === start.workflow
        ? describe(blocker.id)
        : null;
    },
  };
}

function readLink(itemId: string, link: ItemLink): ItemReadLink {
  const { from, to, ...rest } = link;
  // A link joins two different items, so exactly one side is this item.
  const outgoing = from.id === itemId;
  return { ...rest, direction: outgoing ? 'outgoing' : 'incoming', other: outgoing ? to : from };
}

/**
 * The item `key` names in project `projectKey` and its own runs, in start order: the one
 * read of an item's runs, for the item read and for every verb that acts on an item.
 * `degraded` names each own run whose row could not be read. Null when there is no such item.
 */
export async function readItemRuns(
  store: Pick<IWorkflowStore, 'getItemRuns'>,
  projectKey: string,
  key: string
): Promise<{
  item: WorkflowItem;
  runs: WorkflowRun[];
  degraded: IdentifiedAttentionDegraded[];
  descendantIds: string[];
} | null> {
  const found = await store.getItemRuns(projectKey, key);
  if (found === null) return null;
  const { values, degraded } = splitAttentionRead(found.runs);
  return { item: found.item, runs: values, degraded, descendantIds: found.descendantIds };
}

function distinctByRun(reports: readonly AttentionDegraded[]): AttentionDegraded[] {
  return reports.filter(
    (report, index) => reports.findIndex(other => other.runId === report.runId) === index
  );
}

/** Read the item `key` names in project `projectKey`; null when there is no such item. */
export async function readItem(
  source: ItemReadSource,
  projectKey: string,
  key: string
): Promise<ItemRead | null> {
  const resolved = await readItemRuns(source.store, projectKey, key);
  if (resolved === null) return null;
  const placed = await placeItem(source, resolved.item, await readInstallFacts(source));
  return placed === null ? null : placed.read();
}

/**
 * What an item read takes from the install as a whole, read once for any number of items:
 * the install hold, the unprepared binding starts, the run limit and the attention queue.
 * A holder whose owner is gone is reported on the start held behind it, not as a question.
 */
export async function readInstallFacts(source: ItemReadSource) {
  // Held starts before any item's queued starts and runs, the order a start moves through:
  // one that moves on between two reads shows twice, never in neither.
  const hold = await source.store.getInstallHold();
  const held = await source.store.listHeldItemStarts();
  return {
    hold,
    held,
    runLimit: await source.store.getRunLimit(),
    // The one queue reader, so a question here reads as `workflow attention` lists it.
    queue: splitAttentionRead(await listAttentionQueue({ ...source, ownerLost: undefined })),
  };
}
type InstallFacts = Awaited<ReturnType<typeof readInstallFacts>>;

/** Where the item lands, through the resolver a run uses; a resolution error is reported, not thrown. */
async function readLanding(source: ItemReadSource, item: WorkflowItem) {
  try {
    return { landing: await resolveItemLanding(source.store, item), degraded: [] };
  } catch (error) {
    if (!(error instanceof ItemLandingUnresolvedError)) throw error;
    return {
      landing: null,
      degraded: [
        {
          type: 'degraded' as const,
          reason: 'landing_unresolved' as const,
          message: error.message,
        },
      ],
    };
  }
}

/** The facts recorded on the item itself: its rulings, its links, its merge and its landing. */
async function readItemFacts(source: ItemReadSource, item: WorkflowItem) {
  const itemId = item.id;
  const rulings: ItemRuling[] = [];
  const unreadableRulings: ItemRulingDegraded[] = [];
  for (const read of await source.store.listItemRulings(itemId))
    if ('type' in read) unreadableRulings.push(read);
    else rulings.push(read);
  const links: ItemReadLink[] = [];
  const unreadableLinks: ItemLinkDegraded[] = [];
  for (const read of await source.store.listItemLinks(itemId))
    if ('type' in read) unreadableLinks.push(read);
    else links.push(readLink(itemId, read));
  const merge = await source.store.getItemMerge(itemId);
  const unreadableMerge: ItemMergeDegraded[] = merge !== null && 'type' in merge ? [merge] : [];
  const landing = await readLanding(source, item);
  return {
    rulings,
    links,
    merged: merge !== null && !('type' in merge) ? merge : null,
    landing: landing.landing,
    degraded: [...unreadableRulings, ...unreadableMerge, ...unreadableLinks, ...landing.degraded],
  };
}

/**
 * Where the item stands, from the few reads that decide it, and `read` for the rest of the
 * item. A reader of many items that keeps only some of them (`readItemWindow` with `open`)
 * reads the rest of those alone. Null when the item has gone from the store.
 */
export async function placeItem(
  source: ItemReadSource,
  item: WorkflowItem,
  install: InstallFacts
): Promise<{ standing: ItemStanding; read: () => Promise<ItemRead> } | null> {
  const { hold, runLimit } = install;
  const held = install.held
    .filter(start => start.projectKey === item.projectKey && start.itemKey === item.key)
    .map(({ receiptId, bindingId, hostId, workflow, receivedAt }) => ({
      receiptId,
      bindingId,
      hostId,
      workflow,
      receivedAt,
    }));
  // An admitted start shows in both queued and runs (its run id is its request id) and is
  // listed once as a run.
  const waiting = await source.store.listQueuedItemStarts(item.id);
  const found = await readItemRuns(source.store, item.projectKey, item.key);
  if (found === null) return null;
  const own = { values: found.runs, degraded: found.degraded };
  const tree = new Set([
    ...own.values.map(run => run.id),
    ...own.degraded.map(report => report.runId),
    ...found.descendantIds,
  ]);
  const { values, degraded } = install.queue;
  // An ask no run holds belongs to the item it was left on.
  const questions = values
    .filter(question =>
      isHeldByRun(question) ? tree.has(question.run.id) : question.item?.id === found.item.id
    )
    .sort(compareAge);
  const queuedStarts = waiting.filter(start => !tree.has(start.requestId));
  const waits = (await source.store.listOpenItemWaits(found.item.id)).map(wait => ({
    event: wait.event,
    about: wait.about,
    workflow: wait.workflowName,
    runId: wait.runId,
    waitingSince: wait.openedAt,
    deadline: wait.deadlineAt,
    overdue: Date.parse(wait.deadlineAt) <= Date.now(),
  }));
  const standing = itemStanding({ runs: own.values, queued: queuedStarts, held, waits, questions });
  const read = async (): Promise<ItemRead> => {
    const events =
      tree.size === 0
        ? new Map<string, WorkflowEventRow[]>()
        : await source.store.listEventsForRuns([...tree], ['wait_answered', 'approval_received']);
    const facts = await readItemFacts(source, found.item);
    const terminalEvents = await completionEvents(source, own.values);
    const asks = splitAttentionRead(await source.store.listItemAsks(found.item.id));
    const answers = [
      ...[...events.values()].flat().map(itemAnswer),
      ...facts.rulings,
      ...askAnswers(asks.values, new Set(asks.degraded.map(report => report.runId))),
    ]
      // Stable, so rows that tie on `at` keep their store order: append order within a run,
      // recording order among rulings, and a set's last answer before its settle.
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const holds = await itemHolds(source, found.item.id, own.values);
    const startLimits = await source.store.readItemStartLimits(found.item.id);
    const queued: ItemQueuedStart[] = [];
    for (const start of queuedStarts)
      queued.push({
        ...start,
        heldBehind: (await holds.queuedHeldBehind(start)) ?? null,
        waitsForRunLimit: runLimit?.waiting.includes(start.requestId) ?? false,
      });
    const skipped: ItemSkippedStart[] = [];
    for (const start of await source.store.listSkippedItemStarts(found.item.id))
      skipped.push({
        requestId: start.requestId,
        workflow: start.workflow,
        resource: start.resource,
        heldBehind: (await holds.skippedHeldBehind(start)) ?? null,
      });
    return {
      item: found.item,
      standing,
      runs: await Promise.all(
        own.values.map(async run =>
          itemRun(
            source,
            run,
            holds.request(run.id),
            (await holds.runHeldBehind(run)) ?? null,
            terminalEvents,
            startLimits.countedUnder[run.id] ?? null
          )
        )
      ),
      queued,
      skipped,
      hold,
      held,
      runLimit: runLimit && { limit: runLimit.limit, live: runLimit.live },
      startLimits: startLimits.limits,
      waits,
      questions,
      answers,
      links: facts.links,
      merged: facts.merged,
      landing: facts.landing,
      // A paused item run the store could not read is in both reports, and an unreadable
      // open ask in the queue's and the item's; list each run once.
      degraded: [
        ...distinctByRun([
          ...own.degraded,
          ...degraded.filter(report => tree.has(report.runId)),
          ...asks.degraded,
        ]),
        ...facts.degraded,
      ],
    };
  };
  return { standing, read };
}

/**
 * Read the item the run `runId` belongs to: the item of its root run, since a `workflow:`
 * child carries no item of its own. Null when the run is unknown or its root names no item.
 */
export async function readItemOfRun(
  source: ItemReadSource,
  runId: string
): Promise<ItemRead | null> {
  let run = await source.store.getWorkflowRun(runId);
  while (run?.parent_run_id) run = await source.store.getWorkflowRun(run.parent_run_id);
  if (!run?.item_id) return null;
  const item = await source.store.getItem(run.item_id);
  return item === null ? null : readItem(source, item.projectKey, item.key);
}
