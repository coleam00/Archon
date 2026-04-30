import type { Logger } from "pino";
import type { ConfigSnapshot } from "../config/snapshot.js";
import { validateDispatchConfig } from "../config/validate.js";
import type { Issue, Tracker } from "../tracker/types.js";
import type { AgentClient } from "../agent/client.js";
import type { AgentEvent } from "../agent/events.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { buildHookEnv, runHookBestEffort, runHook } from "../workspace/hooks.js";
import { renderPrompt } from "../workflow/prompt.js";
import { WorkflowError } from "../workflow/parse.js";
import type { PublishPullRequest } from "../publisher/pr.js";
import {
  availableGlobalSlots,
  availableSlotsForState,
  eligibilityForDispatch,
  isStateActive,
  isStateTerminal,
  sortForDispatch,
} from "./dispatch.js";
import { computeRetryDelayMs, type DelayKind } from "./retry.js";
import {
  createInitialState,
  nowMs,
  type OrchestratorState,
  type RunningEntry,
  type RetryEntry,
} from "./state.js";

export interface OrchestratorDeps {
  getSnapshot: () => ConfigSnapshot;
  tracker: Tracker;
  agent: AgentClient;
  workspaces: WorkspaceManager;
  logger: Logger;
  /**
   * Publishes the PR after a successful worker run. Failures are logged but
   * do NOT trigger Symphony's retry path (a failed publish is a human-in-the-loop
   * problem, not a transient one). Optional so existing test deps don't need it.
   */
  publishPullRequest?: PublishPullRequest;
  /** Optional clock override for tests. */
  now?: () => number;
  /** Optional setTimeout override for tests. */
  scheduleTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Optional clearTimeout override. */
  cancelTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Spec-listed agent events (SPEC.md:1006-1019) that get their own pino line. */
const LOGGED_AGENT_EVENTS = new Set<string>([
  "session_started",
  "startup_failed",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_ended_with_error",
  "turn_input_required",
  "approval_auto_approved",
  "unsupported_tool_call",
  "rate_limits_updated",
  "malformed",
]);

export interface OrchestratorRunningRow {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface OrchestratorRetryRow {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

export type DispatchResult =
  | { ok: true; issue_id: string }
  | {
      ok: false;
      code:
        | "stopped"
        | "tracker_fetch_failed"
        | "not_found_in_active_states"
        | "ineligible";
      reason: string;
      eligibility?: string;
    };

export type CancelResult =
  | { ok: true; issue_id: string }
  | {
      ok: false;
      code: "stopped" | "not_running";
      reason: string;
    };

export interface OrchestratorSnapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: OrchestratorRunningRow[];
  retrying: OrchestratorRetryRow[];
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    seconds_running: number;
  };
  rate_limits: unknown;
}

export class Orchestrator {
  private readonly state: OrchestratorState = createInitialState();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pendingRefresh = false;
  private observers: Array<() => void> = [];

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Public read-only accessors for tests / introspection. */
  get internalState(): OrchestratorState {
    return this.state;
  }

