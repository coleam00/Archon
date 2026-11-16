// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// Removal of node scratch fails while `failNodeScratchRemoval` is set. A permission
// change cannot do this: root's rm ignores it.
let failNodeScratchRemoval = false;
const realFs = await import('node:fs/promises');
// Captured before mocking: the namespace's binding is replaced by the mock below.
const realRm = realFs.rm;
mock.module('node:fs/promises', () => ({
  ...realFs,
  rm: async (path: Parameters<typeof realFs.rm>[0], options?: Parameters<typeof realFs.rm>[1]) => {
    if (failNodeScratchRemoval && String(path).includes(join('scratch', 'nodes'))) {
      throw Object.assign(new Error('injected removal failure'), { code: 'EBUSY' });
    }
    return realRm(path, options);
  },
}));

import { existsSync } from 'fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { getNodeScratchRoot, getRunScratchDir } from '@archon/paths/archon-paths';
import { nodeInvocationKey } from '../node-record-reader';
import { releaseNodeScratch } from '../run-scratch';
import type { NodeExecutionMetadata } from '../schemas/node-execution';
import { createEscalationStore } from './pause-test-utils';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { dagNodeSchema, type DagNode } from '../schemas';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function initRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q');
  git(
    path,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  return path;
}

function worktreePaths(repo: string): string[] {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter(line => line.startsWith('worktree '));
}

function exec(id: string, script: string, dependsOn: string[] = []): DagNode {
  return { id, kind: 'exec', runtime: 'sh', script, depends_on: dependsOn } as DagNode;
}

const gate = (): DagNode =>
  dagNodeSchema.parse({
    id: 'check',
    approval: { message: 'Review?', decisions: [{ id: 'approve' }, { id: 'reject' }] },
  }) as DagNode;

