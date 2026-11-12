/**
 * The attention queue as a stream (#3050), across runs including those started later.
 * Unreadable run deliveries may be omitted after a `degraded` warning.
 *
 * Queue items reflect the current row; lifecycle lines follow committed events so
 * transitions survive even when the row has already moved on. Out-of-process runs are
 * covered because the feed is the persisted store, not an in-process emitter.
 * The watch reads only.
 */
import { attentionDegradedBaseSchema, splitAttentionRead } from './schemas/attention-degraded';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import {
  attentionItemRunContextFields,
  attentionQueueItemForRun,
  attentionQueueItemSchema,
  isInAttentionScope,
  listAttentionQueue,
  matchesAttentionLabels,
  projectRefSchema,
  runProject,
  selectAttentionQueue,
  type AttentionQueueItem,
  type AttentionQueueSource,
  type ProjectRef,
} from './attention-queue';
import type { AttentionWatch, AttentionWatchOptions, WorkflowEventDoorbell } from './engine-port';
import { followFeed, type FeedFollower } from './run-subscription';
import {
  attentionCursor,
  attentionFeedStart,
  readAttentionFeed,
  type AttentionCursor,
  type AttentionDelivery,
  type AttentionWorkflowDelivery,
} from './attention-feed';
import { attentionDeliveryFields, hasReadableAttentionWitness } from './attention-watch-witness';
import { requestingRun } from './schemas/resource-start';
import { recordSurfaceSchema } from './schemas/record-surface';
import type { WorkflowEventRow } from './schemas/workflow-event';
import {
  attentionAnswererSchema,
  attentionOccurrence,
  gateOccurrence,
  isApprovalContext,
  isGateResolved,
  isWorkflowWaitContext,
  terminalRunStatusForEventType,
  terminalWorkflowRunStatusSchema,
  workflowRunOutcomeSchema,
  workflowRunStatusSchema,
  type AttentionAnswerer,
  type RunTerminalStatus,
  type WorkflowRun,
  type WorkflowRunStatus,
} from './schemas/workflow-run';
import { executionClaim, WorkflowEventCursorError, type IWorkflowStore } from './store';
import { nodeFailureKindSchema, type NodeFailureKind } from './schemas/node-execution';
import {
  firstFailedNodeEvent,
  getTerminalRecord,
  recordedFailureKind,
  failedOutcomeReason,
} from './terminal-record';
import {
  admissionWorkflowNotice,
  workflowNoticeSchema,
  workflowNoticeDataSchema,
} from './workflow-notice';

