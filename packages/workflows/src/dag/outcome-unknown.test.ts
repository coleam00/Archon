// @archon-test-isolated
/**
 * A node failure recording `outcome_unknown` leaves the run failed with that stop reason and
 * nothing started again by itself. No built-in node records the kind yet, so these tests
 * have the engine's own `recordNodeState` record it for the named nodes: everything past
 * that write (retry, persistence, aggregates, run end) runs as it does for a real producer.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import * as nodeEventWrite from '../node-event-write';
import { executeDagWorkflow } from '../dag-executor';
import { classifyExistingChildren } from './nodes/workflow/fan-out-children';
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

function failedEvents(store: MockWorkflowStore, step: (name: string) => boolean) {
  return persistedEvents(store).filter(
    event => event.event_type === 'node_failed' && step(event.step_name ?? '')
  );
}

function expectFailedOutcomeUnknown(store: MockWorkflowStore, runId: string): void {
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

  it.each([
    ['outcome_unknown', false],
    ['exec_failed', true],
  ] as const)(
    'a continuation after a pause, when a node failed with %s before it, starts work: %s',
    async (failureKind, starts) => {
      const marker = join(testDir, 'ran');
      const store = createMockStore();
      // The pass before the pause recorded the failure; its fold is what the continuation replays.
      await store.createWorkflowEvent({
        workflow_run_id: 'unknown-continue',
        event_type: 'node_failed',
        step_name: 'write',
        data: { error: 'timed out', failure_kind: failureKind },
      });
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'unknown-continue',
            nodes: [
              // always_run re-executes on a continuation; nothing else here would run again.
              {
                id: 'write',
                kind: 'exec',
                runtime: 'sh',
                script: `touch '${marker}'; exit 1`,
                always_run: true,
              },
            ] as DagNode[],
          },
          workflowRun: makeWorkflowRun('unknown-continue'),
          replayedFailures: new Map([['write', { error: 'timed out', failureKind }]]),
        })
      );
      expect(existsSync(marker)).toBe(starts);
      if (!starts) expectFailedOutcomeUnknown(store, 'unknown-continue');
    }
  );

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

    expect(failedEvents(store, step => step === 'write')).toHaveLength(1);
    expect(failedEvents(store, step => step === 'write')[0]?.data?.failure_kind).toBe(
      'outcome_unknown'
    );
    expectFailedOutcomeUnknown(store, 'unknown-retry');
  });

  it('inside a loop group still gives the run its stop reason, though the group records child_failed', async () => {
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

    expect(failedEvents(store, step => step === 'refine')[0]?.data?.failure_kind).toBe(
      'child_failed'
    );
    expect(failedEvents(store, step => step.endsWith('write'))).toHaveLength(1);
    expectFailedOutcomeUnknown(store, 'unknown-group');
  });

  describe('inside a composed fan-out', () => {
    const fanOut = async (
      mode: 'all_done' | 'all_success',
      inLoop = false
    ): Promise<MockWorkflowStore> => {
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
      const fanNode = {
        id: 'fan',
        kind: 'compose_fan_out' as const,
        include: 'writer',
        fan_out: { items: '[1,2]', as: 'item', max_parallel: 2, join: mode },
      };
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'unknown-fan',
            nodes: inLoop
              ? ([
                  {
                    id: 'refine',
                    kind: 'loop_group',
                    loop_group: { until: 'DONE', max_iterations: 2, nodes: [fanNode] },
                  },
                ] as DagNode[])
              : [fanNode],
          },
          workflowRun: makeWorkflowRun('unknown-fan'),
        })
      );
      return store;
    };

    it('under all_success fails the run with its stop reason', async () => {
      const store = await fanOut('all_success');
      expect(failedEvents(store, step => step === 'fan')[0]?.data?.failure_kind).toBe(
        'child_failed'
      );
      expectFailedOutcomeUnknown(store, 'unknown-fan');
    });

    it('under all_done lets the other instance finish and the node complete, as for any failure', async () => {
      const store = await fanOut('all_done');
      const instances = persistedEvents(store).filter(event =>
        event.step_name?.endsWith('__write')
      );
      expect(instances.filter(event => event.event_type === 'node_completed')).toHaveLength(1);
      expect(
        instances.filter(event => event.event_type === 'node_failed').map(e => e.data?.failure_kind)
      ).toEqual(['outcome_unknown']);
      // The failed instance's slot carries the failure marker, as for any failed instance.
      const joined = persistedEvents(store).find(
        event => event.event_type === 'node_completed' && event.step_name === 'fan'
      );
      const slots = JSON.parse(String(joined?.data?.node_output)) as unknown[];
      expect(slots).toContainEqual(expect.objectContaining({ archon_failed: true }));
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    });

    it('under all_done inside a loop group stops the loop before another round runs it again', async () => {
      const store = await fanOut('all_done', true);
      const failures = persistedEvents(store).filter(
        event => event.event_type === 'node_failed' && event.step_name?.endsWith('__write')
      );
      expect(failures.map(e => e.data?.failure_kind)).toEqual(['outcome_unknown']);
      expect(failedEvents(store, step => step === 'refine')[0]?.data?.failure_kind).toBe(
        'child_failed'
      );
      expectFailedOutcomeUnknown(store, 'unknown-fan');
    });
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

    it('does not wait when a node downstream of the limit failed with an unknown outcome', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      const store = await quotaRun({});
      expectFailedOutcomeUnknown(store, 'unknown-quota');
      expect(persistedEvents(store)).toContainEqual(
        expect.objectContaining({
          event_type: 'quota_resume_skipped',
          step_name: 'sweep',
          data: { reason: 'outcome_unknown' },
        })
      );
    });

    it('still waits when the downstream node is a script contract failure (retryable: false)', async () => {
      const store = await quotaRun({
        script: "echo 'not json'",
        output_format: { type: 'object' },
      } as Partial<DagNode>);
      const contract = failedEvents(store, step => step === 'write')[0]?.data;
      expect(contract?.failure_kind).toBe('output_contract');
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
      expectFailedOutcomeUnknown(store, 'unknown-source');
    });

    it('still releases the run when the sibling is a script contract failure (retryable: false)', async () => {
      const store = await unreadableRun({
        id: 'write',
        kind: 'exec',
        runtime: 'sh',
        script: "echo 'not json'",
        output_format: { type: 'object' },
      } as DagNode);
      const contract = failedEvents(store, step => step === 'write')[0]?.data;
      expect(contract?.failure_kind).toBe('output_contract');
      expect(contract?.retryable).toBe(false);
      expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    });
  });
});

describe('a workflow: fan-out recovering its children', () => {
  it('re-drives an ordinary failed child, but not one that stopped with an unknown outcome', () => {
    const failed = (id: string, reason: string) =>
      makeWorkflowRun(id, { status: 'failed', metadata: { stop_reason: { reason } } });
    const { settledByIndex } = classifyExistingChildren(
      new Map([
        [0, failed('child-unknown', 'outcome_unknown')],
        [1, failed('child-error', 'node_error')],
      ]),
      false
    );
    expect([...settledByIndex.keys()]).toEqual([0]);
  });
});
