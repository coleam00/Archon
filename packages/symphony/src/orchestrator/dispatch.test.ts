import { describe, test, expect } from 'bun:test';
import {
  availableGlobalSlots,
  availableSlotsForState,
  eligibilityForDispatch,
  findTrackerConfig,
  isStateActive,
  isStateTerminal,
  sortForDispatch,
} from './dispatch';
import { computeRetryDelayMs } from './retry';
import { buildDispatchKey, createInitialState, type RunningEntry } from './state';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import { makeIssue } from '../test/fake-tracker';

interface SnapOpts {
  maxConcurrent?: number;
  perStateCap?: Record<string, number>;
  maxBackoffMs?: number;
}

function snap(opts: SnapOpts = {}): ConfigSnapshot {
  return buildSnapshot(
    {
      trackers: [
        {
          kind: 'linear',
          api_key: '$K',
          project_slug: 'p',
          active_states: ['Todo', 'In Progress'],
          terminal_states: ['Done', 'Canceled'],
        },
      ],
      dispatch: {
        max_concurrent: opts.maxConcurrent ?? 2,
        max_concurrent_by_state: opts.perStateCap ?? {},
        retry: {
          continuation_delay_ms: 1000,
          failure_base_delay_ms: 10000,
          max_backoff_ms: opts.maxBackoffMs ?? 300000,
        },
      },
      polling: { interval_ms: 30000 },
      state_workflow_map: { Todo: 'archon-feature-development' },
      codebases: [],
    },
    { K: 'tok' } as NodeJS.ProcessEnv
  );
}

function makeRunningEntry(id: string): RunningEntry {
  return {
    dispatch_key: buildDispatchKey('linear', `MT-${id}`),
    tracker: 'linear',
    issue_id: id,
    identifier: `MT-${id}`,
    issue: makeIssue({ id, identifier: `MT-${id}`, state: 'Todo' }),
    started_at: 0,
    retry_attempt: null,
    abort: new AbortController(),
    cancel_requested: false,
    dispatch_id: null,
    workflow_run_id: null,
  };
}

describe('sortForDispatch', () => {
  test('priority asc with null last; created_at oldest first; identifier tie-breaker', () => {
    const issues = [
      makeIssue({ id: '1', identifier: 'C-1', priority: 3, created_at: new Date('2026-01-03') }),
      makeIssue({ id: '2', identifier: 'A-1', priority: 1, created_at: new Date('2026-01-02') }),
      makeIssue({ id: '3', identifier: 'A-2', priority: 1, created_at: new Date('2026-01-02') }),
      makeIssue({ id: '4', identifier: 'B-1', priority: null, created_at: new Date('2025-12-01') }),
      makeIssue({ id: '5', identifier: 'D-1', priority: 1, created_at: new Date('2026-01-01') }),
    ];
    const sorted = sortForDispatch(issues).map(i => i.identifier);
    expect(sorted).toEqual(['D-1', 'A-1', 'A-2', 'C-1', 'B-1']);
  });
});

describe('isStateActive / isStateTerminal', () => {
  test('matches case-insensitively against tracker-scoped state lists', () => {
    const s = snap();
    const linear = findTrackerConfig(s, 'linear');
    expect(isStateActive('todo', linear)).toBe(true);
    expect(isStateActive('In Progress', linear)).toBe(true);
    expect(isStateActive('Done', linear)).toBe(false);
    expect(isStateTerminal('done', linear)).toBe(true);
    expect(isStateTerminal('In Progress', linear)).toBe(false);
  });
  test('returns false when tracker config is missing', () => {
    expect(isStateActive('Todo', undefined)).toBe(false);
    expect(isStateTerminal('Done', undefined)).toBe(false);
  });
});

describe('eligibilityForDispatch', () => {
  test('rejects Todo with non-terminal blockers', () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({
      id: 'i',
      identifier: 'MT-1',
      state: 'Todo',
      blocked_by: [{ id: 'x', identifier: 'MT-X', state: 'In Progress' }],
    });
    const r = eligibilityForDispatch(issue, 'linear', state, s);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non-terminal blockers');
  });

  test('accepts Todo with all-terminal blockers', () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({
      id: 'i',
      identifier: 'MT-2',
      state: 'Todo',
      blocked_by: [{ id: 'x', identifier: 'MT-X', state: 'Done' }],
    });
    const r = eligibilityForDispatch(issue, 'linear', state, s);
    expect(r.ok).toBe(true);
  });

  test('rejects non-active states', () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({ id: 'i', identifier: 'MT-3', state: 'Backlog' });
    const r = eligibilityForDispatch(issue, 'linear', state, s);
    expect(r.ok).toBe(false);
  });

  test('rejects when no global slots', () => {
    const s = snap();
    const state = createInitialState();
    state.running.set('linear:MT-a', makeRunningEntry('a'));
    state.running.set('linear:MT-b', makeRunningEntry('b'));
    expect(availableGlobalSlots(state, s)).toBe(0);
    const issue = makeIssue({ id: 'c', identifier: 'MT-C', state: 'Todo' });
    const r = eligibilityForDispatch(issue, 'linear', state, s);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no global slots');
  });

  test('rejects when dispatch_key already in completed set', () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({ id: 'c', identifier: 'MT-C', state: 'Todo' });
    state.completed.add(buildDispatchKey('linear', 'MT-C'));
    const r = eligibilityForDispatch(issue, 'linear', state, s);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already completed');
  });

  test('rejects unknown tracker kind', () => {
    const s = snap();
    const state = createInitialState();
    const issue = makeIssue({ id: 'i', identifier: 'MT-Z', state: 'Todo' });
    const r = eligibilityForDispatch(issue, 'github', state, s);
    expect(r.ok).toBe(false);
  });
});

describe('computeRetryDelayMs', () => {
  test('continuation returns fixed continuation_delay_ms', () => {
    expect(computeRetryDelayMs('continuation', 1, snap())).toBe(1000);
    expect(computeRetryDelayMs('continuation', 5, snap())).toBe(1000);
  });
  test('failure follows base * 2^(n-1) capped by max_backoff_ms', () => {
    const s = snap({ maxBackoffMs: 60_000 });
    expect(computeRetryDelayMs('failure', 1, s)).toBe(10_000);
    expect(computeRetryDelayMs('failure', 2, s)).toBe(20_000);
    expect(computeRetryDelayMs('failure', 3, s)).toBe(40_000);
    expect(computeRetryDelayMs('failure', 4, s)).toBe(60_000);
    expect(computeRetryDelayMs('failure', 10, s)).toBe(60_000);
  });
});

describe('availableSlotsForState', () => {
  test('falls back to global when no per-state cap', () => {
    expect(availableSlotsForState(createInitialState(), snap(), 'Todo')).toBe(2);
  });
  test('uses per-state cap (lowercased) when configured', () => {
    const s = snap({ maxConcurrent: 10, perStateCap: { 'in progress': 1 } });
    expect(availableSlotsForState(createInitialState(), s, 'In Progress')).toBe(1);
    expect(availableSlotsForState(createInitialState(), s, 'Todo')).toBe(10);
  });
});
