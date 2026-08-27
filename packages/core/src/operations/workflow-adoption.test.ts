/**
 * Tests for between-run continuation adoption resolution (#2747).
 *
 * The resolver's whole contract is fail-loud: every refusal names the operator's
 * next action and NONE of them degrade to a fresh start. The database boundary
 * is mocked and the filesystem/git seams are injected; the lane decision logic
 * is what is under test.
 */
import { describe, expect, test } from 'bun:test';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { resolveWorkflowAdoption, WorkflowAdoptionError } from './workflow-adoption';

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    workflow_name: 'implement',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1' as string | null,
    status: 'failed',
    outcome: 'failed',
    user_message: '',
    metadata: {},
    started_at: new Date(),
    completed_at: new Date(),
    last_activity_at: new Date(),
    working_path: '/ws/repo/.worktrees/run-1' as string | null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: '/root/artifacts',
    ...overrides,
  };
}

// Injection seam defaults: only the reused worktree "exists on disk" and only
// 'alive-branch' verifies in the fake git.
const baseArgs = {
  codebaseId: 'cb-1',
  codebasePath: '/ws/repo',
  codebaseKind: 'repo' as const,
};

function envRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'task',
    workflow_id: 'run-1',
    provider: 'worktree',
    working_path: '/ws/repo/.worktrees/run-1',
    branch_name: 'impl-branch',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'cli',
    metadata: {},
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    run?: Record<string, unknown> | null;
    activeHolder?: Record<string, unknown> | null;
    environment?: Record<string, unknown> | null;
  } = {}
) {
  return {
    existsSync: (p: string) => p === '/ws/repo/.worktrees/run-1',
    branchExists: async (_repo: string, branch: string) => branch === 'alive-branch',
    currentBranch: async (): Promise<string | null> => 'impl-branch',
    getRun: async () => ('run' in overrides ? overrides.run : null),
    getActiveRunByPath: async () => overrides.activeHolder ?? null,
    findEnvironmentByPath: async () => overrides.environment ?? null,
  };
}

