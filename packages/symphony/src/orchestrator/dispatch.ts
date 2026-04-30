import type { Issue } from '../tracker/types';
import type { ConfigSnapshot, TrackerConfig, TrackerKind } from '../config/snapshot';
import type { OrchestratorState } from './state';
import { buildDispatchKey } from './state';

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

export function findTrackerConfig(
  snapshot: ConfigSnapshot,
  kind: TrackerKind
): TrackerConfig | undefined {
  return snapshot.trackers.find(t => t.kind === kind);
}

export function isStateActive(state: string, tracker: TrackerConfig | undefined): boolean {
  if (!tracker) return false;
  const lower = state.toLowerCase();
  return tracker.activeStates.some(s => s.toLowerCase() === lower);
}

export function isStateTerminal(state: string, tracker: TrackerConfig | undefined): boolean {
  if (!tracker) return false;
  const lower = state.toLowerCase();
  return tracker.terminalStates.some(s => s.toLowerCase() === lower);
}

export function availableGlobalSlots(state: OrchestratorState, snapshot: ConfigSnapshot): number {
  return Math.max(0, snapshot.dispatch.maxConcurrent - state.running.size);
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
  stateName: string
): number {
  const cap = snapshot.dispatch.maxConcurrentByState[stateName.toLowerCase()];
  if (typeof cap !== 'number') return availableGlobalSlots(state, snapshot);
  const used = countRunningInState(state, stateName);
  return Math.max(0, cap - used);
}

export interface EligibilityDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether an issue from a given tracker can be dispatched right now.
 * State checks use the tracker-scoped state lists from the snapshot — Linear
 * and GitHub configurations have different active/terminal vocabularies, so
 * we must look at the right tracker's lists.
 */
export function eligibilityForDispatch(
  issue: Issue,
  trackerKind: TrackerKind,
  state: OrchestratorState,
  snapshot: ConfigSnapshot
): EligibilityDecision {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { ok: false, reason: 'missing required fields' };
  }
  const tracker = findTrackerConfig(snapshot, trackerKind);
  if (!tracker) {
    return { ok: false, reason: `no tracker configured for kind '${trackerKind}'` };
  }
  if (isStateTerminal(issue.state, tracker)) {
    return { ok: false, reason: 'issue state is terminal' };
  }
  if (!isStateActive(issue.state, tracker)) {
    return { ok: false, reason: 'issue state is not active' };
  }
  const dispatchKey = buildDispatchKey(trackerKind, issue.identifier);
  if (state.running.has(dispatchKey)) return { ok: false, reason: 'already running' };
  if (state.claimed.has(dispatchKey)) return { ok: false, reason: 'already claimed' };
  if (state.completed.has(dispatchKey)) return { ok: false, reason: 'already completed' };
  if (availableGlobalSlots(state, snapshot) <= 0) {
    return { ok: false, reason: 'no global slots' };
  }
  if (availableSlotsForState(state, snapshot, issue.state) <= 0) {
    return { ok: false, reason: 'no per-state slots' };
  }
  // Linear-style "Todo" gate: if any blocker is not yet terminal, defer.
  if (issue.state.toLowerCase() === 'todo') {
    const blockers = issue.blocked_by;
    const anyNonTerminal = blockers.some(b => !isStateTerminal(b.state, tracker));
    if (anyNonTerminal) return { ok: false, reason: 'non-terminal blockers' };
  }
  return { ok: true };
}
