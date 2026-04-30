import type { Issue } from "../tracker/types.js";
import type { ConfigSnapshot } from "../config/snapshot.js";
import type { OrchestratorState } from "./state.js";

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority;
    const pb = b.priority;
    if (pa === null && pb !== null) return 1;
    if (pa !== null && pb === null) return -1;
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    const ta = a.created_at?.getTime() ?? Number.POSITIVE_INFINITY;
    const tb = b.created_at?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    if (a.identifier < b.identifier) return -1;
    if (a.identifier > b.identifier) return 1;
    return 0;
  });
}

export function isStateActive(state: string, snapshot: ConfigSnapshot): boolean {
  const lower = state.toLowerCase();
  return snapshot.tracker.active_states.some((s) => s.toLowerCase() === lower);
}

export function isStateTerminal(state: string, snapshot: ConfigSnapshot): boolean {
  const lower = state.toLowerCase();
  return snapshot.tracker.terminal_states.some((s) => s.toLowerCase() === lower);
}

export function availableGlobalSlots(
  state: OrchestratorState,
  snapshot: ConfigSnapshot,
): number {
  return Math.max(0, snapshot.agent.max_concurrent_agents - state.running.size);
}

export function countRunningInState(state: OrchestratorState, stateName: string): number {
  const lower = stateName.toLowerCase();
  let count = 0;
  for (const entry of state.running.values()) {
    if (entry.issue.state.toLowerCase() === lower) count += 1;
  }
  return count;
}

export function availableSlotsForState(
  state: OrchestratorState,
  snapshot: ConfigSnapshot,
  stateName: string,
): number {
  const cap = snapshot.agent.max_concurrent_agents_by_state[stateName.toLowerCase()];
  if (typeof cap !== "number") return availableGlobalSlots(state, snapshot);
  const used = countRunningInState(state, stateName);
  return Math.max(0, cap - used);
}

export interface EligibilityDecision {
  ok: boolean;
  reason?: string;
}

export function eligibilityForDispatch(
  issue: Issue,
  state: OrchestratorState,
  snapshot: ConfigSnapshot,
): EligibilityDecision {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { ok: false, reason: "missing required fields" };
  }
  if (isStateTerminal(issue.state, snapshot)) {
    return { ok: false, reason: "issue state is terminal" };
  }
  if (!isStateActive(issue.state, snapshot)) {
    return { ok: false, reason: "issue state is not active" };
  }
  if (state.running.has(issue.id)) return { ok: false, reason: "already running" };
  if (state.claimed.has(issue.id)) return { ok: false, reason: "already claimed" };
  if (availableGlobalSlots(state, snapshot) <= 0) {
    return { ok: false, reason: "no global slots" };
  }
  if (availableSlotsForState(state, snapshot, issue.state) <= 0) {
    return { ok: false, reason: "no per-state slots" };
  }
  if (issue.state.toLowerCase() === "todo") {
    const blockers = issue.blocked_by;
    const anyNonTerminal = blockers.some((b) => !isStateTerminal(b.state, snapshot));
    if (anyNonTerminal) return { ok: false, reason: "non-terminal blockers" };
  }
  return { ok: true };
}
