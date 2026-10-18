/**
 * The attention queue as a stream (#3050), across runs including those started later.
 * Unreadable run deliveries may be omitted after a `degraded` warning.
 *
 * Queue items reflect the current row; lifecycle lines follow committed events so
 * transitions survive even when the row has already moved on. Out-of-process runs are
 * covered because the feed is the persisted store, not an in-process emitter.
 * The watch reads only.
 */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import {
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
import type {
  AttentionWatch,
  AttentionWatchOptions,
  WorkflowEventDoorbell,
  WorkflowRunDelivery,
} from './engine-port';
import type { TERMINAL_RUN_EVENT_TYPES } from './file-store/transaction-view';
import { followWorkflowEventFeed, type WorkflowEventFeedFollower } from './run-subscription';
import { recordSurfaceSchema } from './schemas/record-surface';
import type { WorkflowEventRow } from './schemas/workflow-event';
import {
  attentionOccurrence,
  gateOccurrence,
  isApprovalContext,
  isGateResolved,
  isWorkflowWaitContext,
  terminalWorkflowRunStatusSchema,
  workflowRunOutcomeSchema,
  workflowRunStatusSchema,
  type RunTerminalStatus,
  type WorkflowRun,
  type WorkflowRunStatus,
} from './schemas/workflow-run';
import {
  WorkflowEventCursorError,
  type IWorkflowStore,
  type WorkflowEventCursor,
  type WorkflowEventPage,
} from './store';
import { getTerminalRecord } from './terminal-record';

function getLog(): ReturnType<typeof createLogger> {
  return createLogger('workflow.attention_watch');
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BOOKMARK_INTERVAL_MS = 30_000;
const RUNNING_PAGE_LIMIT = 100;

const cursorSchema = z.custom<WorkflowEventCursor>(
  value => typeof value === 'string' && value.length > 0
);
const lineBase = { cursor: cursorSchema, project: projectRefSchema.nullable(), runId: z.string() };

/**
 * One line of the stream. `cursor` is the feed position the line was produced at;
 * `--after` it replays later readable feed events, excluding every line at that cursor.
 * `attention` carries the queue item exactly as the snapshot and
 * `workflow attention <run>` build it.
 */
export const attentionStreamLineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attention'),
    cursor: cursorSchema,
    /** True for the open items sent before `ready`. */
    snapshot: z.boolean(),
    project: projectRefSchema.nullable(),
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
  }),
  z.object({ type: z.literal('resumed'), ...lineBase, status: z.literal('running') }),
  z.object({ type: z.literal('owner_lost'), ...lineBase, observedStatus: workflowRunStatusSchema }),
  z.object({ type: z.literal('ready'), cursor: cursorSchema }),
  /** Sent only after a read that reached the head, so a stream that cannot read stops sending them. */
  z.object({ type: z.literal('bookmark'), cursor: cursorSchema }),
  z.object({
    type: z.literal('degraded'),
    reason: z.literal('run_unreadable'),
    cursor: cursorSchema,
  }),
  /** The store cannot read the stream's cursor; the last line of the stream. */
  z.object({ type: z.literal('error'), error: z.literal('cursor_invalid') }),
]);
export type AttentionStreamLine = z.infer<typeof attentionStreamLineSchema>;

/**
 * Watches one running run until its owner is lost (`observedStatus`) or it stops needing
 * one (null). Rejects or resolves early when `signal` aborts.
 */
export type RunOwnerLossWatch = (
  runId: string,
  signal: AbortSignal
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
  | 'getWorkflowEventHead'
  | 'readWorkflowEventsAfter'
  | 'listAttentionQueueRows'
  | 'getWorkflowRun'
  | 'getCodebase'
  | 'listWorkflowRuns'
>;

const TERMINAL_EVENT_STATUS = {
  workflow_completed: 'completed',
  workflow_failed: 'failed',
  workflow_cancelled: 'cancelled',
} as const satisfies Record<(typeof TERMINAL_RUN_EVENT_TYPES)[number], RunTerminalStatus>;

function isTerminalEventType(type: string): type is keyof typeof TERMINAL_EVENT_STATUS {
  return Object.hasOwn(TERMINAL_EVENT_STATUS, type);
}

/** The occurrence an answer resolves; null for an item nobody answers. */
function occurrenceOf(item: AttentionQueueItem): string | null {
  return item.kind === 'unreadable' || item.kind === 'usage_limit' ? null : item.occurrence;
}

type Resolution =
  | { reason: 'answered'; answeredVia: string | null; answeredAt: string | null }
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
      answeredAt: wait.answeredAt ?? null,
    };
  return undefined;
}

