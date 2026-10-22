/** Fakes for run ownership: the detached owner, the live owner, attention waits and cleanup. */
import { mock } from 'bun:test';
import type * as RunOwnerStop from '@archon/core/services/run-owner-stop';
import { DetachedRunOwnerUnavailableError as RealDetachedRunOwnerUnavailableError } from '@archon/core/services/run-owner-stop';

export const mockDetachedTargetStop = mock(async () => ({ warnings: [] }));
export const mockDetachedTargetRelease = mock((): undefined => undefined);
export const mockReclaimContainerEnv = mock((): Promise<void> => Promise.resolve());
export const mockRequestDetachedRunStop = mock<typeof RunOwnerStop.requestDetachedRunStop>(() =>
  Promise.resolve({ pid: 4242, stop: mockDetachedTargetStop, release: mockDetachedTargetRelease })
);
export const mockRunLiveOwnerClose = mock((): Promise<void> => Promise.resolve());
export const mockClaimDetachedRunProcessOwner = mock((): Promise<void> => Promise.resolve());
let mockDetachedStopRequested = false;
export function setMockDetachedStopRequested(value: boolean): void {
  mockDetachedStopRequested = value;
}
export const mockStartRunLiveOwner = mock<
  typeof import('@archon/core/services/run-live-owner').startRunLiveOwner
>(async () => ({
  close: mockRunLiveOwnerClose,
  isStopRequested: (): boolean => mockDetachedStopRequested,
  registerTerminationPreparation: () => () => undefined,
}));

const realDetachedControl = { ...(await import('../utils/detached-run-control')) };
mock.module('../utils/detached-run-control', () => ({
  ...realDetachedControl,
  claimDetachedRunProcessOwner: mockClaimDetachedRunProcessOwner,
}));

// Capture the real class before mock.module replaces the module, so the mock
// can re-export it without a hand-declared copy that would silently drift.
mock.module('@archon/core/services/run-owner-stop', () => ({
  requestDetachedRunStop: mockRequestDetachedRunStop,
  DetachedRunOwnerUnavailableError: RealDetachedRunOwnerUnavailableError,
}));
/** Abandon's owner probe when nothing listens at the run's endpoint. */
export function noOwnerAnswers(): Promise<never> {
  return Promise.reject(new RealDetachedRunOwnerUnavailableError('run-1', 'ENOENT', 'unreachable'));
}

/** Whether a sub-run's root owner answers; cancel asks when the sub-run's own is silent. */
export const mockIsRunOwnerAnswering = mock((_runId: string) => Promise.resolve(false));
mock.module('@archon/core/services/run-live-owner', () => ({
  startRunLiveOwner: mockStartRunLiveOwner,
  // The CLI never executes the run it cancels: cancel is a separate process.
  isRunOwnedByThisProcess: () => false,
  isRunOwnerAnswering: mockIsRunOwnerAnswering,
}));

mock.module('@archon/core/services/cleanup/run-worktree', () => ({
  reclaimRunWorktree: async () => ({ warnings: [] }),
  assessCompletedRunWorktree: mock(),
  releaseCompletedRunWorktree: mock(),
}));
mock.module('@archon/core/services/cleanup/containers', () => ({
  reclaimContainerEnv: mockReclaimContainerEnv,
  listContainerEnvironments: mock(),
  reapContainerEnvironments: mock(),
}));

// The waiter itself is proven in @archon/core and against a real detached run in
// workflow-wait.integration.spec.ts. Here the command's OWN responsibilities are
// under test: prefix resolution, both output modes, and the exit code per outcome.
export const mockWaitForRunAttention = mock(
  (
    _store: import('@archon/workflows/store').IWorkflowStore,
    _runId: string,
    _opts?: {
      onAttached?: (
        observedStatus: string,
        ownerLiveness?: import('@archon/core/services/run-attention-watch').UnknownOwnerLiveness
      ) => void | Promise<void>;
    }
  ): Promise<unknown> => Promise.resolve({ kind: 'not_found', runId: 'unset' })
);
const realRunAttentionWatch = await import('@archon/core/services/run-attention-watch');
mock.module('@archon/core/services/run-attention-watch', () => ({
  ...realRunAttentionWatch,
  waitForRunAttention: mockWaitForRunAttention,
}));
