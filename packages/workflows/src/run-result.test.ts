import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readCheckoutMark } from './checkout-mark';
import {
  latestResultsOnItem,
  observeReturnsCheckout,
  sampleResultCommit,
  type ReturnsCheckout,
} from './run-result';
import type { WorkflowItem, WorkflowRun } from './schemas/workflow-run';

const item: WorkflowItem = { id: 'item-row', projectKey: 'acme/web', key: 'issue-7' };

const older: WorkflowRun = {
  origin: null,
  id: 'older-build',
  workflow_name: 'build',
  conversation_id: null,
  parent_conversation_id: null,
  codebase_id: null,
  status: 'completed',
  outcome: null,
  completed_outcome: null,
  user_message: '',
  metadata: {},
  active_phase_started_at: null,
  started_at: new Date('2026-11-01T10:00:00.000Z'),
  completed_at: new Date('2026-11-01T10:05:00.000Z'),
  last_activity_at: null,
  working_path: null,
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
  item_id: item.id,
};

test('an unreadable item run fails the read instead of yielding an older run as the latest', async () => {
  let eventsRead = false;
  const read = latestResultsOnItem(
    {
      getItemRuns: async () => ({
        item,
        runs: [older, { type: 'degraded', reason: 'run_unreadable', runId: 'lost-run' }],
        descendantIds: [],
      }),
      listEventsForRuns: async () => {
        eventsRead = true;
        return new Map();
      },
    },
    item,
    new Map([['build', { workflow: 'build' }]])
  );
  await expect(read).rejects.toThrow('item runs lost-run did not read');
  expect(eventsRead).toBe(false);
});

test('a reader whose checkout is at no commit reads no result, even from a run that holds at none', async () => {
  // `older` has no terminal record, so it holds at no commit, as runs recorded before #5769 do.
  const read = await latestResultsOnItem(
    {
      getItemRuns: async () => ({ item, runs: [older], descendantIds: [] }),
      listEventsForRuns: async () => new Map(),
    },
    item,
    new Map([['approval', { workflow: 'build', at: { commit: null } }]])
  );
  expect(read.get('approval')).toEqual({
    runId: null,
    result: { kind: 'none', reason: "this run's checkout is at no commit" },
    latest: { runId: 'older-build', holdsAt: undefined },
  });
});

const trackTempRoot = trackTempRoots();
const host = { kind: 'host' } as const;

const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)
  )
);

/** A scratch repository with commit X. */
function scratchRepo(): { cwd: string; git: (...args: string[]) => string } {
  const cwd = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-result-commit-'))));
  const git = (...args: string[]): string => {
    const run = Bun.spawnSync(
      [
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      // An inherited GIT_DIR would point every command at another repository.
      { cwd, env: gitEnv }
    );
    if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'X');
  return { cwd, git };
}

/**
 * Another process moves the checkout from X to Y while the run judges, then back to X
 * before the returns node completes: every commit sample reads X.
 */
async function resultAfterExcursion(
  mutatesCheckout: boolean,
  excursion: 'none' | 'detached' | 'unlogged-branch'
) {
  const { cwd, git } = scratchRepo();
  const x = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'Y');
  const y = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', x);
  if (excursion === 'unlogged-branch') {
    // HEAD keeps its log; the branch it is on has none.
    git('config', 'core.logAllRefUpdates', 'false');
    git('branch', 'judged', x);
    git('checkout', '-q', 'judged');
    git('worktree', 'add', '-q', '--detach', trackTempRoot(`${cwd}-other`));
  }
  const returnsCheckout: ReturnsCheckout = {
    nodeId: 'judge',
    ...(mutatesCheckout ? {} : { startMark: await readCheckoutMark(cwd, host) }),
  };
  const run = {
    cwd,
    execContext: host,
    returnsCheckout,
    workflow: { mutates_checkout: mutatesCheckout ? undefined : false },
    workflowRun: {
      checkout_baseline: {
        kind: 'git' as const,
        sampledAt: new Date().toISOString(),
        commit: x,
        tree: null,
        worktree: { status: 'clean' as const },
      },
    },
  };
  const ctx = { ...run, stepNamePrefix: '' };
  const moveAway = (): void => {
    if (excursion === 'detached') {
      git('checkout', '-q', '--detach', y);
      git('checkout', '-q', '--detach', x);
    } else if (excursion === 'unlogged-branch') {
      // Another worktree moves the branch, which writes this checkout's HEAD log not at all.
      git('-C', `${cwd}-other`, 'update-ref', 'refs/heads/judged', y);
      git('-C', `${cwd}-other`, 'update-ref', 'refs/heads/judged', x);
    }
  };
  // A run that takes no path lock is exposed from its start; one that takes the lock is
  // exposed only to a writer that ignores it, after its returns node.
  if (!mutatesCheckout) moveAway();
  await observeReturnsCheckout(ctx, 'judge', { state: 'completed' }, undefined);
  if (mutatesCheckout) moveAway();
  return { x, held: await sampleResultCommit(run, 'run-1') };
}

test('a run that takes no path lock holds at no commit when its checkout moved and came back', async () => {
  const { held } = await resultAfterExcursion(false, 'detached');
  expect(held).toEqual({ held: false, reason: 'moved' });
});

test('a run that takes no path lock holds at its commit when nothing moved', async () => {
  const { x, held } = await resultAfterExcursion(false, 'none');
  expect(held).toEqual({ held: true, commit: x });
});

test('a run holds at no commit when its checkout moved and came back after its returns node', async () => {
  const { held } = await resultAfterExcursion(true, 'detached');
  expect(held).toEqual({ held: false, reason: 'moved' });
});

test('a result holds at no commit when its branch keeps no log, before or after its returns node', async () => {
  for (const mutatesCheckout of [false, true]) {
    const { held } = await resultAfterExcursion(mutatesCheckout, 'unlogged-branch');
    expect(held).toEqual({ held: false, reason: 'unobserved' });
  }
});