const answerKey = (runId: string, occurrence: string): string => `${runId}\u0000${occurrence}`;

/** The surface of each answer event in a page, by run and occurrence. */
function indexAnswers(page: WorkflowEventPage): Map<string, string | null> {
  const answers = new Map<string, string | null>();
  for (const { event } of page.events) {
    if (event.event_type !== 'approval_received' && event.event_type !== 'wait_answered') continue;
    const { occurrence, via } = event.data;
    if (typeof occurrence !== 'string') continue;
    const surface = recordSurfaceSchema.safeParse(via);
    answers.set(
      answerKey(event.workflow_run_id, occurrence),
      surface.success ? surface.data : null
    );
  }
  return answers;
}

/** What the queue reports for one run now: its row, its own item, its project. */
interface RunView {
  run: WorkflowRun;
  item: AttentionQueueItem | null;
  project: ProjectRef | null;
}

function terminalOutcome(
  event: WorkflowEventRow,
  status: (typeof TERMINAL_EVENT_STATUS)[keyof typeof TERMINAL_EVENT_STATUS]
): 'succeeded' | 'failed' | null {
  try {
    return getTerminalRecord(status, [event])?.outcome ?? null;
  } catch (error) {
    // A malformed record must not stall the stream on one row; the line still reports
    // the status, and `workflow get` remains the full read.
    getLog().warn(
      { err: error as Error, runId: event.workflow_run_id, eventId: event.id },
      'workflow.attention_watch_terminal_record_unreadable'
    );
    return null;
  }
}

