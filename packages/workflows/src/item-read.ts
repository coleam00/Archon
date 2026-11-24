/**
 * The read of one item (`workflow runs --item`): its runs, its starts that have no run yet,
 * the questions open in its runs, the answers recorded in them with the rulings recorded
 * on the item, each oldest first, and the links from and to it. Its starts still waiting
 * are listed with the queue order recorded for them, and its refused starts beside them. A
 * start waiting or refused because another run of its workflow works the item names that
 * run (`item-hold`). Where the item stands is left to the reader; this computes no stage
 * and stores nothing.
 */
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import {
  askItemRef,
  attentionQueueItemSchema,
  compareAge,
  isHeldByRun,
  listAttentionQueue,
  type AttentionQueueItem,
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
import { chosenAskOption, type StoredItemAsk } from './schemas/item-ask';
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
  type InstallHold,
  installHoldSchema,
  queuedItemStartSchema,
  type QueuedItemStart,
  readResourceStartReceiptId,
  startCause,
  startCauseSchema,
} from './schemas/resource-start';
import { runLimitSchema, type RunLimitState } from './schemas/run-limit';
import type { IWorkflowStore } from './store';
import {
  awaitingExecution,
  type StartExecutorObserver,
  type SkippedItemStart,
  type StartReceiptSource,
  type ResourceStartRequestInspection,
} from './resource-start-store';
import { itemHolder, itemHolders } from './item-hold';
import { runOwnerObservationSchema } from './schemas/workflow-run-listing';
import { readCompletedRunResult, resultCommitOf } from './run-result';
import { getTerminalRecord } from './terminal-record';
import { runPack, runPackSchema } from './run-pack';

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
 * `questions`.
 */
