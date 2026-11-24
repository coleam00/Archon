import type { AttentionQueueItem } from '../skills/runs';

type Ask = Extract<AttentionQueueItem, { kind: 'attention' }>;
type Gate = Extract<AttentionQueueItem, { kind: 'awaiting_response' }>;
type UsageLimit = Extract<AttentionQueueItem, { kind: 'usage_limit' }>;
type OverdueWait = Extract<AttentionQueueItem, { kind: 'overdue_wait' }>;

const project = { key: 'acme', codebaseId: 'cb-1', name: 'acme' };
const runRef = (id: string): NonNullable<Ask['run']> => ({
  id,
  workflow: 'deliver',
  parentRunId: null,
  fanOut: null,
  context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
  node: 'decide',
  occurrence: `${id}:pause-1`,
});

/** An open ask on item `#7`, answered by ref, with a recommendation and costed options. */
export function askItem(overrides: Partial<Ask> = {}): Ask {
  return {
    kind: 'attention',
    ref: 'ask:1',
    project,
    item: { id: 'item-7', projectKey: 'acme', key: '#7' },
    revision: 1,
    labels: {},
    pausedAt: '2026-11-16T09:00:00.000Z',
    message: 'Which base should the change target?',
    context: 'The branch was cut from main but the item names dev.',
    form: 'select',
    options: [
      { id: 'use-main', label: 'Use main', does: 'Rebases onto main.', cost: 'Drops dev fixes.' },
      { id: 'use-dev', label: 'Use dev', does: 'Rebases onto dev.', cost: 'One more rebase.' },
    ],
    recommendation: { option: 'use-dev', why: 'Dev is the working base.', confidence: 'high' },
    ...overrides,
  };
}

/** A paused run's approval gate; gates record no pause time. */
export function gateItem(overrides: Partial<Gate> = {}): Gate {
  return {
    kind: 'awaiting_response',
    ref: 'gate:1',
    project,
    revision: 1,
    labels: {},
    pausedAt: null,
    run: runRef('run-gate'),
    message: 'Approve the plan?',
    ...overrides,
  };
}

/** A run waiting out a provider usage limit: it takes no answer. */
export function usageLimitItem(overrides: Partial<UsageLimit> = {}): UsageLimit {
  const { occurrence, ...run } = runRef('run-limit');
  void occurrence;
  return {
    kind: 'usage_limit',
    ref: 'limit:1',
    project,
    revision: 1,
    labels: {},
    pausedAt: '2026-11-16T10:00:00.000Z',
    run,
    resetAt: '2026-11-16T12:00:00.000Z',
    ...overrides,
  };
}

type Unreadable = Extract<AttentionQueueItem, { kind: 'unreadable' }>;

/** A paused run whose wait could not be read: answered on the run, not here. */
export function unreadableItem(overrides: Partial<Unreadable> = {}): Unreadable {
  const { occurrence, ...run } = runRef('run-unreadable');
  void occurrence;
  return {
    kind: 'unreadable',
    ref: 'run-unreadable:1',
    project,
    revision: 1,
    labels: {},
    pausedAt: null,
    run,
    reason: 'child_run_missing',
    detail: 'The child run this one waits on is gone.',
    ...overrides,
  };
}

/** A stage still waiting for a check past its deadline, on item `#9`. */
export function overdueWaitItem(overrides: Partial<OverdueWait> = {}): OverdueWait {
  return {
    kind: 'overdue_wait',
    ref: 'wait:1',
    project,
    item: { id: 'item-9', projectKey: 'acme', key: '#9' },
    revision: 1,
    labels: {},
    pausedAt: '2026-11-16T08:00:00.000Z',
    waitingIn: { runId: 'run-wait', workflow: 'deliver' },
    waits: [{ event: 'check_completed', about: 'CI on the change' }],
    deadline: '2026-11-16T08:40:00.000Z',
    ...overrides,
  };
}