describe('resolveWorkflowAdoption', () => {
  test('refuses an unknown run, naming the id', async () => {
    await expect(
      resolveWorkflowAdoption({ ...baseArgs, adoptedRunId: 'nope', deps: makeDeps() })
    ).rejects.toThrow(/no workflow run 'nope' exists/);
  });

  test('refuses a live run with a respond/resume/abandon pointer', async () => {
    const deps = makeDeps({ run: runRow({ id: 'live', status: 'running', completed_at: null }) });
    const err = await resolveWorkflowAdoption({
      ...baseArgs,
      adoptedRunId: 'live',
      deps,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowAdoptionError);
    expect((err as Error).message).toMatch(/still running/);
    expect((err as Error).message).toMatch(/abandon/);
  });

  test('refuses a cross-codebase adoption', async () => {
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        codebaseId: 'cb-other',
        deps: makeDeps({ run: runRow() }),
      })
    ).rejects.toThrow(/different project/);
  });

  test('refuses adoption when either codebase identity is missing', async () => {
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        codebaseId: null,
        deps: makeDeps({ run: runRow() }),
      })
    ).rejects.toThrow(/different project/);
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: makeDeps({ run: runRow({ codebase_id: null }) }),
      })
    ).rejects.toThrow(/different project/);
  });

  test('refuses container-backed runs in v1', async () => {
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        containerRequested: true,
        deps: makeDeps({ run: runRow() }),
      })
    ).rejects.toThrow(/Container-backend runs cannot adopt/);
  });

  test('reuses the live worktree when it still exists on disk', async () => {
    const lane = (
      await resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: makeDeps({ run: runRow(), environment: envRow() }),
      })
    ).lane;
    expect(lane).toEqual({
      kind: 'reuse-worktree',
      workingPath: '/ws/repo/.worktrees/run-1',
      envId: 'env-1',
    });
  });

  test('refuses a surviving worktree that moved off its recorded branch', async () => {
    const inspectedPaths: string[] = [];
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: {
          ...makeDeps({ run: runRow(), environment: envRow() }),
          currentBranch: async (path): Promise<string | null> => {
            inspectedPaths.push(path);
            return path === '/ws/repo/.worktrees/run-1' ? 'other-branch' : 'impl-branch';
          },
        },
      })
    ).rejects.toThrow(/recorded on branch 'impl-branch' but is now on 'other-branch'/);
    expect(inspectedPaths).toEqual(['/ws/repo/.worktrees/run-1']);
  });

  test('refuses a surviving worktree at detached HEAD', async () => {
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: {
          ...makeDeps({ run: runRow(), environment: envRow() }),
          currentBranch: async (): Promise<string | null> => null,
        },
      })
    ).rejects.toThrow(/detached HEAD/);
  });

  test('preserves an unexpected branch-inspection failure', async () => {
    await expect(
      resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: {
          ...makeDeps({ run: runRow(), environment: envRow() }),
          currentBranch: async (): Promise<string | null> => {
            throw new Error('git probe timed out');
          },
        },
      })
    ).rejects.toThrow(/git probe timed out/);
  });

  test('refuses reuse when another LIVE run holds the same path', async () => {
    const err = await resolveWorkflowAdoption({
      ...baseArgs,
      adoptedRunId: 'run-1',
      deps: makeDeps({
        run: runRow(),
        environment: envRow(),
        activeHolder: runRow({ id: 'other-run', status: 'running' }),
      }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowAdoptionError);
    expect((err as Error).message).toMatch(/held by live run 'other-run'/);
  });

  test('checks out the adopted branch when the worktree is gone', async () => {
    // Worktree deleted: env row destroyed AND nothing on disk. The branch survives.
    const lane = (
      await resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: makeDeps({
          run: runRow({ working_path: '/ws/repo/.worktrees/vanished' }),
          environment: envRow({
            id: 'env-gone',
            working_path: '/ws/repo/.worktrees/vanished',
            branch_name: 'alive-branch',
            status: 'destroyed',
          }),
        }),
      })
    ).lane;
    expect(lane).toEqual({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: 'alive-branch' },
    });
  });

  test("bounds estate history by the adopted run's start time", async () => {
    const startedAt = new Date('2026-08-25T09:00:00.000Z');
    const completedAt = new Date('2026-08-25T12:00:00.000Z');
    const lookupCalls: Array<{ codebaseId: string; workingPath: string; cutoff: Date }> = [];
    const lane = (
      await resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        deps: {
          ...makeDeps({
            run: runRow({
              working_path: '/ws/repo/.worktrees/vanished',
              started_at: startedAt,
              completed_at: completedAt,
            }),
          }),
          findEnvironmentByPath: async (codebaseId, workingPath, cutoff) => {
            lookupCalls.push({ codebaseId, workingPath, cutoff });
            return envRow({
              working_path: workingPath,
              branch_name:
                cutoff.getTime() === startedAt.getTime() ? 'alive-branch' : 'later-branch',
              status: 'destroyed',
            }) as IsolationEnvironmentRow;
          },
        },
      })
    ).lane;

    expect(lookupCalls).toEqual([
      {
        codebaseId: 'cb-1',
        workingPath: '/ws/repo/.worktrees/vanished',
        cutoff: startedAt,
      },
    ]);
    expect(lane).toEqual({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: 'alive-branch' },
    });
  });

  test('refuses when neither worktree nor branch survives', async () => {
    const err = await resolveWorkflowAdoption({
      ...baseArgs,
      adoptedRunId: 'run-1',
      deps: makeDeps({
        run: runRow({ working_path: '/ws/repo/.worktrees/vanished' }),
        environment: envRow({
          id: 'env-gone',
          working_path: '/ws/repo/.worktrees/vanished',
          branch_name: 'deleted-branch',
          status: 'destroyed',
        }),
      }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowAdoptionError);
    expect((err as Error).message).toMatch(/neither its worktree nor its branch 'deleted-branch'/);
  });

  test('folder projects adopt provenance-only, no lane', async () => {
    const lane = (
      await resolveWorkflowAdoption({
        ...baseArgs,
        adoptedRunId: 'run-1',
        codebaseKind: 'folder',
        deps: makeDeps({ run: runRow() }),
      })
    ).lane;
    expect(lane).toEqual({ kind: 'in-place' });
  });
});
