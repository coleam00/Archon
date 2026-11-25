// @archon-test-isolated
/**
 * A node failure recording `outcome_unknown` ends the run at the next top-level layer: it
 * fails with that stop reason and nothing starts again by itself. No built-in node records
 * the kind yet, so these tests have the engine's own `recordNodeState` record it for the
 * named nodes; everything past that write (retry, persistence, aggregates, the walk, run end)
 * runs as it does for a real producer.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import * as nodeEventWrite from '../node-event-write';
import { executeDagWorkflow } from '../dag-executor';
import { captureWorkflowSource, capturedSourceRoots } from '../workflow-source';
import { WorkflowSourceUnavailableError } from '../workflow-source';
import * as sourceLoader from '../workflow-source/load';
import type { DagNode } from '../schemas';
import type { WorkflowDeps } from '../deps';
import {
  type MockWorkflowStore,
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  persistedEvents,
} from './test-utils';

const realRecordNodeState = nodeEventWrite.recordNodeState;

/** Record a failure of each named node as `outcome_unknown`, as a writing tool would. */
function failingWithOutcomeUnknown(nodeIds: readonly string[]) {
  return spyOn(nodeEventWrite, 'recordNodeState').mockImplementation(
    (sinks, record, continuation) =>
      realRecordNodeState(
        sinks,
        !('cache' in record) &&
          record.lifecycle.status === 'failed' &&
          // A composed instance's inner node carries the instance prefix.
          nodeIds.some(id => record.node.id === id || record.node.id.endsWith(`__${id}`))
          ? { ...record, lifecycle: { ...record.lifecycle, failureKind: 'outcome_unknown' } }
          : record,
        continuation
      )
  );
}

const eventsOf = (store: MockWorkflowStore, type: string, step: (name: string) => boolean) =>
  persistedEvents(store).filter(e => e.event_type === type && step(e.step_name ?? ''));

/** A contract failure: stdout that is not the declared JSON, so `retryable: false`. */
const contractFailure = { script: "echo 'not json'", output_format: { type: 'object' } };

