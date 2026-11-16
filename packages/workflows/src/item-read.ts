/**
 * The read of one item (`workflow runs --item`): its runs, its starts that have no run yet,
 * the questions open in its runs, the answers recorded in them with the rulings recorded
 * on the item, each oldest first, and the links from and to it. A start waiting or refused
 * because another run of its workflow works the item names that run (`item-hold`).
 * Where the item stands is left to the reader; this computes no position and stores nothing.
 */
import { z } from 'zod';
import {
  askItemRef,
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
} from './schemas/attention-degraded';
import { itemActFields } from './schemas/item-act';
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
import { recordSurfaceSchema } from './schemas/record-surface';
import { chosenAskOption, type StoredItemAsk } from './schemas/item-ask';
import { workflowRunStatusSchema } from './schemas/run-status';
import {
  attentionAnswererSchema,
  attentionAnsweringRunSchema,
  attentionAnswerSchema,
  displayedRunOutcome,
  workflowItemSchema,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { readResourceStartReceiptId, startCause, startCauseSchema } from './schemas/resource-start';
import type { IWorkflowStore } from './store';
import {
  awaitingExecution,
  type ItemStartRequest,
  type ResourceStartRequestInspection,
} from './resource-start-store';
import { holdsItem, itemHolder, itemHolders } from './item-hold';
import { runOwnerObservationSchema } from './schemas/workflow-run-listing';

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
  workflow: z.string(),
  status: workflowRunStatusSchema,
  /** The outcome the run completed with, of either form; null until it completes. */
  outcome: z.string().nullable(),
  startedAt: z.string().datetime(),
  /** Null while the run has not ended. */
  completedAt: z.string().datetime().nullable(),
  /**
   * What started the run, read from the start receipt its start recorded: a run on this
   * item that ended, a node that fired it, or another trigger source. Null for a start
   * by hand, which has no receipt.
   */
  cause: startCauseSchema.nullable(),
  /**
   * Set while the run's start is admitted but no executor has claimed it. If the process
   * that admitted it died, it stays set until an operator runs it once:
   * `archon trigger execute <requestId> --host <hostId>`.
   */
  awaitingExecution: z.object({ requestId: z.string(), hostId: z.string() }).nullable(),
  /**
   * Set while the run is a pending start waiting for another run of its workflow on the
   * item, and kept on a start that was refused for it (`--no-wait`), which is cancelled.
   */
  heldBehind: itemHeldBehindSchema.nullable(),
});
export type ItemRun = z.infer<typeof itemRunSchema>;

/**
 * A start on the item that has no run: `queued` waits for admission, `skipped` was refused
 * (its binding's `overlap: skip`). `heldBehind` names the run of its workflow on the item a
 * queued start waits behind now, or that a skipped start was refused for; null when it
 * waits for, or was refused for, capacity or its checkout instead.
 */
export const itemStartSchema = z.object({
  requestId: z.string(),
  workflow: z.string(),
  resource: z.string(),
  status: z.enum(['queued', 'skipped']),
  heldBehind: itemHeldBehindSchema.nullable(),
});
export type ItemStart = z.infer<typeof itemStartSchema>;

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
 * `occurrence` are null. A set that a newer one replaced before it closed never settles.
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

/**
 * A link seen from the item read: `outgoing` when this item is the link's `from` (it
 * depends on, is part of, or is a duplicate of `other`), `incoming` when `other` points at
 * this item. An ended link stays, with `ended` set; a link is active while `ended` is null.
 */
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
 * that holds it. `degraded` names each part that could not be read: one of the item's own
 * runs, a paused run the queue could not read (`run_unreadable`, by `runId`), a ruling
 * (`ruling_unreadable`, by `rulingId`), or a link (`link_unreadable`, by `linkId`). The rest
 * still reads.
 */
