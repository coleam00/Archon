import type { IDatabase } from '@archon/core/db';
import { createLogger } from '@archon/paths';
import type { Issue, Tracker } from '../tracker/types';
import type { ConfigSnapshot, TrackerKind } from '../config/snapshot';
import { insertDispatch } from '../db/dispatches';
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

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Public read-only accessor for tests. */
  get internalState(): OrchestratorState {
    return this.state;
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
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
   * Phase 2 stub: writes a `symphony_dispatches` row with `workflow_run_id =
   * null`, logs `symphony.dispatch_skipped`, and marks the dispatch_key as
   * completed in memory so the next tick does not re-dispatch. Phase 3 will
   * replace this body with a real `executeWorkflow(...)` invocation.
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

    const workflowName = snap.stateWorkflowMap[issue.state];
    if (!workflowName) {
      getLog().warn(
        {
          dispatch_key: dispatchKey,
          identifier: issue.identifier,
          state: issue.state,
        },
        'symphony.dispatch_no_workflow_for_state'
      );
      return;
    }

    const codebaseId = this.resolveCodebaseId(trackerKind, issue, snap);
    this.state.claimed.add(dispatchKey);
    const existingRetry = this.state.retry_attempts.get(dispatchKey);
    if (existingRetry?.timer_handle) {
      const cancelTimer = this.deps.cancelTimeout ?? clearTimeout;
      cancelTimer(existingRetry.timer_handle);
    }
    this.state.retry_attempts.delete(dispatchKey);

    const log = getLog();
    try {
      await insertDispatch(this.deps.getDb(), {
        issue_id: issue.id,
        identifier: issue.identifier,
        tracker: trackerKind,
        dispatch_key: dispatchKey,
        codebase_id: codebaseId,
        workflow_name: workflowName,
        workflow_run_id: null,
        attempt: attempt ?? 1,
        status: 'pending',
      });
    } catch (e) {
      log.warn(
        {
          dispatch_key: dispatchKey,
          identifier: issue.identifier,
          err: (e as Error).message,
        },
        'symphony.dispatch_db_conflict'
      );
      // Row already exists from a prior process: treat as completed for this
      // Symphony instance so we don't loop. Phase 3 will reconcile against the
      // existing workflow_run_id instead.
      this.state.claimed.delete(dispatchKey);
      this.state.completed.add(dispatchKey);
      return;
    }

    log.info(
      {
        dispatch_key: dispatchKey,
        identifier: issue.identifier,
        tracker: trackerKind,
        workflow: workflowName,
        codebase_id: codebaseId,
        attempt: attempt ?? 1,
      },
      'symphony.dispatch_skipped'
    );

    // Stub completion: Phase 3 replaces this with a workflow run lifecycle.
    this.state.claimed.delete(dispatchKey);
    this.state.completed.add(dispatchKey);
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

  /**
   * Phase 2 leaves reconcile as a no-op stub. Phase 3 will fill in:
   *   - poll workflow_run statuses for in-flight entries,
   *   - on terminal status, update the in-memory state and persist
   *     `status` on the symphony_dispatches row.
   */
  async reconcileRunningIssues(_snap: ConfigSnapshot): Promise<void> {
    // intentionally empty in Phase 2
    return;
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
