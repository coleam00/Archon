import type { Issue, Tracker } from "../../src/tracker/types.js";

export interface FakeTrackerControls {
  setIssues(issues: Issue[]): void;
  patchIssue(id: string, patch: Partial<Issue>): void;
  setCandidateError(err: Error | null): void;
  setStateRefreshError(err: Error | null): void;
  setByStatesError(err: Error | null): void;
  candidateCalls: number;
  stateRefreshCalls: number;
  byStatesCalls: number;
}

export function makeFakeTracker(initial: Issue[] = []): {
  tracker: Tracker;
  controls: FakeTrackerControls;
} {
  let issues: Issue[] = [...initial];
  let candidateError: Error | null = null;
  let stateRefreshError: Error | null = null;
  let byStatesError: Error | null = null;

  const controls: FakeTrackerControls = {
    setIssues(next) {
      issues = [...next];
    },
    patchIssue(id, patch) {
      issues = issues.map((i) => (i.id === id ? { ...i, ...patch } : i));
    },
    setCandidateError(e) {
      candidateError = e;
    },
    setStateRefreshError(e) {
      stateRefreshError = e;
    },
    setByStatesError(e) {
      byStatesError = e;
    },
    candidateCalls: 0,
    stateRefreshCalls: 0,
    byStatesCalls: 0,
  };

  const tracker: Tracker = {
    async fetchCandidateIssues() {
      controls.candidateCalls += 1;
      if (candidateError) throw candidateError;
      // emulate active states filter handled at the orchestrator level by returning all
      // — orchestrator's eligibility check excludes terminal states already.
      return issues.map((i) => ({ ...i }));
    },
    async fetchIssueStatesByIds(ids: string[]) {
      controls.stateRefreshCalls += 1;
      if (stateRefreshError) throw stateRefreshError;
      return issues.filter((i) => ids.includes(i.id)).map((i) => ({ ...i }));
    },
    async fetchIssuesByStates(stateNames: string[]) {
      controls.byStatesCalls += 1;
      if (byStatesError) throw byStatesError;
      const set = new Set(stateNames.map((s) => s.toLowerCase()));
      return issues
        .filter((i) => set.has(i.state.toLowerCase()))
        .map((i) => ({ ...i }));
    },
  };

  return { tracker, controls };
}

export function makeIssue(over: Partial<Issue> & { id: string; identifier: string }): Issue {
  return {
    title: `Title for ${over.identifier}`,
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as Issue;
}
