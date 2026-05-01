import type { IDatabase } from '@archon/core/db';
import { createLogger } from '@archon/paths';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { Issue, Tracker } from '../tracker/types';
import type { ConfigSnapshot, TrackerKind } from '../config/snapshot';
import { getSymphonyEventEmitter, type SymphonyEmitterEvent } from '../event-emitter';
import {
  listInFlight,
  updateStatus,
  type DispatchRow,
  type DispatchStatus,
} from '../db/dispatches';
import { dispatchToWorkflow } from '../workflow-bridge/dispatcher';
import type { BridgeDeps, DispatchOutcome } from '../workflow-bridge/types';
import {
  availableGlobalSlots,
  availableSlotsForState,
  eligibilityForDispatch,
  findTrackerConfig,
  isStateActive,
  sortForDispatch,
} from './dispatch';
import { computeRetryDelayMs, type DelayKind } from './retry';
import {
  buildDispatchKey,
  createInitialState,
  nowMs,
  type OrchestratorState,
  type RetryEntry,
  type RunningEntry,
} from './state';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.orchestrator');
  return cachedLog;
}

/**
 * Trackers keyed by kind. The orchestrator polls each in parallel and unifies
 * candidates with `dispatch_key = <tracker>:<identifier>`. A given snapshot
 * may declare multiple tracker entries of the same kind in the future; for
 * Phase 2 we expect at most one tracker per kind.
 */
export type TrackerMap = Partial<Record<TrackerKind, Tracker>>;

export interface OrchestratorDeps {
  getSnapshot: () => ConfigSnapshot;
  trackers: TrackerMap;
  /**
   * Lazy database accessor. Symphony service uses `getDatabase()` from
   * `@archon/core/db` (singleton); tests pass a per-test `SqliteAdapter`.
   * The accessor is invoked once per dispatch attempt so a test cleanup
   * cannot race a subsequent insert.
   */
  getDb: () => IDatabase;
  /**
   * Phase 3 bridge to Archon's workflow engine. When set, dispatch launches
   * real workflow runs via `executeWorkflow` and watches the singleton event
   * emitter for terminal status. When unset, the orchestrator polls but does
   * not launch — used by unit tests that only exercise loop logic.
   */
  bridge?: BridgeDeps;
  /**
   * Optional injection point for tests that want to observe terminal-event
   * subscriptions without booting a real workflow engine. Defaults to
   * `getWorkflowEventEmitter()`.
   */
  getEventEmitter?: () => {
    subscribe: (listener: (event: WorkflowEmitterEvent) => void) => () => void;
  };
  /**
   * Optional Symphony event emitter override for tests. Defaults to the
   * process-wide singleton via `getSymphonyEventEmitter()`. The orchestrator
   * fires `dispatch_*` and `tracker_poll_completed` events here on every
   * state transition.
   */
  getSymphonyEmitter?: () => { emit: (event: SymphonyEmitterEvent) => void };
  /** Optional clock override for tests. */
  now?: () => number;
  /** Optional setTimeout override. */
  scheduleTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Optional clearTimeout override. */
  cancelTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export type DispatchResult =
  | { ok: true; dispatch_key: string }
  | {
      ok: false;
      code:
        | 'stopped'
        | 'tracker_fetch_failed'
        | 'tracker_unconfigured'
        | 'not_found_in_active_states'
        | 'ineligible';
      reason: string;
      eligibility?: string;
    };

export type CancelResult =
  | { ok: true; dispatch_key: string }
  | { ok: false; code: 'stopped' | 'not_running'; reason: string };

export interface OrchestratorRunningRow {
  dispatch_key: string;
  tracker: TrackerKind;
  issue_id: string;
  issue_identifier: string;
  state: string;
  started_at: string;
  /** Archon workflow_run_id once the run has been pre-staged. Null pre-launch. */
  workflow_run_id: string | null;
}

export interface OrchestratorRetryRow {
  dispatch_key: string;
  tracker: TrackerKind;
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface OrchestratorSnapshotView {
  generated_at: string;
  counts: { running: number; retrying: number; completed: number };
  running: OrchestratorRunningRow[];
  retrying: OrchestratorRetryRow[];
}

export class Orchestrator {
  private readonly state: OrchestratorState = createInitialState();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pendingRefresh = false;
  private observers: (() => void)[] = [];
  /**
   * Reverse map for terminal-event handling: when the workflow engine fires
   * `workflow_completed | workflow_failed | workflow_cancelled` for a `runId`,
   * we look up the Symphony `dispatch_key` here.
   */
  private readonly runIdToDispatchKey = new Map<string, string>();
  /** Returned by `emitter.subscribe()` so we can unsubscribe at stop time. */
  private eventUnsubscribe: (() => void) | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Public read-only accessor for tests. */
  get internalState(): OrchestratorState {
    return this.state;
  }