  /** Run the startup terminal-workspace cleanup. Best-effort — never throws. */
  async startupCleanup(): Promise<void> {
    const snap = this.deps.getSnapshot();
    try {
      const terminal = await this.deps.tracker.fetchIssuesByStates(snap.tracker.terminal_states);
      for (const issue of terminal) {
        try {
          await this.deps.workspaces.removeForIssue(issue.identifier, issue);
        } catch (e) {
          this.deps.logger.warn(
            { issue_identifier: issue.identifier, err: (e as Error).message },
            "startup_cleanup_remove_failed",
          );
        }
      }
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message }, "startup_cleanup_fetch_failed");
    }
  }

  /** Schedule the next tick after `ms` (or run immediately when ms == 0). */
  scheduleTick(ms: number): void {
    if (this.stopped) return;
    if (this.tickTimer) {
      const cancel = this.deps.cancelTimeout ?? clearTimeout;
      cancel(this.tickTimer);
      this.tickTimer = null;
    }
    const set = this.deps.scheduleTimeout ?? setTimeout;
    this.tickTimer = set(() => {
      this.tickTimer = null;
      void this.runTick();
    }, Math.max(0, ms));
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
    // Abort all running workers and wait for them to finish.
    const promises: Array<Promise<void>> = [];
    for (const entry of this.state.running.values()) {
      entry.abort.abort();
      if (entry.worker_promise) promises.push(entry.worker_promise.catch(() => {}));
    }
    await Promise.all(promises);
  }

  /** Schedule an immediate refresh; coalesces multiple requests. */
  requestRefresh(): { coalesced: boolean } {
    if (this.pendingRefresh) return { coalesced: true };
    this.pendingRefresh = true;
    this.scheduleTick(0);
    return { coalesced: false };
  }

  /**
   * Hand-triggered immediate dispatch for a specific issue identifier.
   *
   * Bypasses the polling cadence but STILL respects every safety gate:
   * slot caps, claimed/running de-dupe, blockers, and the active-state
   * requirement. Returns a structured `code` so the HTTP layer can map
   * to status codes without string-matching the human-readable reason.
   */
  async requestImmediateDispatch(identifier: string): Promise<DispatchResult> {
    if (this.stopped) {
      return { ok: false, code: "stopped", reason: "orchestrator stopped" };
    }
    const snap = this.deps.getSnapshot();
    let issues: Issue[];
    try {
      issues = await this.deps.tracker.fetchIssuesByStates(
        snap.tracker.active_states,
      );
    } catch (e) {
      return {
        ok: false,
        code: "tracker_fetch_failed",
        reason: `tracker fetch failed: ${(e as Error).message}`,
      };
    }
    const issue = issues.find((i) => i.identifier === identifier);
    if (!issue) {
      return {
        ok: false,
        code: "not_found_in_active_states",
        reason: `issue not found in active states: ${identifier}`,
      };
    }
    const elig = eligibilityForDispatch(issue, this.state, snap);
    if (!elig.ok) {
      return {
        ok: false,
        code: "ineligible",
        reason: elig.reason ?? "ineligible",
        eligibility: elig.reason ?? "ineligible",
      };
    }
    this.dispatchIssue(issue, snap, null);
    this.notifyObservers();
    return { ok: true, issue_id: issue.id };
  }

  /**
   * Hand-triggered cancel for a currently-running issue identifier.
   *
   * Aborts the worker and marks the entry so `onWorkerExit` skips the
   * automatic retry-schedule path. The Linear state is left alone — the next
   * poll cycle can repick the issue if it's still active.
   */
  requestCancel(identifier: string): CancelResult {
    if (this.stopped) {
      return { ok: false, code: "stopped", reason: "orchestrator stopped" };
    }
    let target: RunningEntry | null = null;
    for (const entry of this.state.running.values()) {
      if (entry.identifier === identifier) {
        target = entry;
        break;
      }
    }
    if (!target) {
      return {
        ok: false,
        code: "not_running",
        reason: `no running entry for identifier: ${identifier}`,
      };
    }
    target.cancel_requested = true;
    target.abort.abort();
    this.deps.logger
      .child({ issue_id: target.issue_id, issue_identifier: target.identifier })
      .info("cancel_requested");
    this.notifyObservers();
    return { ok: true, issue_id: target.issue_id };
  }

  onObserve(cb: () => void): void {
    this.observers.push(cb);
  }

  private notifyObservers(): void {
    for (const cb of this.observers) {
      try {
        cb();
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message }, "observer_callback_failed");
      }
    }
  }

  /** Public API: full runtime snapshot for the HTTP API. */
  getSnapshot(): OrchestratorSnapshot {
    const ts = this.deps.now?.() ?? nowMs();

    const running: OrchestratorRunningRow[] = [];
    let extraSeconds = 0;
    for (const entry of this.state.running.values()) {
      running.push({
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        state: entry.issue.state,
        session_id: entry.session_id,
        turn_count: entry.turn_count,
        last_event: entry.last_codex_event,
        last_message: entry.last_codex_message,
        started_at: new Date(entry.started_at).toISOString(),
        last_event_at: entry.last_codex_timestamp
          ? new Date(entry.last_codex_timestamp).toISOString()
          : null,
        tokens: {
          input_tokens: entry.codex_input_tokens,
          output_tokens: entry.codex_output_tokens,
          total_tokens: entry.codex_total_tokens,
        },
      });
      extraSeconds += Math.max(0, (ts - entry.started_at) / 1000);
    }

    const retrying: OrchestratorRetryRow[] = [];
    for (const r of this.state.retry_attempts.values()) {
      retrying.push({
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        attempt: r.attempt,
        due_at: new Date(r.due_at_ms).toISOString(),
        error: r.error,
      });
    }

    return {
      generated_at: new Date(ts).toISOString(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        input_tokens: this.state.codex_totals.input_tokens,
        output_tokens: this.state.codex_totals.output_tokens,
        total_tokens: this.state.codex_totals.total_tokens,
        cache_creation_input_tokens: this.state.codex_totals.cache_creation_input_tokens,
        cache_read_input_tokens: this.state.codex_totals.cache_read_input_tokens,
        seconds_running: this.state.codex_totals.seconds_running + extraSeconds,
      },
      rate_limits: this.state.codex_rate_limits,
    };
  }

  getRunningById(issueId: string): RunningEntry | undefined {
    return this.state.running.get(issueId);
  }
  getRetryById(issueId: string): RetryEntry | undefined {
    return this.state.retry_attempts.get(issueId);
  }

  /** One iteration of the poll-and-dispatch loop. */
  async runTick(): Promise<void> {
    if (this.stopped) return;
    this.pendingRefresh = false;
    const snap = this.deps.getSnapshot();

    await this.reconcileRunningIssues(snap);

    const validation = validateDispatchConfig(snap);
    if (!validation.ok) {
      this.deps.logger.error(
        { code: validation.code, err: validation.message },
        "dispatch_validation_failed",
      );
      this.notifyObservers();
      this.scheduleTick(snap.polling.interval_ms);
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await this.deps.tracker.fetchCandidateIssues();
    } catch (e) {
      this.deps.logger.error({ err: (e as Error).message }, "tracker_fetch_failed");
      this.notifyObservers();
      this.scheduleTick(snap.polling.interval_ms);
      return;
    }

    for (const issue of sortForDispatch(candidates)) {
      if (availableGlobalSlots(this.state, snap) <= 0) break;
      const elig = eligibilityForDispatch(issue, this.state, snap);
      if (!elig.ok) continue;
      this.dispatchIssue(issue, snap, null);
    }

    this.notifyObservers();
    this.scheduleTick(snap.polling.interval_ms);
  }

  /** Dispatch a single issue: claim, spawn worker. */
  private dispatchIssue(issue: Issue, snap: ConfigSnapshot, attempt: number | null): void {
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) return;
    const abort = new AbortController();
    const startedAt = this.deps.now?.() ?? nowMs();
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      started_at: startedAt,
      retry_attempt: attempt,
      worker_promise: null,
      abort,
      session_id: null,
      thread_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_message: null,
      last_codex_timestamp: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      codex_cache_creation_input_tokens: 0,
      codex_cache_read_input_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      last_reported_cache_creation_input_tokens: 0,
      last_reported_cache_read_input_tokens: 0,
      turn_count: 0,
      cancel_requested: false,
      publish_result: null,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    const existingRetry = this.state.retry_attempts.get(issue.id);
    if (existingRetry?.timer_handle) {
      const cancel = this.deps.cancelTimeout ?? clearTimeout;
      cancel(existingRetry.timer_handle);
    }
    this.state.retry_attempts.delete(issue.id);

    const log = this.deps.logger.child({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    log.info({ attempt }, "dispatch_started");

    entry.worker_promise = this.runWorker(entry, snap, attempt).then(
      () => this.onWorkerExit(entry.issue_id, "normal"),
      (err) => this.onWorkerExit(entry.issue_id, "abnormal", (err as Error).message),
    );
  }

  /** Run the agent attempt for the given entry. Resolves on clean exit; rejects on failure. */
  private async runWorker(
    entry: RunningEntry,
    snap: ConfigSnapshot,
    attempt: number | null,
  ): Promise<void> {
    const log = this.deps.logger.child({
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
    });

    const workspace = await this.deps.workspaces.createForIssue(entry.identifier, entry.issue);

    const hookEnv = buildHookEnv({
      workspacePath: workspace.path,
      workflowPath: snap.workflow_path,
      issue: entry.issue,
      attempt: attempt ?? 0,
    });

    if (snap.hooks.before_run) {
      const res = await runHook({
        name: "before_run",
        script: snap.hooks.before_run,
        cwd: workspace.path,
        timeoutMs: snap.hooks.timeout_ms,
        env: hookEnv,
      });
      if (!res.ok) {
        throw new Error(`before_run hook failed: ${res.error ?? `exit=${res.exitCode}`}`);
      }
    }

    const session = await this.deps.agent.startSession({
      workspace: workspace.path,
      issue: entry.issue,
      snapshot: snap,
      onEvent: (e) => this.applyAgentEvent(entry, e),
      signal: entry.abort.signal,
    });
    entry.thread_id = session.info.thread_id;
    entry.codex_app_server_pid = session.info.codex_app_server_pid;
    entry.session_id = `${session.info.thread_id}-init`;

    try {
      const maxTurns = snap.agent.max_turns;
      let turnNumber = 1;
      let currentIssue = entry.issue;

      while (true) {
        if (entry.abort.signal.aborted) {
          throw new Error("aborted");
        }

        // Continuation turns SHOULD send only continuation guidance, not the
        // full rendered task prompt (SPEC.md:633-634). Turn 1 still renders.
        const promptText =
          turnNumber === 1
            ? await renderPrompt(snap.prompt_template, {
                issue: currentIssue,
                attempt,
                turn_number: turnNumber,
                max_turns: maxTurns,
              }).catch((e) => {
                if (e instanceof WorkflowError) throw e;
                throw new WorkflowError("template_render_error", (e as Error).message, e);
              })
            : snap.agent.continuation_prompt;

        entry.turn_count = turnNumber;

        const turnResultPromise = session.runTurn({
          prompt: promptText,
          issue: currentIssue,
          attempt,
          turnNumber,
          onEvent: (e) => this.applyAgentEvent(entry, e),
        });
        const result = await Promise.race([
          turnResultPromise,
          this.turnTimeoutReject(snap.agent.turn_timeout_ms),
        ]);

        if (!result.ok) {
          throw new Error(`turn ${turnNumber} failed: ${result.reason ?? "unknown"} ${result.message ?? ""}`.trim());
        }

        // Refresh issue state to decide whether to continue.
        let refreshed: Issue[] = [];
        try {
          refreshed = await this.deps.tracker.fetchIssueStatesByIds([entry.issue_id]);
        } catch (e) {
          throw new Error(`issue state refresh failed: ${(e as Error).message}`);
        }
        const refreshedIssue = refreshed[0];
        if (refreshedIssue) currentIssue = refreshedIssue;
        entry.issue = currentIssue;

        if (!isStateActive(currentIssue.state, snap)) break;
        if (turnNumber >= maxTurns) break;
        turnNumber += 1;
      }
      log.info({ turns: entry.turn_count }, "worker_completed");

      // Wave 0.6: publish PR + Linear backlink on the success path. Failures
      // here are recorded on the entry and logged loudly but do NOT throw —
      // a publish failure is human-in-the-loop work, not a retry candidate.
      if (this.deps.publishPullRequest) {
        try {
          const result = await this.deps.publishPullRequest({
            workspacePath: workspace.path,
            issue: entry.issue,
            tracker: this.deps.tracker,
            log,
            repository: snap.tracker.repository ?? null,
          });
          entry.publish_result = result.url ?? result.skipped ?? null;
        } catch (e) {
          const err = e as Error & { code?: string };
          log.error(
            { err: err.message, code: err.code ?? null },
            "pr_publish_failed",
          );
          entry.publish_result = `failed: ${err.message}`;
        }
      }
    } finally {
      try {
        await session.stop();
      } catch (e) {
        log.warn({ err: (e as Error).message }, "session_stop_failed");
      }
      if (snap.hooks.after_run) {
        await runHookBestEffort({
          name: "after_run",
          script: snap.hooks.after_run,
          cwd: workspace.path,
          timeoutMs: snap.hooks.timeout_ms,
          env: hookEnv,
        });
      }
    }
  }

  private turnTimeoutReject(ms: number): Promise<never> {
    return new Promise<never>((_, reject) => {
      const set = this.deps.scheduleTimeout ?? setTimeout;
      set(() => reject(new Error("turn_timeout")), Math.max(1, ms));
    });
  }

  private applyAgentEvent(entry: RunningEntry, e: AgentEvent): void {
    const ts = Date.parse(e.timestamp);
    const tsMs = isNaN(ts) ? this.deps.now?.() ?? nowMs() : ts;
    entry.last_codex_event = e.event;
    entry.last_codex_timestamp = tsMs;
    if (typeof e.message === "string") entry.last_codex_message = e.message;
    if (e.thread_id) entry.thread_id = e.thread_id;
    if (e.session_id) entry.session_id = e.session_id;
    if (typeof e.codex_app_server_pid === "number") {
      entry.codex_app_server_pid = e.codex_app_server_pid;
    }

    if (e.usage) {
      const newInput = e.usage.input_tokens;
      const newOutput = e.usage.output_tokens;
      const newTotal = e.usage.total_tokens;

      const applyDelta = (
        next: number | null | undefined,
        last: number,
        sum: number,
      ): { last: number; sum: number } => {
        if (typeof next !== "number" || !Number.isFinite(next) || next < last) {
          return { last, sum };
        }
        const delta = next - last;
        return { last: next, sum: sum + delta };
      };

      const inp = applyDelta(
        newInput,
        entry.last_reported_input_tokens,
        this.state.codex_totals.input_tokens,
      );
      this.state.codex_totals.input_tokens = inp.sum;
      entry.last_reported_input_tokens = inp.last;
      entry.codex_input_tokens = entry.last_reported_input_tokens;

      const out = applyDelta(
        newOutput,
        entry.last_reported_output_tokens,
        this.state.codex_totals.output_tokens,
      );
      this.state.codex_totals.output_tokens = out.sum;
      entry.last_reported_output_tokens = out.last;
      entry.codex_output_tokens = entry.last_reported_output_tokens;

      const tot = applyDelta(
        newTotal,
        entry.last_reported_total_tokens,
        this.state.codex_totals.total_tokens,
      );
      this.state.codex_totals.total_tokens = tot.sum;
      entry.last_reported_total_tokens = tot.last;
      entry.codex_total_tokens = entry.last_reported_total_tokens;

      const cacheCreation = applyDelta(
        e.usage.cache_creation_input_tokens,
        entry.last_reported_cache_creation_input_tokens,
        this.state.codex_totals.cache_creation_input_tokens,
      );
      this.state.codex_totals.cache_creation_input_tokens = cacheCreation.sum;
      entry.last_reported_cache_creation_input_tokens = cacheCreation.last;
      entry.codex_cache_creation_input_tokens = entry.last_reported_cache_creation_input_tokens;

      const cacheRead = applyDelta(
        e.usage.cache_read_input_tokens,
        entry.last_reported_cache_read_input_tokens,
        this.state.codex_totals.cache_read_input_tokens,
      );
      this.state.codex_totals.cache_read_input_tokens = cacheRead.sum;
      entry.last_reported_cache_read_input_tokens = cacheRead.last;
      entry.codex_cache_read_input_tokens = entry.last_reported_cache_read_input_tokens;
    }

    if (e.event === "rate_limits_updated") {
      this.state.codex_rate_limits = e.rate_limits ?? null;
    }

    // Spec-listed agent events (SPEC.md:1006-1019) get their own structured
    // log line so operators can `tail -f` for `agent_event` and grep by event
    // type. Required context fields per SPEC.md:1247-1262 (issue_id,
    // issue_identifier, session_id) are included.
    if (LOGGED_AGENT_EVENTS.has(e.event)) {
      this.deps.logger
        .child({ issue_id: entry.issue_id, issue_identifier: entry.identifier })
        .info(
          {
            event: e.event,
            turn_id: e.turn_id ?? null,
            session_id: e.session_id ?? entry.session_id ?? null,
            usage: e.usage ?? null,
            message: e.message ?? null,
          },
          "agent_event",
        );
    }
  }

  private onWorkerExit(issueId: string, reason: "normal" | "abnormal", error?: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const ts = this.deps.now?.() ?? nowMs();
    const seconds = Math.max(0, (ts - entry.started_at) / 1000);
    this.state.codex_totals.seconds_running += seconds;
    this.state.running.delete(issueId);

    const log = this.deps.logger.child({
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
    });

    if (entry.cancel_requested) {
      // User-initiated cancel: leave the claim cleared so the next normal poll
      // can repick the issue, but do NOT auto-retry — they pressed Cancel.
      this.state.claimed.delete(issueId);
      log.info({ seconds }, "worker_exit_cancelled");
    } else if (reason === "normal") {
      this.state.completed.add(issueId);
      log.info({ seconds }, "worker_exit_normal");
      this.scheduleRetry(issueId, 1, "continuation", entry.identifier, null);
    } else {
      const nextAttempt = (entry.retry_attempt ?? 0) + 1;
      log.warn({ err: error, attempt: nextAttempt }, "worker_exit_abnormal");
      this.scheduleRetry(issueId, nextAttempt, "failure", entry.identifier, error ?? null);
    }

    this.notifyObservers();
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    delayKind: DelayKind,
    identifier: string,
    error: string | null,
  ): void {
    if (this.stopped) return;
    const snap = this.deps.getSnapshot();
    const cancel = this.deps.cancelTimeout ?? clearTimeout;
    const set = this.deps.scheduleTimeout ?? setTimeout;

    const existing = this.state.retry_attempts.get(issueId);
    if (existing?.timer_handle) cancel(existing.timer_handle);

    const delay = computeRetryDelayMs(delayKind, attempt, snap);
    const dueAt = (this.deps.now?.() ?? nowMs()) + delay;
    const handle = set(() => this.onRetryTimer(issueId), delay);
    const entry: RetryEntry = {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: dueAt,
      timer_handle: handle,
      error,
      delay_type: delayKind,
    };
    this.state.retry_attempts.set(issueId, entry);

    this.deps.logger.child({ issue_id: issueId, issue_identifier: identifier }).info(
      { attempt, delay_ms: delay, kind: delayKind, err: error },
      "retry_scheduled",
    );
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    if (this.stopped) return;
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    this.state.retry_attempts.delete(issueId);
    const snap = this.deps.getSnapshot();

    let candidates: Issue[];
    try {
      candidates = await this.deps.tracker.fetchCandidateIssues();
    } catch (e) {
      this.deps.logger
        .child({ issue_id: issueId, issue_identifier: retry.identifier })
        .warn({ err: (e as Error).message }, "retry_fetch_failed");
      this.scheduleRetry(issueId, retry.attempt + 1, "failure", retry.identifier, "retry poll failed");
      return;
    }

    const issue = candidates.find((i) => i.id === issueId);
    if (!issue) {
      this.state.claimed.delete(issueId);
      return;
    }
    if (!isStateActive(issue.state, snap)) {
      this.state.claimed.delete(issueId);
      return;
    }
    const elig = eligibilityForDispatch(issue, this.state, snap);
    if (!elig.ok && (elig.reason === "no global slots" || elig.reason === "no per-state slots")) {
      this.scheduleRetry(
        issueId,
        retry.attempt + 1,
        "failure",
        issue.identifier,
        "no available orchestrator slots",
      );
      return;
    }
    if (!elig.ok) {
      this.state.claimed.delete(issueId);
      return;
    }
    this.dispatchIssue(issue, snap, retry.attempt);
  }

  /** Reconcile both stalled and tracker-state shifts against running entries. */
  async reconcileRunningIssues(snap: ConfigSnapshot): Promise<void> {
    const now = this.deps.now?.() ?? nowMs();

    // Part A: stall detection
    if (snap.agent.stall_timeout_ms > 0) {
      for (const entry of [...this.state.running.values()]) {
        const ref = entry.last_codex_timestamp ?? entry.started_at;
        if (now - ref > snap.agent.stall_timeout_ms) {
          this.deps.logger
            .child({ issue_id: entry.issue_id, issue_identifier: entry.identifier })
            .warn({ idle_ms: now - ref }, "stall_detected");
          entry.abort.abort();
          // The worker promise rejects; onWorkerExit handles retry scheduling.
        }
      }
    }

    // Part B: tracker state refresh
    if (this.state.running.size === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.deps.tracker.fetchIssueStatesByIds(
        [...this.state.running.keys()],
      );
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message }, "reconcile_refresh_failed");
      return;
    }

    const refreshedById = new Map(refreshed.map((i) => [i.id, i]));
    for (const entry of [...this.state.running.values()]) {
      const next = refreshedById.get(entry.issue_id);
      if (!next) continue;
      if (isStateTerminal(next.state, snap)) {
        const log = this.deps.logger.child({
          issue_id: entry.issue_id,
          issue_identifier: entry.identifier,
        });
        log.info({ to: next.state }, "reconcile_terminal_kill");
        entry.abort.abort();

        const cleanupId = entry.issue_id;
        const cleanupIdent = entry.identifier;
        const cleanupIssue = next;
        const cleanupEntry = entry; // capture by ref; we mutate publish_result on it

        if (entry.worker_promise) {
          void entry.worker_promise
            .catch(() => {})
            .then(async () => {
              // Phase 0 fix: publish BEFORE removing the workspace, unless
              // the success path already published (entry.publish_result set).
              // If publish throws (e.g. dirty_workspace), KEEP the workspace
              // so a human can recover uncommitted work — do NOT call removeForIssue.
              // The same protection applies when the success path's publish
              // already failed and recorded "failed: ..." on the entry.
              let safeToRemove = true;
              if (
                this.deps.publishPullRequest &&
                cleanupEntry.publish_result === null
              ) {
                try {
                  const result = await this.deps.publishPullRequest({
                    workspacePath: this.deps.workspaces.pathFor(cleanupIdent),
                    issue: cleanupIssue,
                    tracker: this.deps.tracker,
                    log,
                    repository: snap.tracker.repository ?? null,
                  });
                  cleanupEntry.publish_result = result.url ?? result.skipped ?? null;
                } catch (e) {
                  const err = e as Error & { code?: string };
                  log.error(
                    { err: err.message, code: err.code ?? null },
                    "reconcile_publish_failed_keeping_workspace",
                  );
                  cleanupEntry.publish_result = `failed: ${err.message}`;
                  safeToRemove = false;
                }
              } else if (cleanupEntry.publish_result?.startsWith("failed:")) {
                log.error(
                  { publish_result: cleanupEntry.publish_result },
                  "reconcile_publish_already_failed_keeping_workspace",
                );
                safeToRemove = false;
              }
              if (safeToRemove) {
                try {
                  await this.deps.workspaces.removeForIssue(cleanupIdent, cleanupIssue);
                } catch (e) {
                  log.warn(
                    { issue_id: cleanupId, err: (e as Error).message },
                    "reconcile_cleanup_failed",
                  );
                }
              }
            });
        }
      } else if (isStateActive(next.state, snap)) {
        entry.issue = next;
      } else {
        this.deps.logger
          .child({ issue_id: entry.issue_id, issue_identifier: entry.identifier })
          .info({ to: next.state }, "reconcile_inactive_kill");
        entry.abort.abort();
      }
    }
  }
}