function getLog(): ReturnType<typeof createLogger> {
  return createLogger('workflow.attention_watch');
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BOOKMARK_INTERVAL_MS = 30_000;
const RUNNING_PAGE_LIMIT = 100;

const cursorSchema = z.string().min(1).transform(attentionCursor);
/** What a run is part of, from its row; both null when the stream could not read the row. */
const runContextFields = { workflow: z.string().nullable(), parentRunId: z.string().nullable() };
const lineBase = {
  cursor: cursorSchema,
  project: projectRefSchema.nullable(),
  runId: z.string(),
  ...runContextFields,
};

/**
 * One line of the stream. `cursor` is the feed position the line was produced at;
 * `--after` it replays later readable feed events, excluding every line at that cursor.
 * `attention` carries the queue item exactly as the snapshot and
 * `workflow attention <run>` build it. Every run line carries the run's `workflow` and
 * `parentRunId` (null for a top-level run), so a consumer can filter on them.
 */
export const attentionStreamLineSchema = z.union([
  z.object({
    type: z.literal('attention'),
    cursor: cursorSchema,
    /** True for the open items sent before `ready`. */
    snapshot: z.boolean(),
    project: projectRefSchema.nullable(),
    ...attentionItemRunContextFields,
    item: attentionQueueItemSchema,
  }),
  z.discriminatedUnion('reason', [
    z.object({
      type: z.literal('resolved'),
      ...lineBase,
      /** Null for `usage_limit` and `unreadable` items, which have no occurrence. */
      occurrence: z.string().nullable(),
      reason: z.literal('answered'),
      answeredVia: recordSurfaceSchema.nullable(),
      /** Who answered an attention wait, when the answer recorded it; a declared name is a claim. */
      answeredBy: attentionAnswererSchema.nullable(),
      /** Null when the row had already moved past the answer when the stream read it. */
      answeredAt: z.string().nullable(),
    }),
    z.object({
      type: z.literal('resolved'),
      ...lineBase,
      occurrence: z.string().nullable(),
      /** The item closed without an answer: resumed, ended, deleted or replaced. */
      reason: z.literal('withdrawn'),
    }),
  ]),
  z.object({
    type: z.literal('unmatched'),
    ...lineBase,
    occurrence: z.string(),
    revision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('terminal'),
    ...lineBase,
    status: terminalWorkflowRunStatusSchema,
    outcome: workflowRunOutcomeSchema.nullable(),
    /**
     * Where a failed run failed: its terminal record's first failed node and the failure
     * kind that node's `node_failed` event recorded (null when it recorded none). Null
     * for any other status and when the record names no failed node or there is no record.
     */
    cause: z.object({ node: z.string(), errorClass: nodeFailureKindSchema.nullable() }).nullable(),
    /**
     * A fixed launch-failure indication, or why a run completed with a failed outcome.
     * A failed run's error text never rides the stream: `cause` names where it failed.
     */
    reason: z.array(z.string()).min(1).optional(),
  }),
  z.object({ type: z.literal('resumed'), ...lineBase, status: z.literal('running') }),
  workflowNoticeSchema.and(z.object({ type: z.literal('notice'), cursor: cursorSchema })),
  z.object({ type: z.literal('owner_lost'), ...lineBase, observedStatus: workflowRunStatusSchema }),
  z.object({ type: z.literal('ready'), cursor: cursorSchema }),
  /** Sent only after a read that reached the head, so a stream that cannot read stops sending them. */
  z.object({ type: z.literal('bookmark'), cursor: cursorSchema }),
  attentionDegradedBaseSchema.extend({ cursor: cursorSchema }),
  /** The store cannot read the stream's cursor; the last line of the stream. */
  z.object({ type: z.literal('error'), error: z.literal('cursor_invalid') }),
]);
export type AttentionStreamLine = z.infer<typeof attentionStreamLineSchema>;

/**
 * Watches one execution claim until its owner is lost (`observedStatus`), the claim
 * changes, or it stops needing an owner (null). Rejects or resolves early when `signal` aborts.
 */
export type RunOwnerLossWatch = (
  runId: string,
  signal: AbortSignal,
  claim: ReturnType<typeof executionClaim>
) => Promise<{ observedStatus: WorkflowRunStatus } | null>;

/** What a host gives the watch beyond the store. */
export interface AttentionWatchHost {
  branchOf: AttentionQueueSource['branchOf'];
  /** Without it the stream reports no `owner_lost`. */
  ownerLoss?: RunOwnerLossWatch;
  doorbell?: WorkflowEventDoorbell;
}

/** Read methods only, so the watch cannot write run state. */
export type AttentionWatchStore = Pick<
  IWorkflowStore,
  | 'getAdmissionNoticeHead'
  | 'readAdmissionNoticesAfter'
  | 'getWorkflowEventHead'
  | 'readWorkflowEventsAfter'
  | 'listAttentionQueueRows'
  | 'getWorkflowRun'
  | 'getWorkflowRunForAttention'
  | 'getCodebase'
  | 'listWorkflowRuns'
  | 'listEventsForRuns'
>;

/** The occurrence an answer resolves; null for an item nobody answers. */
function occurrenceOf(item: AttentionQueueItem): string | null {
  return item.kind === 'unreadable' || item.kind === 'usage_limit' ? null : item.occurrence;
}

type Resolution =
  | {
      reason: 'answered';
      answeredVia: string | null;
      answeredBy: AttentionAnswerer | null;
      answeredAt: string | null;
    }
  | { reason: 'withdrawn' };

/** How `occurrence` closed, from the row when it still records the answer. */
function rowResolution(run: WorkflowRun, occurrence: string | null): Resolution | undefined {
  if (occurrence === null) return undefined;
  const { approval, wait } = run.metadata;
  if (isApprovalContext(approval) && gateOccurrence(approval) === occurrence)
    return isGateResolved(approval)
      ? {
          reason: 'answered',
          answeredVia: approval.answeredVia ?? null,
          answeredBy: null,
          answeredAt: approval.answeredAt ?? null,
        }
      : undefined;
  if (
    isWorkflowWaitContext(wait) &&
    wait.kind === 'attention' &&
    attentionOccurrence(wait) === occurrence &&
    wait.answer !== undefined
  )
    return {
      reason: 'answered',
      answeredVia: wait.answeredVia ?? null,
      answeredBy: wait.answeredBy ?? null,
      answeredAt: wait.answeredAt ?? null,
    };
  return undefined;
}

const answerKey = (runId: string, occurrence: string): string => `${runId}\u0000${occurrence}`;

type AnswerOrigin = Pick<Extract<Resolution, { reason: 'answered' }>, 'answeredVia' | 'answeredBy'>;

/** The surface and answerer of each answer event in a page, by run and occurrence. */
function indexAnswers(events: readonly AttentionWorkflowDelivery[]): Map<string, AnswerOrigin> {
  const answers = new Map<string, AnswerOrigin>();
  for (const { event } of events) {
    if (event.event_type !== 'approval_received' && event.event_type !== 'wait_answered') continue;
    const { occurrence, via, by } = event.data;
    if (typeof occurrence !== 'string') continue;
    const surface = recordSurfaceSchema.safeParse(via);
    const answerer = attentionAnswererSchema.safeParse(by);
    answers.set(answerKey(event.workflow_run_id, occurrence), {
      answeredVia: surface.success ? surface.data : null,
      answeredBy: answerer.success ? answerer.data : null,
    });
  }
  return answers;
}

/** What the queue reports for one run now: its row, its own item, its project. */
interface RunView {
  run: WorkflowRun;
  item: AttentionQueueItem | null;
  project: ProjectRef | null;
}

interface RunContext {
  workflow: string | null;
  parentRunId: string | null;
}

function runContext(run: WorkflowRun | null): RunContext {
  return { workflow: run?.workflow_name ?? null, parentRunId: run?.parent_run_id ?? null };
}

/** The fields of a line about the delivered event's run, from the row the stream read. */
function lifecycleFields(
  { cursor, event }: AttentionWorkflowDelivery,
  view: RunView | null
): { cursor: AttentionCursor; project: ProjectRef | null; runId: string } & RunContext {
  return {
    cursor,
    project: view?.project ?? null,
    runId: event.workflow_run_id,
    ...runContext(view?.run ?? null),
  };
}

function itemContext(
  item: AttentionQueueItem
): Pick<AttentionQueueItem, 'workflow' | 'parentRunId'> {
  return { workflow: item.workflow, parentRunId: item.parentRunId };
}

/** What the terminal record riding on `event` says, or nulls when it cannot be read. */
function terminalFacts(
  event: WorkflowEventRow,
  status: RunTerminalStatus
): { outcome: 'succeeded' | 'failed' | null; firstFailedNode: string | null; reason: string[] } {
  try {
    const record = getTerminalRecord(status, [event]);
    return {
      outcome: record?.outcome ?? null,
      firstFailedNode: record?.first_failed_node ?? null,
      reason:
        status === 'failed' && event.data.exit_reason === 'launch_failed'
          ? ['launch failed before the first node']
          : failedOutcomeReason(record),
    };
  } catch (error) {
    // A malformed record must not stall the stream on one row; the line still reports
    // the status, and `workflow get` remains the full read.
    getLog().warn(
      { err: error as Error, runId: event.workflow_run_id, eventId: event.id },
      'workflow.attention_watch_terminal_record_unreadable'
    );
    return { outcome: null, firstFailedNode: null, reason: [] };
  }
}

/**
 * Start a watch: snapshot the open items in scope, emit `ready`, then follow the feed.
 * Resolves once the snapshot and `ready` were accepted by the listener; an initial
 * listener failure rejects startup with its cause before background watches start. Rejects with
 * `WorkflowEventCursorError` before any line when `after` cannot be read; a tail that
 * later cannot read its cursor ends the stream with an `error` line.
 */
export async function watchAttentionQueue(
  store: AttentionWatchStore,
  host: AttentionWatchHost,
  listener: (line: AttentionStreamLine) => void | Promise<void>,
  options: AttentionWatchOptions & { bookmarkIntervalMs?: number }
): Promise<AttentionWatch> {
  const { scope } = options;
  const labels = options.labels ?? {};
  const filtersLabels = Object.keys(labels).length > 0;
  const source: AttentionQueueSource = { store, branchOf: host.branchOf };
  const bookmarkIntervalMs = options.bookmarkIntervalMs ?? DEFAULT_BOOKMARK_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const start = await attentionFeedStart(store, options.after);

  const open = new Map<string, AttentionQueueItem>();
  let follower: FeedFollower<AttentionCursor> | undefined;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let lastLineAt = Date.now();
  const position = (): AttentionCursor => follower?.cursor() ?? start;

  // Every line, including asynchronous liveness lines, goes through one chain so the
  // listener sees one line at a time. Feed handlers await the original delivery.
  function emit(line: AttentionStreamLine): Promise<void> {
    if (closed) return Promise.resolve();
    lastLineAt = Date.now();
    const delivery = chain.then(() => listener(line));
    chain = delivery.catch(error => {
      getLog().warn(
        { err: error as Error, type: line.type },
        'workflow.attention_watch_listener_failed'
      );
    });
    return delivery;
  }

  const inQuery = (item: AttentionQueueItem): boolean =>
    isInAttentionScope(item.project, scope) && matchesAttentionLabels(item, labels);

  // A replayed event is not new life: only a new execution claim re-arms a lost run.
  const waiters = new Map<string, { claim: string | null; controller: AbortController }>();
  const lost = new Map<string, string | null>();
  const disarm = (runId: string): void => {
    waiters.get(runId)?.controller.abort();
    waiters.delete(runId);
  };
  const arm = (run: WorkflowRun, project: ProjectRef | null): void => {
    const watchOwner = host.ownerLoss;
    if (watchOwner === undefined || closed) return;
    const runId = run.id;
    const claim = executionClaim(run.metadata);
    if (waiters.get(runId)?.claim === claim || lost.get(runId) === claim) return;
    disarm(runId);
    const controller = new AbortController();
    const { signal } = controller;
    waiters.set(runId, { claim, controller });
    void (async (): Promise<void> => {
      let result: Awaited<ReturnType<RunOwnerLossWatch>>;
      for (;;) {
        try {
          result = await watchOwner(runId, signal, claim);
          break;
        } catch (error) {
          if (signal.aborted) return;
          // A failed read says nothing about the owner; an orphan may commit no event that
          // would re-arm this watch, so it retries rather than goes quiet.
          getLog().warn(
            { err: error as Error, runId },
            'workflow.attention_watch_owner_watch_failed'
          );
          await abortableDelay(pollIntervalMs, signal);
          if (signal.aborted) return;
        }
      }
      if (waiters.get(runId)?.controller !== controller || signal.aborted) return;
      waiters.delete(runId);
      if (result === null) return;
      lost.set(runId, claim);
      emit({
        type: 'owner_lost',
        cursor: position(),
        project,
        runId,
        ...runContext(run),
        observedStatus: result.observedStatus,
      });
    })();
  };
  const stopLiveness = (): void => {
    for (const { controller } of waiters.values()) controller.abort();
    waiters.clear();
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      closed = true;
      stopLiveness();
      await follower?.close();
      await chain;
    })();
    return closing;
  };

  // 1. Refill the open set on every connect, reporting rows we cannot read.
  const { values, degraded } = splitAttentionRead(await listAttentionQueue(source));
  const snapshot = selectAttentionQueue(values, {
    scope,
    labels,
    order: { by: 'age' },
  });
  for (const item of snapshot) {
    open.set(item.runId, item);
    await emit({
      type: 'attention',
      cursor: start,
      snapshot: true,
      project: item.project,
      ...itemContext(item),
      item,
    });
  }
  for (const report of degraded) {
    await emit({ type: report.type, reason: report.reason, cursor: start });
  }
  await emit({ type: 'ready', cursor: start });

  // 2. Arm liveness for every run already running in scope.
  const armRunning = async (): Promise<void> => {
    if (host.ownerLoss === undefined) return;
    for (let offset = 0; ; offset += RUNNING_PAGE_LIMIT) {
      const page = await store.listWorkflowRuns({
        status: 'running',
        limit: RUNNING_PAGE_LIMIT,
        offset,
      });
      for (const run of page.runs) {
        const project = await runProject(source, run);
        if (isInAttentionScope(project, scope)) arm(run, project);
      }
      if (page.runs.length < RUNNING_PAGE_LIMIT || offset + RUNNING_PAGE_LIMIT >= page.total) break;
    }
  };

  // 3. The tail. Caches live for one page: a run is read once per page, after the page
  // was read, so the row reflects at least every event in it.
  let views = new Map<string, Promise<RunView | null>>();
  let codebases = new Map<string, ReturnType<IWorkflowStore['getCodebase']>>();
  let answers = new Map<string, AnswerOrigin>();
  const projectRun = async (
    runId: string,
    cache = new Map<string, ReturnType<IWorkflowStore['getCodebase']>>()
  ): Promise<RunView | null> => {
    const run = await store.getWorkflowRun(runId);
    if (run === null) return null;
    const item = await attentionQueueItemForRun(source, run, cache);
    return { run, item, project: item?.project ?? (await runProject(source, run, cache)) };
  };
  const viewOf = (runId: string): Promise<RunView | null> => {
    let view = views.get(runId);
    if (view === undefined) {
      view = projectRun(runId, codebases);
      view.catch(() => views.delete(runId));
      views.set(runId, view);
    }
    return view;
  };
  let blocked: { cursor: AttentionCursor; warned: boolean } | undefined;
  const isolated = new Set<string>();

  const projectAdmission = async (delivery: Extract<AttentionDelivery, { kind: 'admission' }>) => {
    const origin = requestingRun(delivery.facts.sourceActor);
    const run = origin === null ? null : await store.getWorkflowRun(origin.runId);
    return admissionWorkflowNotice(source, delivery.facts, run);
  };
  const hasReadableWitness = (delivery: AttentionDelivery) =>
    hasReadableAttentionWitness(
      store,
      delivery,
      candidate =>
        candidate.kind === 'workflow'
          ? projectRun(candidate.event.workflow_run_id)
          : projectAdmission(candidate),
      () => closed
    );
  const retryProjection = async <T>(
    delivery: AttentionDelivery,
    project: () => Promise<T>,
    error: unknown
  ): Promise<T | undefined> => {
    try {
      const value = await project();
      if (closed) throw error;
      blocked = undefined;
      return value;
    } catch (retryError) {
      if (retryError instanceof WorkflowEventCursorError) throw retryError;
      if (closed) throw retryError;
      getLog().warn(
        { err: error as Error, ...attentionDeliveryFields(delivery), retryError },
        'workflow.attention_watch_delivery_unreadable'
      );
      if (delivery.kind === 'workflow') isolated.add(delivery.event.workflow_run_id);
      blocked = undefined;
      return undefined;
    }
  };

  const deliveryProjection = async <T>(
    delivery: AttentionDelivery,
    project: (fresh: boolean) => Promise<T>
  ): Promise<T | undefined> => {
    const { cursor } = delivery;
    try {
      const value = await project(false);
      blocked = undefined;
      return value;
    } catch (error) {
      if (error instanceof WorkflowEventCursorError) throw error;
      const fields = { err: error as Error, ...attentionDeliveryFields(delivery) };
      if (blocked?.cursor !== cursor) {
        blocked = { cursor, warned: false };
        getLog().warn(fields, 'workflow.attention_watch_delivery_failed');
        throw error;
      }
      if (!blocked.warned && !closed) {
        await emit({ type: 'degraded', reason: 'run_unreadable', cursor: position() });
        blocked.warned = true;
      }
      if (closed || !(await hasReadableWitness(delivery))) throw error;
      return retryProjection(delivery, () => project(true), error);
    }
  };
  const deliveryView = (delivery: AttentionWorkflowDelivery) =>
    deliveryProjection(delivery, async fresh => {
      const runId = delivery.event.workflow_run_id;
      if (!fresh) return viewOf(runId);
      const view = await projectRun(runId);
      views.set(runId, Promise.resolve(view));
      return view;
    });
  const reconciled = new Set<string>();

  const resolve = async (
    runId: string,
    prev: AttentionQueueItem,
    cursor: AttentionCursor,
    run: WorkflowRun | null
  ): Promise<void> => {
    const occurrence = occurrenceOf(prev);
    const fromRow = run === null ? undefined : rowResolution(run, occurrence);
    const origin = occurrence === null ? undefined : answers.get(answerKey(runId, occurrence));
    const resolution: Resolution =
      fromRow ??
      (origin !== undefined
        ? { reason: 'answered', ...origin, answeredAt: null }
        : { reason: 'withdrawn' });
    await emit({
      type: 'resolved',
      cursor,
      project: prev.project,
      runId,
      ...itemContext(prev),
      occurrence,
      ...resolution,
    });
  };

  const reconcile = async (
    runId: string,
    view: RunView | null,
    cursor: AttentionCursor
  ): Promise<void> => {
    const prev = open.get(runId);
    const item = view?.item ?? null;
    if (item !== null && inQuery(item)) {
      const occurrence = occurrenceOf(item);
      const replaced = prev !== undefined && occurrenceOf(prev) !== occurrence;
      if (replaced) await resolve(runId, prev, cursor, view?.run ?? null);
      if (prev === undefined || !isDeepStrictEqual(prev, item))
        await emit({
          type: 'attention',
          cursor,
          snapshot: false,
          project: item.project,
          ...itemContext(item),
          item,
        });
      open.set(runId, item);
      return;
    }
    if (prev === undefined) return;
    // Still open at the same occurrence but no longer matching the labels: the stream
    // stops tracking it, and `unmatched` tells the consumer.
    if (item === null || occurrenceOf(item) !== occurrenceOf(prev))
      await resolve(runId, prev, cursor, view?.run ?? null);
    open.delete(runId);
  };

  // Only the events before the delivered terminal event count, so a replayed line keeps
  // its cause after the run resumed and failed again. A read failure fails the delivery,
  // which the follower retries.
  const failureCause = async (
    event: WorkflowEventRow,
    node: string | null
  ): Promise<{ node: string; errorClass: NodeFailureKind | null } | null> => {
    if (node === null) return null;
    const runId = event.workflow_run_id;
    const rows =
      (await store.listEventsForRuns([runId], ['node_failed', 'workflow_failed'])).get(runId) ?? [];
    const end = rows.findIndex(row => row.id === event.id);
    const failed = firstFailedNodeEvent(
      { first_failed_node: node },
      end === -1 ? rows : rows.slice(0, end)
    );
    return {
      node,
      errorClass: failed === undefined ? null : (recordedFailureKind(failed) ?? null),
    };
  };

  const emitUnmatched = async (
    { cursor, event }: AttentionWorkflowDelivery,
    view: RunView | null
  ): Promise<void> => {
    const runId = event.workflow_run_id;
    if (filtersLabels && event.event_type === 'attention_labeled' && view?.item) {
      const { item } = view;
      const occurrence = occurrenceOf(item);
      if (
        occurrence !== null &&
        occurrence === event.data.occurrence &&
        isInAttentionScope(item.project, scope) &&
        !matchesAttentionLabels(item, labels)
      )
        await emit({
          type: 'unmatched',
          cursor,
          project: item.project,
          runId,
          ...itemContext(item),
          occurrence,
          revision: item.revision,
        });
    }
  };

  const emitLifecycle = async (
    delivery: AttentionWorkflowDelivery,
    view: RunView | null
  ): Promise<void> => {
    const { event } = delivery;
    const status = terminalRunStatusForEventType(event.event_type);
    if (status !== undefined) {
      const { outcome, firstFailedNode, reason } = terminalFacts(event, status);
      await emit({
        type: 'terminal',
        ...lifecycleFields(delivery, view),
        status,
        outcome,
        cause: status === 'failed' ? await failureCause(event, firstFailedNode) : null,
        ...(reason.length > 0 ? { reason } : {}),
      });
    }
    if (event.event_type === 'workflow_resumed')
      await emit({ type: 'resumed', ...lifecycleFields(delivery, view), status: 'running' });
    if (event.event_type === 'workflow_notice') {
      // The label filter selects notices as it selects items; a row that does not read
      // as a notice is not one.
      const notice = workflowNoticeDataSchema.safeParse(event.data);
      if (notice.success && matchesAttentionLabels(notice.data, labels))
        await emit({
          type: 'notice',
          ...lifecycleFields(delivery, view),
          at: event.created_at,
          ...notice.data,
        });
    }
  };

  const handle = async (delivery: AttentionWorkflowDelivery): Promise<void> => {
    const { cursor, event } = delivery;
    const runId = event.workflow_run_id;
    if (closed || isolated.has(runId)) return;
    const view = await deliveryView(delivery);
    if (closed || view === undefined) return;
    const inScope = view === null ? scope.kind === 'all' : isInAttentionScope(view.project, scope);
    if (view?.run.status !== 'running' || !inScope) disarm(runId);
    if (!reconciled.has(runId)) {
      await reconcile(runId, view, cursor);
      reconciled.add(runId);
    }
    await emitUnmatched(delivery, view);
    if (inScope) await emitLifecycle(delivery, view);
    if (view?.run.status === 'running' && inScope) arm(view.run, view.project);
  };

  try {
    await armRunning();
    follower = await followFeed<AttentionCursor, AttentionDelivery>(
      (cursor, limit) => readAttentionFeed(store, cursor, limit),
      start,
      async delivery => {
        if (closed) return;
        if (delivery.kind === 'workflow') return handle(delivery);
        const notice = await deliveryProjection(delivery, () => projectAdmission(delivery));
        if (closed || notice === undefined) return;
        if (isInAttentionScope(notice.project, scope) && matchesAttentionLabels(notice, labels))
          await emit({ type: 'notice', cursor: delivery.cursor, ...notice });
      },
      {
        pollIntervalMs,
        ...(host.doorbell ? { doorbell: host.doorbell } : {}),
        beginPage: page => {
          views = new Map();
          codebases = new Map();
          reconciled.clear();
          isolated.clear();
          answers = indexAnswers(
            page.deliveries.filter(
              (delivery): delivery is AttentionWorkflowDelivery => delivery.kind === 'workflow'
            )
          );
        },
        onCaughtUp: () => {
          if (Date.now() - lastLineAt >= bookmarkIntervalMs)
            emit({ type: 'bookmark', cursor: position() });
        },
        onStopped: () => {
          emit({ type: 'error', error: 'cursor_invalid' });
          closed = true;
          stopLiveness();
        },
        logFields: { watch: 'attention' },
      }
    );
  } catch (error) {
    // Already past `ready`: nothing else will close what was armed.
    await close();
    throw error;
  }
  return { close };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
