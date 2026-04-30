import type { Issue } from "../tracker/types.js";

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  seconds_running: number;
}

export interface RunningEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  started_at: number;
  retry_attempt: number | null;
  worker_promise: Promise<void> | null;
  abort: AbortController;
  session_id: string | null;
  thread_id: string | null;
  codex_app_server_pid: number | null;
  last_codex_event: string | null;
  last_codex_message: string | null;
  last_codex_timestamp: number | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  codex_cache_creation_input_tokens: number;
  codex_cache_read_input_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  last_reported_cache_creation_input_tokens: number;
  last_reported_cache_read_input_tokens: number;
  turn_count: number;
  cancel_requested: boolean;
  /**
   * Outcome of the PR-publishing step run after a successful worker exit.
   * `null` means the publisher hasn't run (yet), `skipped: "no_changes"` is a
   * deliberate no-op, otherwise the PR URL or a failure message string.
   */
  publish_result: string | null;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout> | null;
  error: string | null;
  delay_type: "continuation" | "failure";
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: CodexTotals;
  codex_rate_limits: unknown | null;
}

export function createInitialState(): OrchestratorState {
  return {
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      seconds_running: 0,
    },
    codex_rate_limits: null,
  };
}

export function nowMs(): number {
  return Date.now();
}

export function nowIso(ts: number = nowMs()): string {
  return new Date(ts).toISOString();
}