  /** Fire-and-forget Symphony event emit (errors are swallowed by the emitter). */
  private emitSymphony(event: SymphonyEmitterEvent): void {
    const emitter = this.deps.getSymphonyEmitter
      ? this.deps.getSymphonyEmitter()
      : getSymphonyEventEmitter();
    emitter.emit(event);
  }

  scheduleTick(ms: number): void {
    if (this.stopped) return;
    if (this.tickTimer) {
      const cancel = this.deps.cancelTimeout ?? clearTimeout;
      cancel(this.tickTimer);
      this.tickTimer = null;
    }
    const set = this.deps.scheduleTimeout ?? setTimeout;
    this.tickTimer = set(
      () => {
        this.tickTimer = null;
        void this.runTick();
      },
      Math.max(0, ms)
    );
  }

  start(): void {
    if (this.deps.bridge) {
      const emitter = this.deps.getEventEmitter
        ? this.deps.getEventEmitter()
        : getWorkflowEventEmitter();
      this.eventUnsubscribe = emitter.subscribe(event => {
        this.onWorkflowEvent(event);
      });
    }
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
    const cancel = this.deps.cancelTimeout ?? clearTimeout;
    if (this.tickTimer) {
      cancel(this.tickTimer);
      this.tickTimer = null;
    }
    for (const retry of this.state.retry_attempts.values()) {
      if (retry.timer_handle) cancel(retry.timer_handle);
    }
    this.state.retry_attempts.clear();
    for (const entry of this.state.running.values()) {
      entry.abort.abort();
    }
  }

