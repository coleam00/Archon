// @archon-test-isolated
import { describe, expect, mock, test } from 'bun:test';
import { hostname } from 'node:os';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  PauseRefusedError,
  createWorkflowOperations,
  isolationStore,
  makePausedRun,
  mockRequestDetachedRunStop,
  store,
} from './test-harness';

const requested = {
  requested: { at: '2026-01-01T00:00:00.000Z', via: 'cli', by: null, fromRun: null },
};

function setup(run: WorkflowRun, owner: { owned?: boolean; answering?: boolean } = {}) {
  const write = mock<IWorkflowStore['updateWorkflowRunMetadataIfRunning']>(async () => true);
  const operations = createWorkflowOperations({
    getUserRole: async () => undefined,
    store: {
      ...store,
      getWorkflowRun: async () => run,
      getRunAncestry: async () => [],
      updateWorkflowRunMetadataIfRunning: write,
    },
    hostStore: { isolation: isolationStore },
    requestDetachedRunStop: mockRequestDetachedRunStop,
    isRunOwnedByThisProcess: () => owner.owned ?? false,
    isRunOwnerAnswering: async () => owner.answering ?? false,
    reclaimRunWorktree: async () => ({ warnings: [] }),
    reclaimContainerEnv: async () => undefined,
  });
  return { operations, write };
}

function running(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return makePausedRun({ status: 'running', metadata: {}, ...overrides });
}

async function refusal(run: WorkflowRun, owner = { owned: true }) {
  const { operations, write } = setup(run, owner);
  const error: unknown = await operations
    .pauseWorkflow(run.id, { kind: 'operator' }, 'cli')
    .catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(PauseRefusedError);
  expect(write).not.toHaveBeenCalled();
  return error as InstanceType<typeof PauseRefusedError>;
}

describe('pauseWorkflow', () => {
  test('records who asked on a running run whose owner answers', async () => {
    const run = running();
    const { operations, write } = setup(run, { answering: true });

    const result = await operations.pauseWorkflow(
      run.id,
      { kind: 'operator', declared: 'ops' },
      'cli'
    );

    expect(result.alreadyRequested).toBe(false);
    expect(result.requested).toMatchObject({ via: 'cli', by: { declared: 'ops' } });
    expect(write).toHaveBeenCalledWith(run.id, {
      operator_pause: { requested: result.requested },
    });
  });

  test('a pending request is reported, not written again', async () => {
    const run = running({ metadata: { operator_pause: requested } });
    const { operations, write } = setup(run, { owned: true });

    const result = await operations.pauseWorkflow(run.id, { kind: 'operator' }, 'cli');

    expect(result).toMatchObject({ alreadyRequested: true, requested: requested.requested });
    expect(write).not.toHaveBeenCalled();
  });

  test.each([
    ['paused at a gate', makePausedRun()],
    [
      'already paused by an operator',
      makePausedRun({
        metadata: {
          pause_cause: 'operator',
          operator_pause: { ...requested, pausedAt: '2026-01-01T00:01:00.000Z' },
        },
      }),
    ],
    ...(['pending', 'completed', 'failed', 'cancelled'] satisfies WorkflowRunStatus[]).map(
      status => [status, makePausedRun({ status, metadata: {} })] as const
    ),
  ])('refuses a run %s', async (_label, run) => {
    expect((await refusal(run)).reason).toBe('not_running');
  });

  test('refuses a sub-run', async () => {
    expect((await refusal(running({ parent_run_id: 'root' }))).reason).toBe('sub_run');
  });

  test('refuses a run whose owner does not answer, unchanged', async () => {
    const run = running({
      metadata: { execution_owner: { host: hostname(), pid: 1 } },
    });
    expect((await refusal(run, { owned: false })).reason).toBe('no_owner_answered');
  });

  test('refuses a pending request whose owner has since gone', async () => {
    const run = running({
      metadata: { operator_pause: requested, execution_owner: { host: hostname(), pid: 1 } },
    });
    expect((await refusal(run, { owned: false })).reason).toBe('no_owner_answered');
  });

  test('refuses a run whose recorded owner is on another host', async () => {
    const run = running({
      metadata: { execution_owner: { host: `${hostname()}-elsewhere`, pid: 1 } },
    });
    expect((await refusal(run, { owned: false })).reason).toBe('owner_unreachable');
  });
});