/**
 * Start a watch: snapshot the open items in scope, emit `ready`, then follow the feed.
 * Resolves once the snapshot and `ready` were delivered. Rejects with
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

  const start = options.after ?? (await store.getWorkflowEventHead());
  if (options.after !== undefined) await store.readWorkflowEventsAfter(options.after, { limit: 1 });

  const open = new Map<string, AttentionQueueItem>();
  let follower: WorkflowEventFeedFollower | undefined;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let lastLineAt = Date.now();
  const position = (): WorkflowEventCursor => follower?.cursor() ?? start;

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

  // Liveness: one waiter per running run in scope, and one report per loss until the
  // run commits another event.
  const waiters = new Map<string, AbortController>();
  const lost = new Set<string>();
  const arm = (runId: string, project: ProjectRef | null): void => {
    const watchOwner = host.ownerLoss;
    if (watchOwner === undefined || closed || waiters.has(runId) || lost.has(runId)) return;
    const controller = new AbortController();
    const { signal } = controller;
    waiters.set(runId, controller);
    void (async (): Promise<void> => {
      let result: Awaited<ReturnType<RunOwnerLossWatch>>;
      for (;;) {
        try {
          result = await watchOwner(runId, signal);
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
      if (waiters.get(runId) !== controller || signal.aborted) return;
      waiters.delete(runId);
      if (result === null) return;
      lost.add(runId);
      emit({
        type: 'owner_lost',
        cursor: position(),
        project,
        runId,
        observedStatus: result.observedStatus,
      });
    })();
  };
  const disarm = (runId: string): void => {
    waiters.get(runId)?.abort();
    waiters.delete(runId);
  };
  const stopLiveness = (): void => {
    for (const controller of waiters.values()) controller.abort();
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

  // 1. The snapshot: the complete open set in scope, refilled on every connect.
  const snapshot = selectAttentionQueue(await listAttentionQueue(source), {
    scope,
    labels,
    order: { by: 'age' },
  });
  for (const item of snapshot) {
    open.set(item.runId, item);
    emit({ type: 'attention', cursor: start, snapshot: true, project: item.project, item });
  }
  emit({ type: 'ready', cursor: start });
  await chain;

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
        if (isInAttentionScope(project, scope)) arm(run.id, project);
      }
      if (page.runs.length < RUNNING_PAGE_LIMIT || offset + RUNNING_PAGE_LIMIT >= page.total) break;
    }
  };

  // 3. The tail. Caches live for one page: a run is read once per page, after the page
  // was read, so the row reflects at least every event in it.
  let views = new Map<string, Promise<RunView | null>>();
  let codebases = new Map<string, ReturnType<IWorkflowStore['getCodebase']>>();
  let answers = new Map<string, string | null>();
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
  let blocked: { cursor: WorkflowEventCursor; warned: boolean } | undefined;
  const isolated = new Set<string>();

  const hasReadableWitness = async (delivery: WorkflowRunDelivery): Promise<boolean> => {
    let cursor = delivery.cursor;
    const probed = new Set([delivery.event.workflow_run_id]);
    while (!closed) {
      const page = await store.readWorkflowEventsAfter(cursor, { limit: 100 });
      if (closed || page.events.length === 0) return false;
      for (const { event } of page.events) {
        if (closed) return false;
        if (probed.has(event.workflow_run_id)) continue;
        probed.add(event.workflow_run_id);
        try {
          // A cached success says nothing about whether reads work now.
          await projectRun(event.workflow_run_id);
          return !closed;
        } catch (error) {
          if (error instanceof WorkflowEventCursorError) throw error;
          getLog().debug(
            { err: error as Error, runId: event.workflow_run_id, eventId: event.id },
            'workflow.attention_watch_probe_failed'
          );
        }
      }
      cursor = page.next;
    }
    return false;
  };

  const deliveryView = async (
    delivery: WorkflowRunDelivery
  ): Promise<RunView | null | undefined> => {
    const { event, cursor } = delivery;
    const runId = event.workflow_run_id;
    try {
      const view = await viewOf(runId);
      blocked = undefined;
      return view;
    } catch (error) {
      if (error instanceof WorkflowEventCursorError) throw error;
      const fields = { err: error as Error, runId, eventId: event.id, cursor };
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
      try {
        const view = await projectRun(runId);
        if (closed) throw error;
        views.set(runId, Promise.resolve(view));
        blocked = undefined;
        return view;
      } catch (retryError) {
        if (retryError instanceof WorkflowEventCursorError) throw retryError;
        if (closed) throw retryError;
        getLog().warn({ ...fields, retryError }, 'workflow.attention_watch_delivery_unreadable');
        isolated.add(runId);
        blocked = undefined;
        return undefined;
      }
    }
  };
  const reconciled = new Set<string>();

  const resolve = async (
    runId: string,
    prev: AttentionQueueItem,
    cursor: WorkflowEventCursor,
    run: WorkflowRun | null
  ): Promise<void> => {
    const occurrence = occurrenceOf(prev);
    const fromRow = run === null ? undefined : rowResolution(run, occurrence);
    const via = occurrence === null ? undefined : answers.get(answerKey(runId, occurrence));
    const resolution: Resolution =
      fromRow ??
      (via !== undefined
        ? { reason: 'answered', answeredVia: via, answeredAt: null }
        : { reason: 'withdrawn' });
    await emit({
      type: 'resolved',
      cursor,
      project: prev.project,
      runId,
      occurrence,
      ...resolution,
    });
  };

  const reconcile = async (
    runId: string,
    view: RunView | null,
    cursor: WorkflowEventCursor
  ): Promise<void> => {
    const prev = open.get(runId);
    const item = view?.item ?? null;
    if (item !== null && inQuery(item)) {
      const occurrence = occurrenceOf(item);
      const replaced = prev !== undefined && occurrenceOf(prev) !== occurrence;
      if (replaced) await resolve(runId, prev, cursor, view?.run ?? null);
      if (prev === undefined || !isDeepStrictEqual(prev, item))
        await emit({ type: 'attention', cursor, snapshot: false, project: item.project, item });
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

  const handle = async (delivery: WorkflowRunDelivery): Promise<void> => {
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
          occurrence,
          revision: item.revision,
        });
    }
    if (isTerminalEventType(event.event_type) && inScope) {
      const status = TERMINAL_EVENT_STATUS[event.event_type];
      await emit({
        type: 'terminal',
        cursor,
        project: view?.project ?? null,
        runId,
        status,
        outcome: terminalOutcome(event, status),
      });
    }
    if (event.event_type === 'workflow_resumed' && inScope)
      await emit({
        type: 'resumed',
        cursor,
        project: view?.project ?? null,
        runId,
        status: 'running',
      });
    lost.delete(runId);
    if (view?.run.status === 'running' && inScope) arm(runId, view.project);
  };

  try {
    await armRunning();
    follower = await followWorkflowEventFeed(store, start, handle, {
      pollIntervalMs,
      ...(host.doorbell ? { doorbell: host.doorbell } : {}),
      beginPage: page => {
        views = new Map();
        codebases = new Map();
        reconciled.clear();
        isolated.clear();
        answers = indexAnswers(page);
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
    });
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