  /**
   * Hydrate state from `symphony_dispatches` rows that were left in flight
   * when the previous process exited. Terminal upstream rows are recorded in
   * `state.completed` and updated in DB; still-running rows just get their
   * `runId → dispatchKey` mapping registered so the singleton event emitter
   * can route their terminal events back to us.
   *
   * Per CLAUDE.md, this READS upstream status — it never marks a non-terminal
   * upstream run as failed by timer.
   */
  async reconcileOnStart(): Promise<void> {
    if (!this.deps.bridge) return;
    const log = getLog();
    let inFlight: DispatchRow[];
    try {
      inFlight = await listInFlight(this.deps.getDb());
    } catch (e) {
      log.error({ err: (e as Error).message }, 'symphony.reconcile_query_failed');
      return;
    }
    for (const row of inFlight) {
      if (!row.workflow_run_id) continue;
      let upstreamStatus: string | null;
      try {
        upstreamStatus = await this.deps.bridge.workflowDeps.store.getWorkflowRunStatus(
          row.workflow_run_id
        );
      } catch (e) {
        log.warn(
          { row_id: row.id, run_id: row.workflow_run_id, err: (e as Error).message },
          'symphony.reconcile_lookup_failed'
        );
        continue;
      }
      if (
        upstreamStatus &&
        (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(upstreamStatus)
      ) {
        const dispatchStatus: DispatchStatus =
          upstreamStatus === 'completed'
            ? 'completed'
            : upstreamStatus === 'cancelled'
              ? 'cancelled'
              : 'failed';
        try {
          await updateStatus(this.deps.getDb(), row.id, dispatchStatus);
        } catch (e) {
          log.warn(
            { row_id: row.id, err: (e as Error).message },
            'symphony.reconcile_status_write_failed'
          );
        }
        this.state.completed.add(row.dispatch_key);
        log.info(
          {
            dispatch_key: row.dispatch_key,
            run_id: row.workflow_run_id,
            upstream_status: upstreamStatus,
          },
          'symphony.reconcile_terminal'
        );
      } else {
        // Still in-flight upstream: register the mapping so terminal events
        // can route here, and remember the dispatch_key as completed-for-now
        // so the polling loop won't re-dispatch the same issue.
        this.runIdToDispatchKey.set(row.workflow_run_id, row.dispatch_key);
        this.state.completed.add(row.dispatch_key);
        log.info(
          {
            dispatch_key: row.dispatch_key,
            run_id: row.workflow_run_id,
            upstream_status: upstreamStatus,
          },
          'symphony.reconcile_in_flight'
        );
      }
    }
  }

  private onWorkflowEvent(event: WorkflowEmitterEvent): void {
    if (
      event.type !== 'workflow_completed' &&
      event.type !== 'workflow_failed' &&
      event.type !== 'workflow_cancelled'
    ) {
      return;
    }
    const dispatchKey = this.runIdToDispatchKey.get(event.runId);
    if (!dispatchKey) return; // not a Symphony-launched run

    const log = getLog();
    void this.applyTerminalEvent(event, dispatchKey).catch((e: unknown) => {
      log.error(
        { dispatch_key: dispatchKey, run_id: event.runId, err: (e as Error).message },
        'symphony.terminal_event_apply_failed'
      );
    });
  }

  private async applyTerminalEvent(
    event:
      | { type: 'workflow_completed'; runId: string }
      | { type: 'workflow_failed'; runId: string; error: string }
      | { type: 'workflow_cancelled'; runId: string; reason: string },
    dispatchKey: string
  ): Promise<void> {
    const log = getLog();
    const entry = this.state.running.get(dispatchKey);
    const dispatchId = entry?.dispatch_id ?? null;

    let dbStatus: DispatchStatus;
    let lastError: string | null = null;
    let scheduleRetryAfter = false;
    if (event.type === 'workflow_completed') {
      dbStatus = 'completed';
    } else if (event.type === 'workflow_failed') {
      dbStatus = 'failed';
      lastError = event.error;
      scheduleRetryAfter = true;
    } else {
      dbStatus = 'cancelled';
      lastError = event.reason;
    }

    if (dispatchId) {
      try {
        await updateStatus(this.deps.getDb(), dispatchId, dbStatus, lastError);
      } catch (e) {
        log.warn(
          { dispatch_key: dispatchKey, err: (e as Error).message },
          'symphony.terminal_db_write_failed'
        );
      }
    }

    // Post backlink comment to tracker (best-effort, fire-and-forget)
    if (entry && event.type !== 'workflow_cancelled') {
      const tracker = this.deps.trackers[entry.tracker];
      if (tracker?.commentOnIssue) {
        const body =
          event.type === 'workflow_completed'
            ? `Symphony workflow completed for ${entry.identifier}.`
            : `Symphony workflow failed for ${entry.identifier}: ${event.error}`;
        try {
          void tracker.commentOnIssue({ issueId: entry.issue_id, body }).catch((e: unknown) => {
            log.warn(
              { dispatch_key: dispatchKey, err: (e as Error).message },
              'symphony.comment_failed'
            );
          });
        } catch (e) {
          log.warn(
            { dispatch_key: dispatchKey, err: (e as Error).message },
            'symphony.comment_failed'
          );
        }
      }
    }

    this.runIdToDispatchKey.delete(event.runId);
    if (entry) {
      this.state.running.delete(dispatchKey);
      this.state.claimed.delete(dispatchKey);
    }
    log.info(
      {
        dispatch_key: dispatchKey,
        run_id: event.runId,
        status: dbStatus,
        error: lastError,
      },
      'symphony.workflow_terminal'
    );

    // Emit Mission Control event for the terminal transition.
    if (entry) {
      const trackerKind = entry.tracker;
      const identifier = entry.identifier;
      if (event.type === 'workflow_completed') {
        this.emitSymphony({
          type: 'dispatch_completed',
          tracker: trackerKind,
          identifier,
          dispatchKey,
          workflowRunId: event.runId,
        });
      } else if (event.type === 'workflow_failed') {
        this.emitSymphony({
          type: 'dispatch_failed',
          tracker: trackerKind,
          identifier,
          dispatchKey,
          workflowRunId: event.runId,
          errorClass: 'workflow_failed',
          errorMessage: event.error,
        });
      } else {
        this.emitSymphony({
          type: 'dispatch_cancelled',
          tracker: trackerKind,
          identifier,
          dispatchKey,
          workflowRunId: event.runId,
          reason: event.reason,
        });
      }
    }

    if (event.type === 'workflow_failed' && scheduleRetryAfter && entry) {
      this.scheduleRetry(
        dispatchKey,
        entry.tracker,
        entry.issue_id,
        entry.identifier,
        (entry.retry_attempt ?? 1) + 1,
        'failure',
        event.error
      );
    } else {
      this.state.completed.add(dispatchKey);
    }
  }

  /** Schedule an immediate refresh; coalesces multiple requests. */
  requestRefresh(): { coalesced: boolean } {
    if (this.pendingRefresh) return { coalesced: true };
    this.pendingRefresh = true;
    this.scheduleTick(0);
    return { coalesced: false };
  }

  /**
   * Hand-triggered immediate dispatch by `dispatch_key`. Bypasses polling but
   * still respects every safety gate.
   */
  async requestImmediateDispatch(dispatchKey: string): Promise<DispatchResult> {
    if (this.stopped) {
      return { ok: false, code: 'stopped', reason: 'orchestrator stopped' };
    }
    const colon = dispatchKey.indexOf(':');
    if (colon <= 0) {
      return {
        ok: false,
        code: 'ineligible',
        reason: `malformed dispatch_key '${dispatchKey}' (expected '<tracker>:<identifier>')`,
      };
    }
    const trackerKind = dispatchKey.slice(0, colon) as TrackerKind;
    const identifier = dispatchKey.slice(colon + 1);
    const snap = this.deps.getSnapshot();
    const tracker = this.deps.trackers[trackerKind];
    if (!tracker) {
      return {
        ok: false,
        code: 'tracker_unconfigured',
        reason: `no tracker configured for kind '${trackerKind}'`,
      };
    }
    const trackerCfg = findTrackerConfig(snap, trackerKind);
    if (!trackerCfg) {
      return {
        ok: false,
        code: 'tracker_unconfigured',
        reason: `snapshot has no '${trackerKind}' tracker config`,
      };
    }
    let issues: Issue[];
    try {
      issues = await tracker.fetchIssuesByStates(trackerCfg.activeStates);
    } catch (e) {
      return {
        ok: false,
        code: 'tracker_fetch_failed',
        reason: `tracker fetch failed: ${(e as Error).message}`,
      };
    }
    const issue = issues.find(i => i.identifier === identifier);
    if (!issue) {
      return {
        ok: false,
        code: 'not_found_in_active_states',
        reason: `issue not found in active states: ${identifier}`,
      };
    }
    const elig = eligibilityForDispatch(issue, trackerKind, this.state, snap);
    if (!elig.ok) {
      return {
        ok: false,
        code: 'ineligible',
        reason: elig.reason ?? 'ineligible',
        eligibility: elig.reason ?? 'ineligible',
      };
    }
    await this.dispatchIssue(issue, trackerKind, snap, null);
    this.notifyObservers();
    return { ok: true, dispatch_key: dispatchKey };
  }

  requestCancel(dispatchKey: string): CancelResult {
    if (this.stopped) {
      return { ok: false, code: 'stopped', reason: 'orchestrator stopped' };
    }
    const target = this.state.running.get(dispatchKey);
    if (!target) {
      return {
        ok: false,
        code: 'not_running',
        reason: `no running entry for dispatch_key: ${dispatchKey}`,
      };
    }
    target.cancel_requested = true;
    target.abort.abort();
    getLog().info(
      { dispatch_key: dispatchKey, identifier: target.identifier },
      'symphony.cancel_requested'
    );

    // Phase 3: also cancel the upstream workflow run. The event emitter will
    // fire `workflow_cancelled` which `applyTerminalEvent` translates into
    // the standard state mutation.
    if (this.deps.bridge && target.workflow_run_id) {
      const runId = target.workflow_run_id;
      void this.deps.bridge.workflowDeps.store.cancelWorkflowRun(runId).catch((e: unknown) => {
        getLog().warn(
          { dispatch_key: dispatchKey, run_id: runId, err: (e as Error).message },
          'symphony.cancel_upstream_failed'
        );
      });
    }

    this.notifyObservers();
    return { ok: true, dispatch_key: dispatchKey };
  }

  onObserve(cb: () => void): void {
    this.observers.push(cb);
  }

  private notifyObservers(): void {
    for (const cb of this.observers) {
      try {
        cb();
      } catch (e) {
        getLog().warn({ err: (e as Error).message }, 'symphony.observer_callback_failed');
      }
    }
  }

  getSnapshotView(): OrchestratorSnapshotView {
    const ts = this.deps.now?.() ?? nowMs();
    const running: OrchestratorRunningRow[] = [];
    for (const entry of this.state.running.values()) {
      running.push({
        dispatch_key: entry.dispatch_key,
        tracker: entry.tracker,
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        state: entry.issue.state,
        started_at: new Date(entry.started_at).toISOString(),
        workflow_run_id: entry.workflow_run_id,
      });
    }
    const retrying: OrchestratorRetryRow[] = [];
    for (const r of this.state.retry_attempts.values()) {
      retrying.push({
        dispatch_key: r.dispatch_key,
        tracker: r.tracker,
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        attempt: r.attempt,
        due_at: new Date(r.due_at_ms).toISOString(),
        error: r.error,
      });
    }
    return {
      generated_at: new Date(ts).toISOString(),
      counts: {
        running: running.length,
        retrying: retrying.length,
        completed: this.state.completed.size,
      },
      running,
      retrying,
    };
  }

  getRunning(dispatchKey: string): RunningEntry | undefined {
    return this.state.running.get(dispatchKey);
  }
  getRetry(dispatchKey: string): RetryEntry | undefined {
    return this.state.retry_attempts.get(dispatchKey);
  }

  /** One iteration of the poll-and-dispatch loop. */
  async runTick(): Promise<void> {
    if (this.stopped) return;
    this.pendingRefresh = false;
    const snap = this.deps.getSnapshot();

    await this.reconcileRunningIssues(snap);

    const pollStart = this.deps.now?.() ?? nowMs();
    const fetches = await Promise.allSettled(
      snap.trackers.map(async cfg => {
        const tracker = this.deps.trackers[cfg.kind];
        if (!tracker) return { kind: cfg.kind, issues: [] as Issue[] };
        const issues = await tracker.fetchCandidateIssues();
        return { kind: cfg.kind, issues };
      })
    );

    const candidates: { kind: TrackerKind; issue: Issue }[] = [];
    for (let i = 0; i < fetches.length; i++) {
      const trackerCfg = snap.trackers[i];
      if (!trackerCfg) continue;
      const result = fetches[i];
      if (!result || result.status === 'rejected') {
        getLog().error(
          {
            tracker: trackerCfg.kind,
            err: result ? (result.reason as Error).message : 'unknown',
          },
          'symphony.tracker_fetch_failed'
        );
        continue;
      }
      const trackerCandidates = result.value.issues.length;
      const pollEnd = this.deps.now?.() ?? nowMs();
      this.emitSymphony({
        type: 'tracker_poll_completed',
        tracker: result.value.kind,
        candidateCount: trackerCandidates,
        durationMs: Math.max(0, pollEnd - pollStart),
      });
      for (const issue of result.value.issues) {
        candidates.push({ kind: result.value.kind, issue });
      }
    }

    const sorted = sortForDispatch(candidates.map(c => c.issue));
    const byIdentifier = new Map<string, TrackerKind>();
    for (const c of candidates) {
      byIdentifier.set(`${c.kind}:${c.issue.identifier}`, c.kind);
    }
    for (const issue of sorted) {
      if (availableGlobalSlots(this.state, snap) <= 0) break;
      // Identifier alone may collide across trackers; we look up the kind
      // from the dispatch_key index built above. If multiple trackers
      // produce the same identifier, both will appear in `candidates` and
      // the for-loop will hit each once.
      let trackerKind: TrackerKind | undefined;
      for (const c of candidates) {
        if (c.issue === issue) {
          trackerKind = c.kind;
          break;
        }
      }
      if (!trackerKind) continue;
      const elig = eligibilityForDispatch(issue, trackerKind, this.state, snap);
      if (!elig.ok) continue;
      if (availableSlotsForState(this.state, snap, issue.state) <= 0) continue;
      await this.dispatchIssue(issue, trackerKind, snap, null);
    }

    this.notifyObservers();
    this.scheduleTick(snap.polling.intervalMs);
  }

  /**
   * Phase 3: launches an Archon workflow run for the issue via the bridge.
   *
   * Without a bridge (test/Phase-2 mode), this is a no-op — the orchestrator
   * still polls and accumulates state, but no DB row is written and no run is
   * launched. Tests that exercise the loop without a real workflow engine
   * should pass an explicit fake bridge.
   */
  private async dispatchIssue(
    issue: Issue,
    trackerKind: TrackerKind,
    snap: ConfigSnapshot,
    attempt: number | null
  ): Promise<void> {
    const dispatchKey = buildDispatchKey(trackerKind, issue.identifier);
    if (
      this.state.running.has(dispatchKey) ||
      this.state.claimed.has(dispatchKey) ||
      this.state.completed.has(dispatchKey)
    ) {
      return;
    }

    if (!this.deps.bridge) {
      // No bridge wired — orchestrator is in poll-only mode. Don't write a
      // DB row, don't launch anything. Mark the dispatch_key completed so the
      // loop's dedup keeps working for the lifetime of this orchestrator.
      this.state.completed.add(dispatchKey);
      return;
    }

    this.state.claimed.add(dispatchKey);
    const existingRetry = this.state.retry_attempts.get(dispatchKey);
    if (existingRetry?.timer_handle) {
      const cancelTimer = this.deps.cancelTimeout ?? clearTimeout;
      cancelTimer(existingRetry.timer_handle);
    }
    this.state.retry_attempts.delete(dispatchKey);

    const codebaseId = this.resolveCodebaseId(trackerKind, issue, snap);
    this.emitSymphony({
      type: 'dispatch_claimed',
      tracker: trackerKind,
      identifier: issue.identifier,
      dispatchKey,
      codebaseId,
      attempt: attempt ?? 1,
    });
    const abort = new AbortController();

    let outcome: DispatchOutcome;
    try {
      outcome = await dispatchToWorkflow(this.deps.getDb(), this.deps.bridge, {
        issue,
        trackerKind,
        snap,
        attempt: attempt ?? 1,
        codebaseId,
        abort,
      });
    } catch (e) {
      // Unexpected throw inside the dispatcher — treat as a failed launch.
      // No DB write happens here; the dispatcher writes its own rows.
      getLog().error(
        { dispatch_key: dispatchKey, err: (e as Error).message },
        'symphony.dispatch_unexpected_error'
      );
      this.state.claimed.delete(dispatchKey);
      this.state.completed.add(dispatchKey);
      return;
    }

    this.state.claimed.delete(dispatchKey);

    if (outcome.status === 'launched' && outcome.dispatchId && outcome.workflowRunId) {
      const entry: RunningEntry = {
        dispatch_key: dispatchKey,
        tracker: trackerKind,
        issue_id: issue.id,
        identifier: issue.identifier,
        issue,
        started_at: this.deps.now?.() ?? nowMs(),
        retry_attempt: attempt,
        abort,
        cancel_requested: false,
        dispatch_id: outcome.dispatchId,
        workflow_run_id: outcome.workflowRunId,
      };
      this.state.running.set(dispatchKey, entry);
      this.runIdToDispatchKey.set(outcome.workflowRunId, dispatchKey);
      this.emitSymphony({
        type: 'dispatch_started',
        tracker: trackerKind,
        identifier: issue.identifier,
        dispatchKey,
        workflowRunId: outcome.workflowRunId,
        dispatchId: outcome.dispatchId,
        codebaseId,
        workflowName: snap.stateWorkflowMap[issue.state] ?? '',
      });
      return;
    }

    // Failed at the dispatcher gate. The dispatcher already wrote a `failed`
    // row for `failed_no_codebase` / `failed_no_workflow`. Config errors do
    // not retry; only the unhandled throw above schedules anything.
    this.state.completed.add(dispatchKey);
    this.emitSymphony({
      type: 'dispatch_failed',
      tracker: trackerKind,
      identifier: issue.identifier,
      dispatchKey,
      workflowRunId: null,
      errorClass: outcome.status,
      errorMessage: outcome.reason ?? 'dispatch failed',
    });
  }

  private resolveCodebaseId(
    trackerKind: TrackerKind,
    issue: Issue,
    snap: ConfigSnapshot
  ): string | null {
    let repoLabel: string | null = null;
    if (trackerKind === 'github') {
      const slashIdx = issue.identifier.indexOf('#');
      if (slashIdx > 0) repoLabel = issue.identifier.slice(0, slashIdx);
    } else {
      const linearCfg = findTrackerConfig(snap, 'linear');
      if (linearCfg?.kind === 'linear') repoLabel = linearCfg.repository;
    }
    if (!repoLabel) {
      const fallback = snap.codebases.find(c => c.tracker === trackerKind);
      return fallback?.codebaseId ?? null;
    }
    const match = snap.codebases.find(c => c.tracker === trackerKind && c.repository === repoLabel);
    return match?.codebaseId ?? null;
  }

  async reconcileRunningIssues(snap: ConfigSnapshot): Promise<void> {
    if (!this.deps.bridge) return;
    const log = getLog();

    // Snapshot entries to avoid mutating the map we're iterating (applyTerminalEvent deletes)
    const entries = [...this.state.running.entries()];
    for (const [dispatchKey, entry] of entries) {
      try {
        if (!entry.workflow_run_id) continue;

        // Step A: Check workflow run status
        let upstreamStatus: string | null;
        try {
          upstreamStatus = await this.deps.bridge.workflowDeps.store.getWorkflowRunStatus(
            entry.workflow_run_id
          );
        } catch (e) {
          log.warn(
            {
              dispatch_key: dispatchKey,
              run_id: entry.workflow_run_id,
              err: (e as Error).message,
            },
            'symphony.reconcile_running_lookup_failed'
          );
          continue;
        }

        if (
          upstreamStatus &&
          (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(upstreamStatus)
        ) {
          let syntheticEvent:
            | { type: 'workflow_completed'; runId: string }
            | { type: 'workflow_failed'; runId: string; error: string }
            | { type: 'workflow_cancelled'; runId: string; reason: string };
          if (upstreamStatus === 'completed') {
            syntheticEvent = { type: 'workflow_completed', runId: entry.workflow_run_id };
          } else if (upstreamStatus === 'cancelled') {
            syntheticEvent = {
              type: 'workflow_cancelled',
              runId: entry.workflow_run_id,
              reason: 'reconcile: already cancelled',
            };
          } else {
            syntheticEvent = {
              type: 'workflow_failed',
              runId: entry.workflow_run_id,
              error: `reconcile: upstream status was ${upstreamStatus}`,
            };
          }
          await this.applyTerminalEvent(syntheticEvent, dispatchKey);
          continue;
        }

        // Step B: Check tracker issue state
        const tracker = this.deps.trackers[entry.tracker];
        const trackerCfg = findTrackerConfig(snap, entry.tracker);
        if (!tracker || !trackerCfg) continue;

        let issues: Issue[];
        try {
          issues = await tracker.fetchIssueStatesByIds([entry.issue_id]);
        } catch (e) {
          log.warn(
            {
              dispatch_key: dispatchKey,
              issue_id: entry.issue_id,
              err: (e as Error).message,
            },
            'symphony.reconcile_running_tracker_fetch_failed'
          );
          continue;
        }

        const issue = issues.find(i => i.id === entry.issue_id);
        if (!issue || !isStateActive(issue.state, trackerCfg)) {
          await this.deps.bridge.workflowDeps.store.cancelWorkflowRun(entry.workflow_run_id);
          await this.applyTerminalEvent(
            {
              type: 'workflow_cancelled',
              runId: entry.workflow_run_id,
              reason: 'issue left active state',
            },
            dispatchKey
          );
        }
      } catch (e) {
        log.warn(
          { dispatch_key: dispatchKey, err: (e as Error).message },
          'symphony.reconcile_running_entry_failed'
        );
      }
    }
  }

  // Retry scheduler kept for forward compatibility with Phase 3; currently
  // unused (the stub dispatch never schedules retries because there is no
  // worker outcome). Keeping the helper avoids re-deriving it later.
  private scheduleRetry(
    dispatchKey: string,
    trackerKind: TrackerKind,
    issueId: string,
    identifier: string,
    attempt: number,
    delayKind: DelayKind,
    error: string | null
  ): void {
    if (this.stopped) return;
    const snap = this.deps.getSnapshot();
    const cancelTimer = this.deps.cancelTimeout ?? clearTimeout;
    const setTimer = this.deps.scheduleTimeout ?? setTimeout;

    const existing = this.state.retry_attempts.get(dispatchKey);
    if (existing?.timer_handle) cancelTimer(existing.timer_handle);

    const delay = computeRetryDelayMs(delayKind, attempt, snap);
    const dueAt = (this.deps.now?.() ?? nowMs()) + delay;
    const handle = setTimer(() => this.onRetryTimer(dispatchKey), delay);
    const entry: RetryEntry = {
      dispatch_key: dispatchKey,
      tracker: trackerKind,
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: dueAt,
      timer_handle: handle,
      error,
      delay_type: delayKind,
    };
    this.state.retry_attempts.set(dispatchKey, entry);
    getLog().info(
      {
        dispatch_key: dispatchKey,
        identifier,
        attempt,
        delay_ms: delay,
        kind: delayKind,
        err: error,
      },
      'symphony.retry_scheduled'
    );
    this.emitSymphony({
      type: 'dispatch_retry_scheduled',
      tracker: trackerKind,
      identifier,
      dispatchKey,
      attempt,
      dueAt: new Date(dueAt).toISOString(),
      delayKind,
      lastError: error,
    });
  }

  private async onRetryTimer(dispatchKey: string): Promise<void> {
    if (this.stopped) return;
    const retry = this.state.retry_attempts.get(dispatchKey);
    if (!retry) return;
    this.state.retry_attempts.delete(dispatchKey);
    const snap = this.deps.getSnapshot();
    const tracker = this.deps.trackers[retry.tracker];
    const trackerCfg = findTrackerConfig(snap, retry.tracker);
    if (!tracker || !trackerCfg) {
      this.state.claimed.delete(dispatchKey);
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await tracker.fetchCandidateIssues();
    } catch (e) {
      this.scheduleRetry(
        dispatchKey,
        retry.tracker,
        retry.issue_id,
        retry.identifier,
        retry.attempt + 1,
        'failure',
        `retry poll failed: ${(e as Error).message}`
      );
      return;
    }

    const issue = candidates.find(i => i.identifier === retry.identifier);
    if (!issue) {
      this.state.claimed.delete(dispatchKey);
      return;
    }
    if (!isStateActive(issue.state, trackerCfg)) {
      this.state.claimed.delete(dispatchKey);
      return;
    }
    const elig = eligibilityForDispatch(issue, retry.tracker, this.state, snap);
    if (!elig.ok && (elig.reason === 'no global slots' || elig.reason === 'no per-state slots')) {
      this.scheduleRetry(
        dispatchKey,
        retry.tracker,
        retry.issue_id,
        retry.identifier,
        retry.attempt + 1,
        'failure',
        'no available orchestrator slots'
      );
      return;
    }
    if (!elig.ok) {
      this.state.claimed.delete(dispatchKey);
      return;
    }
    await this.dispatchIssue(issue, retry.tracker, snap, retry.attempt);
  }
}
