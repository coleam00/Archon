import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { IsolationEnvironmentRow } from '@archon/isolation/types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createEndedCheckout } from './ended-checkout';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A repository with one commit and a worktree on branch `lane`. */
function fixture(): { worktree: string } {
  const root = track(realpathSync(mkdtempSync(join(tmpdir(), 'archon-ended-checkout-'))));
  const repo = join(root, 'repo');
  const worktree = join(root, 'lane');
  Bun.spawnSync(['git', 'init', '-q', '--initial-branch=main', repo]);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'a');
  git(repo, 'worktree', 'add', '-qb', 'lane', worktree);
  return { worktree };
}

function run(fields: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'ended-run',
    codebase_id: 'codebase',
    working_path: null,
    metadata: {},
    ...fields,
  } as WorkflowRun;
}

function env(fields: Partial<IsolationEnvironmentRow>): IsolationEnvironmentRow {
  return {
    provider: 'worktree',
    status: 'active',
    branch_name: 'lane',
    ...fields,
  } as IsolationEnvironmentRow;
}

const resolver = (found: IsolationEnvironmentRow | null) =>
  createEndedCheckout({ findEnvironmentByPath: async () => found });

describe('the checkout an ended run left', () => {
  test('is its worktree branch at the commit it ended on', async () => {
    const { worktree } = fixture();
    const ended = await resolver(env({ working_path: worktree }))(run({ working_path: worktree }));
    expect(ended).toEqual({
      handoff: { runId: 'ended-run', branch: 'lane', commit: git(worktree, 'rev-parse', 'HEAD') },
    });
  });

  test('a run that worked on a copy hands on the checkout it was given', async () => {
    const given = { runId: 'build', branch: 'lane', commit: 'b'.repeat(40) };
    const ended = await resolver(null)(
      run({ metadata: { checkout_handoff: { ...given, lane: 'copy' } } })
    );
    expect(ended).toEqual({ handoff: given });
  });

  test.each([
    ['a run in place', null, 'ran in place'],
    ['a removed worktree', env({ status: 'destroyed' }), 'is gone'],
  ])('%s left no branch', async (_label, found, reason) => {
    const { worktree } = fixture();
    const ended = await resolver(found)(run({ working_path: worktree }));
    expect(ended).toMatchObject({ refused: expect.stringContaining(reason) });
  });

  test('a worktree that left its branch is refused, naming where it is', async () => {
    const { worktree } = fixture();
    git(worktree, 'switch', '-q', '--detach');
    const ended = await resolver(env({ working_path: worktree }))(run({ working_path: worktree }));
    expect(ended).toMatchObject({ refused: expect.stringContaining('detached HEAD') });
  });
});