export const itemReadSchema = z.object({
  item: workflowItemSchema,
  runs: z.array(itemRunSchema),
  queued: z.array(itemQueuedStartSchema),
  skipped: z.array(itemSkippedStartSchema),
  hold: installHoldSchema.nullable(),
  held: z.array(itemHeldStartSchema),
  runLimit: runLimitSchema.nullable(),
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
      | 'listStartReceiptSources'
      | 'listOpenItemWaits'
      | 'getResourceStartRequest'
      | 'listQueuedItemStarts'
      | 'listSkippedItemStarts'
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

/**
 * The receipts the runs started from, by id. The receipt stays the one owner of why a start
 * happened; this only reads it.
 */
async function runReceipts(
  source: ItemReadSource,
  runs: readonly WorkflowRun[]
): Promise<ReadonlyMap<string, StartReceiptSource>> {
  const ids = runs.flatMap(run => readResourceStartReceiptId(run.metadata) ?? []);
  return ids.length === 0 ? new Map() : source.store.listStartReceiptSources(ids);
}

async function itemRun(
  source: ItemReadSource,
  run: WorkflowRun,
  receipts: ReadonlyMap<string, StartReceiptSource>,
  request: ResourceStartRequestInspection | null,
  heldBehind: ItemHeldBehind | null,
  terminalEvents: ReadonlyMap<string, WorkflowEventRow[]>
): Promise<ItemRun> {
  const receiptId = readResourceStartReceiptId(run.metadata);
  const receipt = receiptId ? receipts.get(receiptId) : undefined;
  const usage = parseRunUsage(run.metadata);
  return {
    id: run.id,
    workflow: run.workflow_name,
    pack: runPack(run),
    status: run.status,
    outcome: displayedRunOutcome(run),
    startedAt: run.started_at.toISOString(),
    completedAt: run.completed_at?.toISOString() ?? null,
    cause: receipt === undefined ? null : startCause(receipt),
    awaitingExecution: await awaitingExecution(request, run, source.startExecutor),
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

function field<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function itemAnswer(row: WorkflowEventRow): ItemAnswer {
  const { data } = row;
  const base = {
    runId: row.workflow_run_id,
    node: row.step_name,
    occurrence: field(z.string(), data.occurrence),
    at: row.created_at,
    via: field(recordSurfaceSchema, data.via),
  };
  if (row.event_type === 'wait_answered')
    return {
      kind: 'attention',
      ...base,
      answer: field(attentionAnswerSchema, data.answer),
      by: field(attentionAnswererSchema, data.by),
      fromRun: field(attentionAnsweringRunSchema, data.fromRun),
    };
  return {
    kind: 'gate',
    ...base,
    decision: field(z.string(), data.decision),
    // Approve and respond record `comment`; reject records `reason`.
    text: field(z.string(), data.comment) ?? field(z.string(), data.reason),
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

/** An answered or withdrawn ask as an entry of the item's answers; null while it is open or once replaced. */
function askAnswer({ id, runId, ask, closed }: StoredItemAsk): ItemAnswer | null {
  if (closed === null || closed.as === 'replaced') return null;
  const answer = closed.as === 'answered' ? closed.answer : null;
  return {
    kind: 'ask',
    runId,
    node: null,
    occurrence: null,
    at: closed.act.at,
    via: closed.act.via,
    ref: askItemRef(id),
    question: ask.question,
    answer,
    chosen: answer === null ? null : (chosenAskOption(ask, answer) ?? null),
    withdrawn: answer === null,
    by: closed.act.by,
    fromRun: closed.act.fromRun,
  };
}

/**
 * The answers and settled sets the item's asks hold: one entry per answered or withdrawn
 * ask, and one `asks_settled` per set whose asks all closed that way and all read, at its
 * last close. `unreadable` names the sets with a row that could not be read: any of those
 * rows may be an open ask, so the read cannot say the set settled.
 */
function askAnswers(asks: readonly StoredItemAsk[], unreadable: ReadonlySet<string>): ItemAnswer[] {
  const sets = new Map<string, StoredItemAsk[]>();
  for (const ask of asks) sets.set(ask.runId, [...(sets.get(ask.runId) ?? []), ask]);
  return [...sets].flatMap(([runId, set]) => {
    const closes = set.map(askAnswer).filter(answer => answer?.kind === 'ask');
    const [first] = closes;
    if (first === undefined || closes.length < set.length || unreadable.has(runId)) return closes;
    const answered = closes.filter(close => !close.withdrawn).length;
    const settled: ItemAnswer = {
      kind: 'asks_settled',
      runId,
      node: null,
      occurrence: null,
      at: closes.reduce(
        (last, close) => (Date.parse(close.at) > Date.parse(last) ? close.at : last),
        first.at
      ),
      via: null,
      answered,
      withdrawn: closes.length - answered,
    };
    return [...closes, settled];
  });
}

/** Read the item `key` names in project `projectKey`; null when there is no such item. */
export async function readItem(
  source: ItemReadSource,
  projectKey: string,
  key: string
): Promise<ItemRead | null> {
  const resolved = await readItemRuns(source.store, projectKey, key);
  if (resolved === null) return null;
  const [read] = await assembleItemReads(source, [resolved.item], await readItemQueue(source));
  return read ?? null;
}

type ItemQueueRead = ReturnType<typeof splitAttentionRead<AttentionQueueItem>>;

/**
 * The attention queue as an item read takes it, read once for any number of items. A
 * holder whose owner is gone is reported on the start held behind it, not as a question.
 */
export async function readItemQueue(source: ItemReadSource): Promise<ItemQueueRead> {
  // The one queue reader, so a question here reads as `workflow attention` lists it.
  return splitAttentionRead(await listAttentionQueue({ ...source, ownerLost: undefined }));
}

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
 * The install hold and the item's held, queued and skipped starts. The hold, queued and
 * skipped starts are read for a whole page of items at once.
 */
interface ItemStarts {
  hold: InstallHold | null;
  held: ItemHeldStart[];
  runLimit: RunLimitState | null;
  waiting: readonly QueuedItemStart[];
  skipped: readonly SkippedItemStart[];
}

/**
 * Build the reads of `items`, in their order, against one read of the attention queue, so a
 * reader of many items reads the queue and the items' starts once. A read is null when its
 * item has gone from the store.
 */
export async function assembleItemReads(
  source: ItemReadSource,
  items: readonly WorkflowItem[],
  queue: ItemQueueRead
): Promise<(ItemRead | null)[]> {
  const ids = items.map(item => item.id);
  // Held starts first, then queued starts, then every item's runs, the order a start moves
  // through: one that moves on between two reads shows twice, never in neither. An admitted
  // start shows in both queued and runs (its run id is its request id) and is listed once as
  // a run. Held starts are read per item: they wait for the install hold's lift or for
  // their host's next drain, so they are read whether or not a hold is set.
  const hold = await source.store.getInstallHold();
  const held = new Map<string, ItemHeldStart[]>();
  for (const id of ids) held.set(id, await source.store.listHeldItemStarts(id));
  const waiting = await source.store.listQueuedItemStarts(ids);
  const runLimit = await source.store.getRunLimit();
  const skipped = await source.store.listSkippedItemStarts(ids);
  const reads: (ItemRead | null)[] = [];
  for (const item of items) {
    // bun:sqlite answers synchronously, so every store read resolves without leaving the
    // event loop: without a turn between items, a page of item reads holds the server end
    // to end and every other request waits behind it (#58).
    await new Promise<void>(resolve => setImmediate(resolve));
    reads.push(
      await assembleItemRead(source, item, queue, {
        hold,
        held: held.get(item.id) ?? [],
        runLimit,
        waiting: waiting.get(item.id) ?? [],
        skipped: skipped.get(item.id) ?? [],
      })
    );
  }
  return reads;
}

/** The read of one item, against the page's queue and starts. */
async function assembleItemRead(
  source: ItemReadSource,
  item: WorkflowItem,
  queue: ItemQueueRead,
  starts: ItemStarts
): Promise<ItemRead | null> {
  const found = await readItemRuns(source.store, item.projectKey, item.key);
  if (found === null) return null;
  const own = { values: found.runs, degraded: found.degraded };
  const tree = new Set([
    ...own.values.map(run => run.id),
    ...own.degraded.map(report => report.runId),
    ...found.descendantIds,
  ]);
  const { values, degraded } = queue;
  // An ask no run holds belongs to the item it was left on.
  const questions = values
    .filter(question =>
      isHeldByRun(question) ? tree.has(question.run.id) : question.item?.id === found.item.id
    )
    .sort(compareAge);
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
  const queued: ItemQueuedStart[] = [];
  for (const start of starts.waiting.filter(start => !tree.has(start.requestId)))
    queued.push({
      ...start,
      heldBehind: (await holds.queuedHeldBehind(start)) ?? null,
      waitsForRunLimit: starts.runLimit?.waiting.includes(start.requestId) ?? false,
    });
  const skipped: ItemSkippedStart[] = [];
  for (const start of starts.skipped)
    skipped.push({
      requestId: start.requestId,
      workflow: start.workflow,
      resource: start.resource,
      heldBehind: (await holds.skippedHeldBehind(start)) ?? null,
    });
  const receipts = await runReceipts(source, own.values);
  return {
    item: found.item,
    runs: await Promise.all(
      own.values.map(async run =>
        itemRun(
          source,
          run,
          receipts,
          holds.request(run.id),
          (await holds.runHeldBehind(run)) ?? null,
          terminalEvents
        )
      )
    ),
    queued,
    skipped,
    hold: starts.hold,
    held: starts.held,
    runLimit: starts.runLimit && { limit: starts.runLimit.limit, live: starts.runLimit.live },
    waits: (await source.store.listOpenItemWaits(found.item.id)).map(wait => ({
      event: wait.event,
      about: wait.about,
      workflow: wait.workflowName,
      runId: wait.runId,
      waitingSince: wait.openedAt,
      deadline: wait.deadlineAt,
      overdue: Date.parse(wait.deadlineAt) <= Date.now(),
    })),
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