describe('executeDagWorkflow -- node scratch', () => {
  let testDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-node-scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    artifactsDir = join(testDir, 'artifacts');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    failNodeScratchRemoval = false;
    await removeTempTree(testDir);
  });

  it('releases each loop_group iteration body scratch, worktree included, as the node ends', async () => {
    const repo = await initRepo(join(testDir, 'repo'));
    const counter = join(testDir, 'counter').replace(/\\/g, '/');
    const nodesDir = join(getRunScratchDir(artifactsDir), 'nodes').replace(/\\/g, '/');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-node-scratch',
        cwd: repo,
        artifactsDir,
        workflow: {
          name: 'node-scratch-loop',
          nodes: [
            {
              id: 'rounds',
              kind: 'loop_group',
              loop_group: {
                until_bash: 'false',
                max_iterations: 3,
                fresh_context: false,
                nodes: [
                  {
                    id: 'work',
                    kind: 'exec',
                    runtime: 'sh',
                    // Records what this iteration sees, adds a worktree and a 4 MB file to
                    // its own scratch, leaves a marker in run-wide scratch on the first
                    // pass, and fails on the third after making its worktree.
                    script: [
                      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
                      `wt=$(git worktree list --porcelain | grep -c '^worktree ')`,
                      `dirs=$(ls "${nodesDir}" | wc -l | tr -d ' ')`,
                      `echo "$wt $dirs" > "$ARTIFACTS_DIR/iter-$n.txt"`,
                      `git worktree add -q --detach "$NODE_SCRATCH_DIR/wt" HEAD`,
                      `dd if=/dev/zero of="$NODE_SCRATCH_DIR/wt/big" bs=1048576 count=4 2>/dev/null`,
                      `[ $n -ne 1 ] || { mkdir -p "$ARTIFACTS_DIR/.archon/scratch/shared"; echo kept > "$ARTIFACTS_DIR/.archon/scratch/shared/marker"; }`,
                      `[ $n -lt 3 ] || exit 5`,
                      'echo done',
                    ].join('\n'),
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('node-scratch-loop'),
      })
    );

    // Every iteration saw only the main checkout and two scratch directories, the
    // loop_group's own and its own: the previous iteration's worktree and files were gone.
    for (const n of [1, 2, 3]) {
      expect((await readFile(join(artifactsDir, `iter-${n}.txt`), 'utf8')).trim()).toBe('1 2');
    }
    const worktrees = git(repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter(line => line.startsWith('worktree '));
    expect(worktrees).toHaveLength(1);
    // The failed third iteration left nothing either.
    expect(await readdir(join(getRunScratchDir(artifactsDir), 'nodes'))).toEqual([]);
    // Run-wide scratch is not node scratch: it stays until the run is released.
    expect(await readFile(join(getRunScratchDir(artifactsDir), 'shared', 'marker'), 'utf8')).toBe(
      'kept\n'
    );
  });

  it('keeps a suspended gate scratch, hands the resumed gate the same directory, and releases it once answered', async () => {
    const runId = 'node-scratch-gate';
    let store = createEscalationStore(runId);
    const run = (options: Partial<Parameters<typeof dagOptions>[0]>, nodes: DagNode[]) =>
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          artifactsDir,
          workflow: { name: 'node-scratch-gate', nodes },
          workflowRun: makeWorkflowRun(runId),
          ...options,
        })
      );
    await run({}, [gate()]);

    expect(store.getState().status).toBe('paused');
    const suspended = persistedEvents(store).find(
      event => event.event_type === 'node_suspended' && event.step_name === 'check'
    );
    const execution = suspended?.data as unknown as NodeExecutionMetadata;
    const invocationId = execution.invocation.id;
    const nodes = getNodeScratchRoot(artifactsDir);
    expect(await readdir(nodes)).toEqual([invocationId]);
    await writeFile(join(nodes, invocationId, 'rework'), Buffer.alloc(4 * 1024 * 1024));

    // Resumed while still unanswered: the gate reuses its invocation and its scratch.
    // A fresh store is a run back in `running`, as a resume finds it.
    store = createEscalationStore(runId);
    store.getDagResumeSnapshot.mockImplementation(async () => ({
      ...(await createMockDeps().store.getDagResumeSnapshot(runId)),
      unfinishedInvocations: new Map([[nodeInvocationKey('check', []), execution]]),
    }));
    await run({ priorCompletedNodes: new Map() }, [gate()]);
    expect(store.getState().status).toBe('paused');
    const restarted = persistedEvents(store).find(
      event => event.event_type === 'node_started' && event.step_name === 'check'
    );
    expect((restarted?.data as unknown as NodeExecutionMetadata).invocation.id).toBe(invocationId);
    expect(existsSync(join(nodes, invocationId, 'rework'))).toBe(true);

    // Resumed after approval recorded the gate completed: its scratch is gone before a
    // dependent runs.
    store = createEscalationStore(runId);
    await run({ priorCompletedNodes: new Map([['check', { output: 'approve' }]]) }, [
      gate(),
      exec('after', `ls "${nodes}" > "$ARTIFACTS_DIR/after.txt"`, ['check']),
    ]);
    const seen = (await readFile(join(artifactsDir, 'after.txt'), 'utf8')).trim().split('\n');
    expect(seen).toHaveLength(1);
    expect(seen).not.toContain(invocationId);
  });

  it('deregisters only the ending node worktrees, not a running sibling', async () => {
    const repo = await initRepo(join(testDir, 'repo'));
    // `slow` sleeps well past `fast`'s end and release, then checks its own worktree.
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: repo,
        artifactsDir,
        workflow: {
          name: 'node-scratch-siblings',
          nodes: [
            exec('fast', 'git worktree add -q --detach "$NODE_SCRATCH_DIR/wt" HEAD'),
            exec(
              'slow',
              [
                'git worktree add -q --detach "$NODE_SCRATCH_DIR/wt" HEAD',
                'sleep 3',
                'n=$(git worktree list --porcelain | grep -c "^worktree ")',
                '[ -e "$NODE_SCRATCH_DIR/wt/.git" ] && f=present || f=missing',
                'echo "$n $f" > "$ARTIFACTS_DIR/slow.txt"',
              ].join('\n')
            ),
          ],
        },
        workflowRun: makeWorkflowRun('node-scratch-siblings'),
      })
    );
    expect((await readFile(join(artifactsDir, 'slow.txt'), 'utf8')).trim()).toBe('2 present');
    expect(worktreePaths(repo)).toHaveLength(1);
  });

  it('logs a failed release and keeps the node completed', async () => {
    failNodeScratchRemoval = true;
    const store = createMockDeps().store;
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        artifactsDir,
        workflow: {
          name: 'node-scratch-release-fails',
          nodes: [
            exec('work', 'echo bulk > "$NODE_SCRATCH_DIR/file"'),
            exec('after', 'echo ran > "$ARTIFACTS_DIR/after.txt"', ['work']),
          ],
        },
        workflowRun: makeWorkflowRun('node-scratch-release-fails'),
      })
    );
    const events = persistedEvents(store);
    expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
    expect(await readFile(join(artifactsDir, 'after.txt'), 'utf8')).toBe('ran\n');
    // Left for run-end release.
    expect(await readdir(getNodeScratchRoot(artifactsDir))).toHaveLength(2);
  });

  for (const linked of ['scratch', 'nodes'] as const) {
    it(`touches nothing outside the run when ${linked} is a link`, async () => {
      const repo = await initRepo(join(testDir, 'repo'));
      const outside = join(testDir, 'outside');
      await mkdir(outside);
      const link =
        linked === 'scratch' ? getRunScratchDir(artifactsDir) : getNodeScratchRoot(artifactsDir);
      await mkdir(join(link, '..'), { recursive: true });
      await symlink(outside, link);
      const victimDir = linked === 'scratch' ? join(outside, 'nodes') : outside;
      git(repo, 'worktree', 'add', '-q', '--detach', join(victimDir, 'victim'), 'HEAD');
      await writeFile(join(victimDir, 'victim', 'uncommitted'), 'keep');

      await releaseNodeScratch({
        artifactsDir,
        invocationId: 'victim',
        repoPath: repo,
        container: false,
        logContext: {},
      });
      expect(existsSync(join(victimDir, 'victim', 'uncommitted'))).toBe(true);
      expect(worktreePaths(repo)).toHaveLength(2);

      // A node is not handed a directory through the link either.
      const store = createMockDeps().store;
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: repo,
          artifactsDir,
          workflow: { name: 'node-scratch-linked', nodes: [exec('work', 'echo ran')] },
          workflowRun: makeWorkflowRun('node-scratch-linked'),
        })
      );
      expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(true);
    });
  }
});
