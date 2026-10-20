// @archon-test-isolated
import { describe, beforeEach, afterEach, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { WorkflowStatusReadError } from '../workflow-status-read';
import { recordNodeProcessTrees } from '../subprocess';
import { executeDagWorkflow } from '../dag-executor';
import { dagNodeSchema, type WorkflowRunStatus } from '../schemas';
import {
  type MockWorkflowStore,
  createMockStore,
  dagOptions,
  createMockDeps,
  makeWorkflowRun,
} from './test-utils';

describe('executeDagWorkflow -- a run stopped while its subprocess runs', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-exec-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  // The subprocess writes `started`, then waits on a grandchild that would write `leaked`.
  // The store reports the run cancelled once `started` exists.
  async function runUntilCancelled(
    name: string,
    nodeInput: unknown
  ): Promise<{ store: MockWorkflowStore; leaked: boolean }> {
    const store = createMockStore();
    store.getWorkflowRunStatus.mockImplementation(async () =>
      existsSync(join(testDir, 'started')) ? 'cancelled' : 'running'
    );
    const trees = recordNodeProcessTrees();
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun(name),
          workflow: { name, nodes: [dagNodeSchema.parse(nodeInput)] },
        })
      );
    } finally {
      trees.release();
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
    return { store, leaked: existsSync(join(testDir, 'leaked')) };
  }

  it.skipIf(process.platform === 'win32').each(['bash', 'script', 'loop predicate'] as const)(
    'stops the %s process tree and preserves an unsupported status error',
    async kind => {
      const store = createMockStore();
      const failure = new WorkflowStatusReadError('poll', new Error('Unsupported status'));
      store.getWorkflowRunStatus.mockImplementation(async () => {
        if (existsSync(join(testDir, 'started'))) throw failure;
        return 'running';
      });
      const command = 'touch started; (sleep 2; touch leaked) & wait';
      const node =
        kind === 'bash'
          ? { id: 'hang', bash: command }
          : kind === 'script'
            ? {
                id: 'hang',
                runtime: 'bun',
                script:
                  "import { writeFileSync } from 'node:fs'; writeFileSync('started', ''); await new Promise(resolve => setTimeout(resolve, 2000)); writeFileSync('leaked', '');",
              }
            : {
                id: 'hang',
                loop: {
                  prompt: 'Work',
                  until_bash: command,
                  max_iterations: 2,
                  fresh_context: false,
                },
              };
      const trees = recordNodeProcessTrees();
      try {
        await expect(
          executeDagWorkflow(
            dagOptions({
              deps: createMockDeps(store),
              cwd: testDir,
              workflowRun: makeWorkflowRun('poll'),
              workflow: { name: 'poll', nodes: [dagNodeSchema.parse(node)] },
            })
          )
        ).rejects.toBe(failure);
      } finally {
        trees.release();
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(existsSync(join(testDir, 'started'))).toBe(true);
      expect(existsSync(join(testDir, 'leaked'))).toBe(false);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(
        store.createWorkflowEvent.mock.calls.some(([event]) => event.event_type === 'node_failed')
      ).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'lets a subprocess finish after a transient status query failure',
    async () => {
      const store = createMockStore();
      let rejected = false;
      store.getWorkflowRunStatus.mockImplementation(async () => {
        if (!rejected && existsSync(join(testDir, 'started'))) {
          rejected = true;
          throw new Error('Connection unavailable');
        }
        return 'running';
      });
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun('transient'),
          workflow: {
            name: 'transient',
            nodes: [
              dagNodeSchema.parse({ id: 'work', bash: 'touch started; sleep 1.2; echo done' }),
            ],
          },
        })
      );
      expect(rejected).toBe(true);
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    }
  );

  // Each case starts a background job that would write `leaked` after the cancel.
  it.skipIf(process.platform === 'win32').each([
    [
      'bash',
      { id: 'hang', bash: 'touch started; (sleep 2; touch leaked) & wait' },
      "Bash node 'hang' cancelled",
    ],
    [
      'loop until_bash',
      {
        id: 'hang',
        loop: {
          prompt: 'work',
          fresh_context: false,
          max_iterations: 2,
          until_bash: 'touch started; (sleep 2; touch leaked) & wait',
        },
      },
      'Command cancelled',
    ],
  ] as const)(
    'ends the %s tree and records the node cancelled',
    async (kind, nodeInput, error) => {
      const { store, leaked } = await runUntilCancelled(`stop-${kind}`, nodeInput);
      const events = store.createWorkflowEvent.mock.calls.map(([event]) => event);
      expect(events).toContainEqual(
        expect.objectContaining({
          event_type: 'node_failed',
          step_name: 'hang',
          data: expect.objectContaining({ error, failure_kind: 'cancelled' }),
        })
      );
      expect(leaked).toBe(false);
    },
    testTimeout(15000)
  );
});

// ---------------------------------------------------------------------------
// Streaming cancel-check policy (during-streaming paused tolerance)
// ---------------------------------------------------------------------------

describe('shouldContinueStreamingForStatus', () => {
  it('continues when status is running', async () => {
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus('running')).toBe(true);
  });

  it('continues when status is paused (sibling approval node in same layer)', async () => {
    // The key invariant: a concurrent approval node can pause the run while a
    // streaming AI node is mid-response. The streaming node must finish its
    // own output — workflow progression is gated by the approval node, not
    // by tearing down unrelated in-flight streams.
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus('paused')).toBe(true);
  });

  it('aborts when status is null (run deleted)', async () => {
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus(null)).toBe(false);
  });

  it('aborts when status is cancelled', async () => {
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus('cancelled')).toBe(false);
  });

  it('aborts when status is failed', async () => {
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus('failed')).toBe(false);
  });

  it('aborts when status is completed', async () => {
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus('completed')).toBe(false);
  });

  it('aborts on any unrecognized state', async () => {
    const { shouldContinueStreamingForStatus } = await import('./run-control');
    expect(shouldContinueStreamingForStatus('pending')).toBe(false);
    // Simulates a corrupted/unexpected DB status value — the column isn't compile-time
    // checked, so the runtime fallback-to-abort still matters even though the
    // parameter type is now WorkflowRunStatus | null.
    expect(shouldContinueStreamingForStatus('invalid-status' as WorkflowRunStatus)).toBe(false);
  });
});