function expectStoppedWithOutcomeUnknown(store: MockWorkflowStore, runId: string): void {
  expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  expect(store.failWorkflowRun).toHaveBeenCalledWith(
    runId,
    expect.any(String),
    expect.objectContaining({ exitReason: 'outcome_unknown' })
  );
  expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
  expect(store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
}

describe('a failure whose outcome is unknown', () => {
  let testDir: string;
  let spy: ReturnType<typeof failingWithOutcomeUnknown> | undefined;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `outcome-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    spy?.mockRestore();
    spy = undefined;
    await removeTempTree(testDir);
  });

  it('is not retried under on_error: all, and fails the run with its stop reason', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'unknown-retry',
          nodes: [
            {
              id: 'write',
              kind: 'exec',
              runtime: 'sh',
              script: 'exit 1',
              retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('unknown-retry'),
      })
    );
    expect(eventsOf(store, 'node_started', step => step === 'write')).toHaveLength(1);
    expectStoppedWithOutcomeUnknown(store, 'unknown-retry');
  });

  describe('inside a composed fan-out', () => {
    // The later layer: a wait, and an always_run node that would run after any failure.
    const later = (marker: string): DagNode[] => [
      {
        id: 'delay',
        kind: 'wait',
        wait: { duration_ms: 60_000 },
        depends_on: ['fan'],
        trigger_rule: 'all_done',
      } as DagNode,
      {
        id: 'cleanup',
        kind: 'exec',
        runtime: 'sh',
        script: `touch '${marker}'`,
        depends_on: ['fan'],
        trigger_rule: 'all_done',
        always_run: true,
      } as DagNode,
    ];

    const fanOut = async (join_: 'all_done' | 'all_success') => {
      await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(testDir, '.archon', 'workflows', 'writer.yaml'),
        [
          'name: writer',
          'description: block',
          'mutates_checkout: false',
          'inputs:',
          '  item: { required: true }',
          'nodes:',
          '  - id: write',
          '    bash: "test $INPUTS.item != 2"',
        ].join('\n')
      );
      spy = failingWithOutcomeUnknown(['write']);
      const marker = join(testDir, 'cleaned');
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'unknown-fan',
            nodes: [
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'writer',
                fan_out: { items: '[1,2]', as: 'item', max_parallel: 2, join: join_ },
              },
              ...later(marker),
            ],
          },
          workflowRun: makeWorkflowRun('unknown-fan'),
        })
      );
      return { store, marker };
    };

    it.each(['all_done', 'all_success'] as const)(
      'under %s lets the other instance finish, then stops the run before the next layer',
      async join_ => {
        const { store, marker } = await fanOut(join_);
        const instances = persistedEvents(store).filter(e => e.step_name?.endsWith('__write'));
        expect(instances.filter(e => e.event_type === 'node_completed')).toHaveLength(1);
        const fan = persistedEvents(store).find(
          e =>
            e.step_name === 'fan' &&
            (e.event_type === 'node_completed' || e.event_type === 'node_failed')
        );
        if (join_ === 'all_done') {
          // The join is unchanged: it completes with the failure marker in the slot.
          expect(fan?.event_type).toBe('node_completed');
          const slots = JSON.parse(String(fan?.data?.node_output)) as unknown[];
          expect(slots).toContainEqual(expect.objectContaining({ archon_failed: true }));
        } else {
          expect(fan?.event_type).toBe('node_failed');
        }
        expect(
          eventsOf(store, 'node_started', step => step === 'delay' || step === 'cleanup')
        ).toEqual([]);
        expect(existsSync(marker)).toBe(false);
        expectStoppedWithOutcomeUnknown(store, 'unknown-fan');
      }
    );
  });

  it('inside a loop group body fails the run with its stop reason', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'unknown-group',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                nodes: [{ id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1' }],
              },
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('unknown-group'),
      })
    );
    expect(eventsOf(store, 'node_failed', step => step.endsWith('write'))).toHaveLength(1);
    expectStoppedWithOutcomeUnknown(store, 'unknown-group');
  });

  describe('after a provider usage limit with a reset ahead', () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const quotaRun = async (downstream: Partial<DagNode>): Promise<MockWorkflowStore> => {
      mockGetAgentProviderDag.mockReturnValue({
        sendQuery: mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
          async function* () {
            yield {
              type: 'result',
              isError: true,
              sessionId: 'quota',
              failure: { class: 'quota_exhausted', evidence: 'limit', resetAt },
            };
          }
        ),
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      });
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'unknown-quota',
            nodes: [
              { id: 'sweep', kind: 'agent', source: { kind: 'inline', prompt: 'sweep' } },
              {
                id: 'write',
                kind: 'exec',
                runtime: 'sh',
                script: 'exit 1',
                depends_on: ['sweep'],
                trigger_rule: 'all_done',
                ...downstream,
              },
            ] as DagNode[],
          },
          workflowRun: makeWorkflowRun('unknown-quota'),
          config: { ...minimalConfig, workflows: { autoResumeOnQuotaReset: true } },
        })
      );
      return store;
    };

    it('fails instead of waiting when a node downstream of the limit failed with an unknown outcome', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      expectStoppedWithOutcomeUnknown(await quotaRun({}), 'unknown-quota');
    });

    it('still waits when that node is a script contract failure (retryable: false)', async () => {
      const store = await quotaRun(contractFailure as Partial<DagNode>);
      const contract = eventsOf(store, 'node_failed', step => step === 'write')[0]?.data;
      expect(contract?.retryable).toBe(false);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'unknown-quota',
        expect.objectContaining({ kind: 'quota', nodeId: 'sweep', resumeAt: resetAt }),
        { kind: 'started', stepName: 'sweep' }
      );
    });
  });

  describe.skipIf(process.platform === 'win32')('when a sibling source is unreadable', () => {
    const unreadableRun = async (
      write: DagNode = { id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1' }
    ): Promise<MockWorkflowStore> => {
      const scripts = join(testDir, '.archon', 'scripts');
      await mkdir(scripts, { recursive: true });
      await writeFile(join(scripts, 'check.ts'), 'console.log("ran")');
      const capture = await captureWorkflowSource({
        sourceRoot: testDir,
        captureRoot: join(testDir, 'capture'),
      });
      const fault = spyOn(sourceLoader, 'assertWorkflowSourceIntegrity').mockRejectedValue(
        new WorkflowSourceUnavailableError(join(testDir, 'capture'), new Error('read denied'))
      );
      const store = createMockStore();
      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: {
              name: 'unknown-source',
              nodes: [
                write,
                { id: 'check', kind: 'exec', runtime: 'bun', script: 'check' },
              ] as DagNode[],
            },
            workflowRun: makeWorkflowRun('unknown-source'),
            workflowSourceRoots: capturedSourceRoots(capture.anchor),
          })
        );
      } finally {
        fault.mockRestore();
      }
      return store;
    };

    it('fails the run instead of releasing it to a host that would run the node again', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      const store = await unreadableRun();
      expectStoppedWithOutcomeUnknown(store, 'unknown-source');
      expect(eventsOf(store, 'source_released', () => true)).toEqual([]);
    });

    it('still releases the run when the sibling is a script contract failure (retryable: false)', async () => {
      const store = await unreadableRun({
        id: 'write',
        kind: 'exec',
        runtime: 'sh',
        ...contractFailure,
      } as DagNode);
      expect(eventsOf(store, 'node_failed', step => step === 'write')[0]?.data?.retryable).toBe(
        false
      );
      expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    });
  });

  it('a later layer still runs after a script contract failure (retryable: false)', async () => {
    const marker = join(testDir, 'cleaned');
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'contract-later',
          nodes: [
            { id: 'write', kind: 'exec', runtime: 'sh', ...contractFailure },
            {
              id: 'cleanup',
              kind: 'exec',
              runtime: 'sh',
              script: `touch '${marker}'`,
              depends_on: ['write'],
              trigger_rule: 'all_done',
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('contract-later'),
      })
    );
    expect(existsSync(marker)).toBe(true);
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'contract-later',
      expect.any(String),
      expect.objectContaining({ exitReason: 'node_error' })
    );
  });

  // The pass before recorded the failure. A continuation of a wait that paused in the same
  // layer has no `workflow_resumed` after it; a hand resume of the failed run does.
  it.each([
    { pass: 'a continuation', resumed: false },
    { pass: 'a hand resume', resumed: true },
  ])('$pass after the failure runs the node again only on a hand resume', async ({ resumed }) => {
    const marker = join(testDir, 'wrote');
    const store = createMockStore();
    await store.createWorkflowEvent({
      workflow_run_id: 'unknown-again',
      event_type: 'node_failed',
      step_name: 'write',
      data: { error: 'timed out', failure_kind: 'outcome_unknown' },
    });
    if (resumed)
      await store.createWorkflowEvent({
        workflow_run_id: 'unknown-again',
        event_type: 'workflow_resumed',
        data: {},
      });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'unknown-again',
          nodes: [
            { id: 'write', kind: 'exec', runtime: 'sh', script: `touch '${marker}'` },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('unknown-again'),
      })
    );
    expect(existsSync(marker)).toBe(resumed);
    if (resumed) expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    else expectStoppedWithOutcomeUnknown(store, 'unknown-again');
  });
});
