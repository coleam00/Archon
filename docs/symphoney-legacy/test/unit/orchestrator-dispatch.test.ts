import { describe, it, expect } from "vitest";
import {
  availableGlobalSlots,
  availableSlotsForState,
  eligibilityForDispatch,
  isStateActive,
  isStateTerminal,
  sortForDispatch,
} from "../../src/orchestrator/dispatch.js";
import { computeRetryDelayMs } from "../../src/orchestrator/retry.js";
import { createInitialState } from "../../src/orchestrator/state.js";
import { buildSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { makeIssue } from "../helpers/fake-tracker.js";

function snap(opts: { agent?: string; maxConcurrent?: number } = {}) {
  const max = opts.maxConcurrent ?? 2;
  const yaml = `tracker:
  kind: linear
  api_key: $K
  project_slug: p
agent:
  max_concurrent_agents: ${max}${opts.agent ? "\n" + opts.agent : ""}`;
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody\n`);
  return buildSnapshot("/x/WORKFLOW.md", def, { K: "tok" } as NodeJS.ProcessEnv);
}

describe("sortForDispatch", () => {
  it("priority asc with null last; created_at oldest first; identifier tie-breaker", () => {
    const issues = [
      makeIssue({ id: "1", identifier: "C-1", priority: 3, created_at: new Date("2026-01-03") }),
      makeIssue({ id: "2", identifier: "A-1", priority: 1, created_at: new Date("2026-01-02") }),
      makeIssue({ id: "3", identifier: "A-2", priority: 1, created_at: new Date("2026-01-02") }),
      makeIssue({ id: "4", identifier: "B-1", priority: null, created_at: new Date("2025-12-01") }),
      makeIssue({ id: "5", identifier: "D-1", priority: 1, created_at: new Date("2026-01-01") }),
    ];
    const sorted = sortForDispatch(issues).map((i) => i.identifier);
    expect(sorted).toEqual(["D-1", "A-1", "A-2", "C-1", "B-1"]);
  });
});

describe("isStateActive / isStateTerminal", () => {
  it("matches case-insensitively", () => {
    const s = snap();
    expect(isStateActive("todo", s)).toBe(true);
    expect(isStateActive("In Progress", s)).toBe(true);
    expect(isStateActive("Done", s)).toBe(false);
    expect(isStateTerminal("done", s)).toBe(true);
    expect(isStateTerminal("In Progress", s)).toBe(false);
  });
});

describe("eligibilityForDispatch", () => {
  it("rejects Todo with non-terminal blockers", () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({
      id: "i",
      identifier: "MT-1",
      state: "Todo",
      blocked_by: [{ id: "x", identifier: "MT-X", state: "In Progress" }],
    });
    const r = eligibilityForDispatch(issue, state, s);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("non-terminal blockers");
  });
  it("accepts Todo with all-terminal blockers", () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({
      id: "i",
      identifier: "MT-2",
      state: "Todo",
      blocked_by: [{ id: "x", identifier: "MT-X", state: "Done" }],
    });
    const r = eligibilityForDispatch(issue, state, s);
    expect(r.ok).toBe(true);
  });
  it("rejects non-active states", () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({ id: "i", identifier: "MT-3", state: "Backlog" });
    const r = eligibilityForDispatch(issue, state, s);
    expect(r.ok).toBe(false);
  });
  it("rejects when no global slots", () => {
    const s = snap();
    const state = createInitialState();
    const fakeEntry = (id: string) => ({
      issue_id: id,
      identifier: `MT-${id}`,
      issue: makeIssue({ id, identifier: `MT-${id}`, state: "Todo" }),
      started_at: 0,
      retry_attempt: null,
      worker_promise: null,
      abort: new AbortController(),
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
    });
    state.running.set("a", fakeEntry("a"));
    state.running.set("b", fakeEntry("b"));
    expect(availableGlobalSlots(state, s)).toBe(0);
    const issue = makeIssue({ id: "c", identifier: "MT-C", state: "Todo" });
    const r = eligibilityForDispatch(issue, state, s);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no global slots");
  });
});

describe("computeRetryDelayMs", () => {
  it("continuation returns fixed 1000 ms", () => {
    expect(computeRetryDelayMs("continuation", 1, snap())).toBe(1000);
    expect(computeRetryDelayMs("continuation", 5, snap())).toBe(1000);
  });
  it("failure follows 10000 * 2^(n-1) capped by max_retry_backoff_ms", () => {
    const s = snap({ agent: "  max_retry_backoff_ms: 60000" });
    expect(computeRetryDelayMs("failure", 1, s)).toBe(10_000);
    expect(computeRetryDelayMs("failure", 2, s)).toBe(20_000);
    expect(computeRetryDelayMs("failure", 3, s)).toBe(40_000);
    expect(computeRetryDelayMs("failure", 4, s)).toBe(60_000); // capped
    expect(computeRetryDelayMs("failure", 10, s)).toBe(60_000); // still capped
  });
});

describe("availableSlotsForState", () => {
  it("falls back to global when no per-state cap", () => {
    expect(availableSlotsForState(createInitialState(), snap(), "Todo")).toBe(2);
  });
  it("uses per-state cap (lowercased) when configured", () => {
    const s = snap({
      maxConcurrent: 10,
      agent: "  max_concurrent_agents_by_state:\n    'In Progress': 1",
    });
    expect(availableSlotsForState(createInitialState(), s, "In Progress")).toBe(1);
    expect(availableSlotsForState(createInitialState(), s, "Todo")).toBe(10);
  });
});
