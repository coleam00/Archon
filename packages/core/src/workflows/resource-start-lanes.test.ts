import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IsolationEnvironmentRow } from '@archon/isolation/types';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { Codebase } from '../schemas/codebase';
import type { WorkflowHost } from './host-store';
import { executionLane, handoffIsolation } from './resource-start-lanes';

const track = trackTempRoots();

const HANDOFF = { runId: 'build-run', branch: 'archon/task-build', commit: 'c'.repeat(40) };
const REPO = { kind: 'repo', name: 'acme/widgets' } as Codebase;
const workflow = (fields: Partial<ResolvedWorkflow>) =>
  ({ name: 'stage', ...fields }) as ResolvedWorkflow;

describe('the lane of a start on a handed-off checkout', () => {
  test('a read-only stage is cut at the commit, on a branch of its own', () => {
    expect(handoffIsolation(HANDOFF, workflow({ mutates_checkout: false }), REPO)).toEqual({
      isolation: { kind: 'worktree', fromBranch: HANDOFF.commit },
      lane: 'copy',
    });
  });

  test('a stage that changes its checkout continues on the branch', () => {
    expect(handoffIsolation(HANDOFF, workflow({}), REPO)).toEqual({
      isolation: { kind: 'worktree', branch: HANDOFF.branch },
      lane: 'continue',
    });
  });

  test.each([
    ['a folder project', workflow({}), { ...REPO, kind: 'folder' } as Codebase],
    ['a stage pinned in place', workflow({ worktree: { enabled: false } }), REPO],
  ])('%s is refused', (_label, target, codebase) => {
    expect(() => handoffIsolation(HANDOFF, target, codebase)).toThrow(HANDOFF.runId);
  });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe('a continue hand-off', () => {
  // The environment now registered at the source run's path is on another branch, while
  // the handed-off branch still sits at the handed-off commit.
  test('is refused when the checkout at the source path is on another branch', async () => {
    const root = track(realpathSync(mkdtempSync(join(tmpdir(), 'archon-continue-lane-'))));
    const repo = join(root, 'repo');
    const worktree = join(root, 'lane');
    Bun.spawnSync(['git', 'init', '-q', '--initial-branch=main', repo]);
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'a');
    git(repo, 'branch', 'handed');
    git(repo, 'worktree', 'add', '-qb', 'other', worktree);
    const handoff = {
      runId: 'build-run',
      branch: 'handed',
      commit: git(repo, 'rev-parse', 'HEAD'),
    };
    const env = {
      id: 'env-1',
      provider: 'worktree',
      status: 'active',
      codebase_id: 'codebase',
      working_path: worktree,
      branch_name: 'other',
      workflow_type: 'task',
      workflow_id: 'other',
      metadata: {},
    } as unknown as IsolationEnvironmentRow;
    const source = {
      id: handoff.runId,
      status: 'completed',
      codebase_id: 'codebase',
      working_path: worktree,
      started_at: new Date(),
      completed_at: new Date(),
    } as WorkflowRun;
    const host = {
      deps: {
        store: {
          getWorkflowRun: async (id: string) => (id === source.id ? source : null),
          getActiveWorkflowRunByPath: async () => null,
        },
      },
      records: {
        isolation: {
          findLatestByCodebaseAndWorkingPath: async () => env,
          getById: async () => env,
          updateMetadata: async () => undefined,
        },
      },
    } as unknown as WorkflowHost;
    const started = executionLane(host, {
      run: {
        id: 'started-run',
        workflow_name: 'build',
        user_id: null,
        metadata: { checkout_handoff: { ...handoff, lane: 'continue' } },
      },
      lane: { kind: 'worktree', branch: handoff.branch },
      codebase: { ...REPO, id: 'codebase', default_cwd: repo } as Codebase,
      cwd: repo,
      platformType: 'cli',
      setupExecutor: (async () => undefined) as never,
    });
    await expect(started).rejects.toThrow(handoff.runId);
  });
});
