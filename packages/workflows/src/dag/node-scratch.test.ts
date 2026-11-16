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

// Stands in for the run's container: `docker exec` runs its command here, and the
// arguments are recorded. Captured before mocking, as `rm` is above.
const dockerCalls: string[][] = [];
const realGit = await import('@archon/git');
const realExecFileAsync = realGit.execFileAsync;
mock.module('@archon/git', () => ({
  ...realGit,
  execFileAsync: async (
    cmd: string,
    args: string[],
    options?: Parameters<typeof realExecFileAsync>[2]
  ) => {
    if (cmd !== 'docker') return realExecFileAsync(cmd, args, options);
    dockerCalls.push(args);
    // `exec -w <cwd> [-i] [-u <user>] [-e K=V]... <container> <cmd> <args...>`
    const cwd = args[2];
    let i = 3;
    while (args[i]?.startsWith('-')) i += args[i] === '-i' ? 1 : 2;
    return realExecFileAsync(args[i + 1], args.slice(i + 2), { ...options, cwd });
  },
}));

import { existsSync } from 'fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  getNodeScratchDir,
  getNodeScratchRoot,
  getRunScratchDir,
} from '@archon/paths/archon-paths';
import { nodeInvocationKey } from '../node-record-reader';
import { releaseNodeScratch } from '../run-scratch';
import type { NodeExecutionMetadata } from '../schemas/node-execution';
import { createEscalationStore } from './pause-test-utils';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  mockLogger,
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
    dockerCalls.length = 0;
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
    // dependent runs, and scratch the workflow keeps under the same parent is not.
    await mkdir(join(nodes, 'shared'));
    await writeFile(join(nodes, 'shared', 'marker'), 'kept');
    store = createEscalationStore(runId);
    await run({ priorCompletedNodes: new Map([['check', { output: 'approve', execution }]]) }, [
      gate(),
      exec(
        'after',
        `cat "${nodes}/shared/marker" > "$ARTIFACTS_DIR/marker.txt"; ls "${nodes}" > "$ARTIFACTS_DIR/after.txt"`,
        ['check']
      ),
    ]);
    expect(await readFile(join(artifactsDir, 'marker.txt'), 'utf8')).toBe('kept');
    const seen = (await readFile(join(artifactsDir, 'after.txt'), 'utf8')).trim().split('\n');
    // `shared` and the running dependent's own directory.
    expect(seen).toHaveLength(2);
    expect(seen).toContain('shared');
    expect(seen).not.toContain(invocationId);
  });

  it('releases a suspended gate scratch, worktree included, when a resume skips the gate', async () => {
    const repo = await initRepo(join(testDir, 'repo'));
    const runId = 'node-scratch-gate-skip';
    const decision = join(testDir, 'decision');
    await writeFile(decision, 'go');
    const nodesFor = (): DagNode[] => [
      exec('prod', `cat "${decision}"`),
      { ...gate(), when: "$prod.output == 'go'", depends_on: ['prod'] } as DagNode,
    ];
    let store = createEscalationStore(runId);
    const run = (options: Partial<Parameters<typeof dagOptions>[0]>) =>
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: repo,
          artifactsDir,
          workflow: { name: 'node-scratch-gate-skip', nodes: nodesFor() },
          workflowRun: makeWorkflowRun(runId),
          ...options,
        })
      );
    await run({});
    expect(store.getState().status).toBe('paused');
    const execution = persistedEvents(store).find(
      event => event.event_type === 'node_suspended' && event.step_name === 'check'
    )?.data as unknown as NodeExecutionMetadata;
    const gateScratch = join(getNodeScratchRoot(artifactsDir), execution.invocation.id);
    git(repo, 'worktree', 'add', '-q', '--detach', join(gateScratch, 'wt'), 'HEAD');
    await writeFile(join(gateScratch, 'wt', 'bulk'), Buffer.alloc(4 * 1024 * 1024));

    // The producer re-runs on resume and turns the gate's condition false.
    await writeFile(decision, 'stop');
    store = createEscalationStore(runId);
    store.getDagResumeSnapshot.mockImplementation(async () => ({
      ...(await createMockDeps().store.getDagResumeSnapshot(runId)),
      unfinishedInvocations: new Map([[nodeInvocationKey('check', []), execution]]),
    }));
    await run({ priorCompletedNodes: new Map() });
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_skipped' && event.step_name === 'check'
      )
    ).toBe(true);
    expect(existsSync(gateScratch)).toBe(false);
    expect(worktreePaths(repo)).toHaveLength(1);
  });

  it('releases the scratch of a node whose dispatch throws', async () => {
    const store = createMockDeps().store;
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        artifactsDir,
        // No base branch: substituting $BASE_BRANCH throws inside the node's dispatch.
        baseBranch: '',
        workflow: {
          name: 'node-scratch-dispatch-throws',
          nodes: [exec('work', 'echo $BASE_BRANCH')],
        },
        workflowRun: makeWorkflowRun('node-scratch-dispatch-throws'),
      })
    );
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_failed' && event.step_name === 'work'
      )
    ).toBe(true);
    expect(await readdir(getNodeScratchRoot(artifactsDir))).toEqual([]);
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
    // Every level shares one spy in test-utils, so warnings get their own here.
    const warn = mock((_data: unknown, _message?: string): void => undefined);
    const sharedWarn = mockLogger.warn;
    mockLogger.warn = warn;
    try {
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
    } finally {
      mockLogger.warn = sharedWarn;
    }
    const events = persistedEvents(store);
    const work = events.find(
      event => event.event_type === 'node_completed' && event.step_name === 'work'
    )?.data as unknown as NodeExecutionMetadata;
    const invocationId = work.invocation.id;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'work',
        invocationId,
        path: getNodeScratchDir(artifactsDir, invocationId),
      }),
      'node_scratch.remove_failed'
    );
    expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
    expect(await readFile(join(artifactsDir, 'after.txt'), 'utf8')).toBe('ran\n');
    // Left for run-end release.
    expect(await readdir(getNodeScratchRoot(artifactsDir))).toHaveLength(2);
  });

  it('deregisters only the node scratch worktrees, by path, never pruning', async () => {
    const repo = await initRepo(join(testDir, 'repo'));
    const own = getNodeScratchDir(artifactsDir, 'own');
    const other = getNodeScratchDir(artifactsDir, 'other');
    const sibling = join(testDir, 'sibling');
    // A registration whose checkout is gone: `git worktree prune` would drop it.
    const missing = join(testDir, 'missing');
    for (const path of [join(own, 'wt'), join(other, 'wt'), sibling, missing]) {
      git(repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    }
    await removeTempTree(missing);

    await releaseNodeScratch({
      artifactsDir,
      invocationId: 'own',
      repoPath: repo,
      execContext: { kind: 'host' },
      logContext: {},
    });
    expect(existsSync(own)).toBe(false);
    expect(worktreePaths(repo)).toHaveLength(4);
    for (const path of [join(other, 'wt'), sibling, missing]) {
      expect(worktreePaths(repo).some(line => line.endsWith(path))).toBe(true);
    }
  });

  it("deregisters a container node's worktrees through the container's git", async () => {
    const repo = await initRepo(join(testDir, 'repo'));
    git(repo, 'branch', 'probe');
    const first = getNodeScratchDir(artifactsDir, 'first');
    git(repo, 'worktree', 'add', '-q', join(first, 'wt'), 'probe');

    await releaseNodeScratch({
      artifactsDir,
      invocationId: 'first',
      repoPath: repo,
      execContext: { kind: 'container', containerId: 'run-container' },
      logContext: {},
    });
    expect(existsSync(first)).toBe(false);
    expect(dockerCalls.some(args => args.includes('remove') && args.at(-1)?.endsWith('wt'))).toBe(
      true
    );
    // The next node can check out the branch the released one had.
    git(
      repo,
      'worktree',
      'add',
      '-q',
      join(getNodeScratchDir(artifactsDir, 'next'), 'wt'),
      'probe'
    );
  });

  it('releases the scratch of body nodes a resume leaves behind by skipping their suspended loop_group', async () => {
    const repo = await initRepo(join(testDir, 'repo'));
    const runId = 'node-scratch-group-skip';
    const decision = join(testDir, 'decision');
    await writeFile(decision, 'go');
    const nodesFor = (): DagNode[] => [
      exec('prod', `cat "${decision}"`),
      dagNodeSchema.parse({
        id: 'grp',
        depends_on: ['prod'],
        when: "$prod.output == 'go'",
        loop_group: {
          max_iterations: 2,
          until_bash: 'false',
          nodes: [
            {
              id: 'check',
              approval: { message: 'Continue?', decisions: [{ id: 'approve' }] },
            },
          ],
        },
      }) as DagNode,
    ];
    let store = createEscalationStore(runId);
    const run = (options: Partial<Parameters<typeof dagOptions>[0]>) =>
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: repo,
          artifactsDir,
          workflow: { name: 'node-scratch-group-skip', nodes: nodesFor() },
          workflowRun: makeWorkflowRun(runId),
          ...options,
        })
      );
    await run({});
    expect(store.getState().status).toBe('paused');
    const suspended = persistedEvents(store)
      .filter(event => event.event_type === 'node_suspended')
      .map(event => ({
        ...(event.data as unknown as NodeExecutionMetadata),
        path: event.step_name ?? '',
      }));
    const body = suspended.find(execution => execution.path === 'grp.check');
    if (!body) throw new Error('grp.check did not suspend');
    const bodyScratch = getNodeScratchDir(artifactsDir, body.invocation.id);
    git(repo, 'worktree', 'add', '-q', '--detach', join(bodyScratch, 'wt'), 'HEAD');
    await writeFile(join(bodyScratch, 'wt', 'bulk'), Buffer.alloc(4 * 1024 * 1024));
    // Suspended elsewhere in the run, under a group whose path shares a prefix: kept.
    const unrelated = {
      ...body,
      path: 'grp2.check',
      invocation: {
        ...body.invocation,
        id: 'unrelated',
        loopPath: [{ groupId: 'grp2', iteration: 1 }],
      },
    };
    const unrelatedScratch = getNodeScratchDir(artifactsDir, 'unrelated');
    await mkdir(unrelatedScratch, { recursive: true });

    await writeFile(decision, 'stop');
    store = createEscalationStore(runId);
    store.getDagResumeSnapshot.mockImplementation(async () => ({
      ...(await createMockDeps().store.getDagResumeSnapshot(runId)),
      unfinishedInvocations: new Map(
        [...suspended, unrelated].map(execution => [
          nodeInvocationKey(execution.path, execution.invocation.loopPath),
          execution,
        ])
      ),
    }));
    await run({ priorCompletedNodes: new Map() });
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_skipped' && event.step_name === 'grp'
      )
    ).toBe(true);
    expect(existsSync(bodyScratch)).toBe(false);
    expect(worktreePaths(repo)).toHaveLength(1);
    expect(existsSync(unrelatedScratch)).toBe(true);
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
        execContext: { kind: 'host' },
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