export const itemReadSchema = z.object({
  item: workflowItemSchema,
  runs: z.array(itemRunSchema),
  starts: z.array(itemStartSchema),
  questions: z.array(attentionQueueItemSchema),
  answers: z.array(itemAnswerSchema),
  links: z.array(itemReadLinkSchema),
  degraded: z.array(
    z.discriminatedUnion('reason', [
      attentionDegradedSchema,
      itemRulingDegradedSchema,
      itemLinkDegradedSchema,
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
      | 'listItemLinks'
      | 'listItemAsks'
      | 'getStartReceipt'
      | 'getResourceStartRequest'
      | 'listItemStartRequests'
    >;
}

async function itemRun(
  source: ItemReadSource,
  run: WorkflowRun,
  request: ResourceStartRequestInspection | null,
  heldBehind: ItemHeldBehind | null
): Promise<ItemRun> {
  // The receipt stays the one owner of why a start happened; this only reads it.
  const receiptId = readResourceStartReceiptId(run.metadata);
  const receipt = receiptId ? await source.store.getStartReceipt(receiptId) : null;
  return {
    id: run.id,
    workflow: run.workflow_name,
    status: run.status,
    outcome: displayedRunOutcome(run),
    startedAt: run.started_at.toISOString(),
    completedAt: run.completed_at?.toISOString() ?? null,
    cause: receipt ? startCause(receipt) : null,
    awaitingExecution: awaitingExecution(request),
    heldBehind,
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
  const held = itemHolders(rows);
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
  const holderOf = (runId: string, workflow: string): Promise<ItemHeldBehind> | null => {
    const holder = itemHolder(held, { runId, workflow, itemId });
    return holder === undefined ? null : describe(holder);
  };
  return {
    request: (runId: string) => requests.get(runId) ?? null,
    /** A pending run that holds nothing waits behind its workflow's holder. */
    runHeldBehind: (run: WorkflowRun) => {
      const refused = refusedBy.get(run.id);
      if (refused !== undefined)
        return byId.get(refused)?.workflow_name === run.workflow_name ? describe(refused) : null;
      return run.status === 'pending' &&
        !holdsItem({ status: run.status, admitted: requests.get(run.id)?.status === 'admitted' })
        ? holderOf(run.id, run.workflow_name)
        : null;
    },
    startHeldBehind: (start: ItemStartRequest) => {
      const workflow = start.launch.run.workflow_name;
      if (start.status === 'queued') return holderOf(start.id, workflow);
      // A skipped start keeps the blocker it was refused for.
      const blocker = start.blocker?.kind === 'run' ? byId.get(start.blocker.id) : undefined;
      return blocker?.workflow_name === workflow ? describe(blocker.id) : null;
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
 * ask, and one `asks_settled` per set whose asks all closed that way, at its last close.
 */
function askAnswers(asks: readonly StoredItemAsk[]): ItemAnswer[] {
  const sets = new Map<string, StoredItemAsk[]>();
  for (const ask of asks) sets.set(ask.runId, [...(sets.get(ask.runId) ?? []), ask]);
  return [...sets].flatMap(([runId, set]) => {
    const closes = set.map(askAnswer).filter(answer => answer?.kind === 'ask');
    const [first] = closes;
    if (first === undefined || closes.length < set.length) return closes;
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
  const found = await source.store.getItemRuns(projectKey, key);
  if (found === null) return null;
  const own = splitAttentionRead(found.runs);
  const tree = new Set([
    ...own.values.map(run => run.id),
    ...own.degraded.map(report => report.runId),
    ...found.descendantIds,
  ]);
  // The one queue reader, so a question here reads as `workflow attention` lists it. A
  // holder whose owner is gone is reported on the start held behind it, not as a question.
  const { values, degraded } = splitAttentionRead(
    await listAttentionQueue({ ...source, ownerLost: undefined })
  );
  // An ask no run holds belongs to the item it was left on.
  const questions = values
    .filter(item => (isHeldByRun(item) ? tree.has(item.run.id) : item.item?.id === found.item.id))
    .sort(compareAge);
  const events =
    tree.size === 0
      ? new Map<string, WorkflowEventRow[]>()
      : await source.store.listEventsForRuns([...tree], ['wait_answered', 'approval_received']);
  const rulings: ItemRuling[] = [];
  const unreadableRulings: ItemRulingDegraded[] = [];
  for (const read of await source.store.listItemRulings(found.item.id))
    if ('type' in read) unreadableRulings.push(read);
    else rulings.push(read);
  const links: ItemReadLink[] = [];
  const unreadableLinks: ItemLinkDegraded[] = [];
  for (const read of await source.store.listItemLinks(found.item.id))
    if ('type' in read) unreadableLinks.push(read);
    else links.push(readLink(found.item.id, read));
  const asks = splitAttentionRead(await source.store.listItemAsks(found.item.id));
  const answers = [
    ...[...events.values()].flat().map(itemAnswer),
    ...rulings,
    ...askAnswers(asks.values),
  ]
    // Stable, so rows that tie on `at` keep their store order: append order within a run,
    // recording order among rulings, and a set's last answer before its settle.
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const holds = await itemHolds(source, found.item.id, own.values);
  const starts: ItemStart[] = [];
  for (const start of await source.store.listItemStartRequests(found.item.id)) {
    if (start.status !== 'queued' && start.status !== 'skipped') continue;
    starts.push({
      requestId: start.id,
      workflow: start.launch.run.workflow_name,
      resource: start.resource,
      status: start.status,
      heldBehind: (await holds.startHeldBehind(start)) ?? null,
    });
  }
  return {
    item: found.item,
    runs: await Promise.all(
      own.values.map(async run =>
        itemRun(source, run, holds.request(run.id), (await holds.runHeldBehind(run)) ?? null)
      )
    ),
    starts,
    questions,
    answers,
    links,
    // A paused item run the store could not read is in both reports, and an unreadable
    // open ask in the queue's and the item's; list each run once.
    degraded: [
      ...distinctByRun([
        ...own.degraded,
        ...degraded.filter(report => tree.has(report.runId)),
        ...asks.degraded,
      ]),
      ...unreadableRulings,
      ...unreadableLinks,
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
