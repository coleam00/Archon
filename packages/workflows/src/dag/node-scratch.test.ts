// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readdir, readFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import { getRunScratchDir } from '@archon/paths/archon-paths';
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
    await removeTempTree(testDir);
  });

  it('releases each loop_group iteration body scratch, worktree included, as the node ends', async () => {
    const repo = join(testDir, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    git(
      repo,
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

  it('keeps a suspended invocation scratch under the invocation id it resumes with', async () => {
    const runId = 'node-scratch-gate';
    const store = createEscalationStore(runId);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        artifactsDir,
        workflow: {
          name: 'node-scratch-gate',
          nodes: [
            dagNodeSchema.parse({
              id: 'check',
              approval: { message: 'Review?', decisions: [{ id: 'approve' }, { id: 'reject' }] },
            }),
          ],
        },
        workflowRun: makeWorkflowRun(runId),
      })
    );

    expect(store.getState().status).toBe('paused');
    // The suspension record carries the invocation a resume reuses
    // (`unfinishedInvocations`), so the resumed gate is handed this same directory.
    const suspended = persistedEvents(store).find(
      event => event.event_type === 'node_suspended' && event.step_name === 'check'
    );
    const invocationId = (suspended?.data as { invocation?: { id?: string } } | undefined)
      ?.invocation?.id;
    expect(invocationId).toBeString();
    const nodes = join(getRunScratchDir(artifactsDir), 'nodes');
    expect(await readdir(nodes)).toEqual([String(invocationId)]);
  });
});
