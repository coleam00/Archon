// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  createMockDeps,
  dagOptions,
  makeWorkflowRun,
  mockLogFn,
  mockLogger,
  mockSendQueryDag,
  persistedEvents,
  runUsageWrites,
  type MockWorkflowStore,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { inspectResumableRun } from '../run-resume';
import { finishNodeExecution } from '../node-execution';
import { serializeNodeStateRecord } from '../node-record-serialization';
import { nodeExecutionMetadataSchema } from '../schemas/node-execution';
import type { DagNode } from '../schemas';
import type { RunChildWorkflowFn } from './child-run';
import { runUsageMismatch, type RunUsageFigures } from './usage';

type Shape = 'agent' | 'loop' | 'loop_group' | 'workflow';
type CompletionPath = 'natural' | 'gate' | 'resume';

/** Σ of every spend the mocked provider and child run reported, paid failures included. */
let truth = { input: 0, output: 0, costUsd: 0 };
let calls = 0;
let failDownstream = false;

function recordSpend(input: number, output: number, costUsd: number) {
  truth = {
    input: truth.input + input,
    output: truth.output + output,
    costUsd: truth.costUsd + costUsd,
  };
}

/** Each call spends a distinct amount; `signalFrom` is the first call whose text says `APPROVED`. */
function scriptProvider(signalFrom: number) {
  mockSendQueryDag.mockImplementation(async function* (prompt) {
    calls++;
    if (failDownstream && prompt.includes('DOWNSTREAM')) {
      // Spend and no text: a paid failed attempt.
      recordSpend(5, 1, 0.002);
      yield {
        type: 'result',
        sessionId: `s${calls}`,
        cost: 0.002,
        tokens: { input: 5, output: 1 },
      };
      return;
    }
    const tokens = { input: 10 * calls, output: calls };
    const cost = calls / 100;
    recordSpend(tokens.input, tokens.output, cost);
    yield { type: 'agent_message_chunk', text: calls >= signalFrom ? 'done\nAPPROVED' : 'not yet' };
    yield { type: 'result', sessionId: `s${calls}`, cost, tokens };
  });
}

const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
  recordSpend(7, 3, 0.5);
  return {
    childRunId: 'child-1',
    status: 'completed',
    output: 'child done',
    costUsd: 0.5,
    tokens: { input: 7, output: 3 },
  };
});

function subjectNode(shape: Shape, path: CompletionPath): DagNode {
  const gate = path === 'gate' ? { interactive: true, gate_message: 'Review.' } : {};
  switch (shape) {
    case 'agent':
      return {
        id: 'subject',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'work' },
        depends_on: [],
      };
    case 'loop':
      return {
        id: 'subject',
        kind: 'loop',
        loop: {
          prompt: 'iterate',
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          ...gate,
        },
        depends_on: [],
      };
    case 'loop_group':
      return {
        id: 'subject',
        kind: 'loop_group',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          ...gate,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'iterate' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      };
    case 'workflow':
      return { id: 'subject', kind: 'workflow', workflow: 'child-wf', depends_on: [] };
  }
}

/** A gate node follows shapes that cannot gate themselves. */
function workflowNodes(shape: Shape, path: CompletionPath): DagNode[] {
  const gateNode = path === 'gate' && (shape === 'agent' || shape === 'workflow');
  const nodes: DagNode[] = [subjectNode(shape, path)];
  if (gateNode) {
    nodes.push({
      id: 'review',
      kind: 'gate',
      message: 'Ship?',
      decisions: [{ id: 'approve' }, { id: 'reject' }],
      captureResponse: false,
      decisionsAuthored: false,
      depends_on: ['subject'],
    });
  }
  nodes.push({
    id: 'down',
    kind: 'agent',
    source: { kind: 'inline', prompt: 'DOWNSTREAM' },
    depends_on: [gateNode ? 'review' : 'subject'],
    retry: { max_attempts: 1, delay_ms: 1 },
  });
  return nodes;
}

/**
 * A mock store whose resume reads fold its own event log and whose status follows its
 * pause, so a pause and its resume share one event store as a real database does.
 */
function sharedStore(): MockWorkflowStore & { setRunning(): void } {
  const store = createMockStore();
  let status: 'running' | 'paused' = 'running';
  store.getDagResumeSnapshot.mockImplementation(async id =>
    foldDagResumeSnapshot(persistedEvents(store), id)
  );
  const pause = store.pauseWorkflowRun.getMockImplementation();
  store.pauseWorkflowRun.mockImplementation(async (...args) => {
    status = 'paused';
    await pause?.(...args);
  });
  store.getWorkflowRunStatus.mockImplementation(async () => status);
  return Object.assign(store, { setRunning: () => (status = 'running') });
}

/** The last usage the run row received, in the comparison's terms. */
function runRowFigures(store: MockWorkflowStore): RunUsageFigures {
  const row = runUsageWrites(store).at(-1) ?? {};
  const num = (key: string) => (typeof row[key] === 'number' ? row[key] : undefined);
  const input = num('total_tokens_in');
  const output = num('total_tokens_out');
  return {
    costUsd: num('total_cost_usd'),
    tokensUnknown: row.total_tokens_unknown === true,
    tokens:
      input !== undefined && output !== undefined
        ? {
            input,
            output,
            cacheRead: num('total_cache_read_tokens'),
            cacheWrite: num('total_cache_write_tokens'),
          }
        : undefined,
  };
}

function mismatchLogs() {
  return mockLogFn.mock.calls.filter(
    ([, message]) => message === 'dag.run_usage_reconciliation_mismatch'
  );
}

describe('usage reconciles across node shape × completion path', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `usage-reconciliation-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    truth = { input: 0, output: 0, costUsd: 0 };
    calls = 0;
    failDownstream = false;
    mockSendQueryDag.mockClear();
    runChildWorkflow.mockClear();
    mockLogFn.mockClear();
    mockLogger.level = 'debug';
  });
  afterEach(async () => {
    mockLogger.level = 'info';
    await removeTempTree(testDir);
  });

  // agent × natural and agent × resume are reconciled in run-layers-usage.test.ts.
  const cells: [Shape, CompletionPath][] = [
    ['agent', 'gate'],
    ['loop', 'natural'],
    ['loop', 'gate'],
    ['loop', 'resume'],
    ['loop_group', 'natural'],
    ['loop_group', 'gate'],
    ['loop_group', 'resume'],
    ['workflow', 'natural'],
    ['workflow', 'gate'],
    ['workflow', 'resume'],
  ];

  it.each(cells)(
    '%s × %s: run row and event fold both equal what the providers reported',
    async (shape, path) => {
      // A gated loop signals on its first iteration, so a bare approve finalizes it.
      scriptProvider(path === 'gate' ? 1 : 2);
      failDownstream = path === 'resume';
      const store = sharedStore();
      const deps = createMockDeps(store);
      const workflow = { name: `usage-${shape}-${path}`, nodes: workflowNodes(shape, path) };
      const runId = `run-${shape}-${path}`;
      const options = { deps, cwd: testDir, workflow, runChildWorkflow };

      await executeDagWorkflow(dagOptions({ ...options, workflowRun: makeWorkflowRun(runId) }));

      if (path !== 'natural') {
        failDownstream = false;
        let run = makeWorkflowRun(runId);
        if (path === 'gate') {
          const approval = store.pauseWorkflowRun.mock.calls[0]?.[1];
          if (approval === undefined) throw new Error('the gate did not pause');
          run = makeWorkflowRun(runId, {
            metadata: {
              approval: { ...approval, resolved: 'approved' },
              loop_user_input: '',
              loop_feedback_given: false,
            },
          });
          store.setRunning();
          if (approval.execution !== undefined) {
            // A gate node's approval is written as core's gate resolution writes it.
            const execution = nodeExecutionMetadataSchema.parse(approval.execution);
            const event = serializeNodeStateRecord(
              finishNodeExecution(
                execution,
                { status: 'completed' },
                { output: { text: '' }, diagnostics: { approvalDecision: 'approve' } }
              )
            );
            await store.createWorkflowEvent(event);
          }
        }
        const inspection = await inspectResumableRun(deps, run);
        if (!inspection) throw new Error('run is not resumable');
        // An interactive loop's pause legitimately disagrees with the fold until approval
        // (a recorded gap); only the final pass is judged here.
        mockLogFn.mockClear();
        await executeDagWorkflow(
          dagOptions({
            ...options,
            workflowRun: run,
            priorCompletedNodes: inspection.priorCompletedNodes,
            priorUsage: inspection.priorUsage,
          })
        );
      }

      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
      expect(truth.costUsd).toBeGreaterThan(0);
      expect(truth.input).toBeGreaterThan(0);
      const expected = {
        costUsd: truth.costUsd,
        tokens: { input: truth.input, output: truth.output },
      };
      const fold = await foldDagResumeSnapshot(persistedEvents(store), runId);
      expect(runUsageMismatch(expected, fold)).toEqual([]);
      expect(runUsageMismatch(expected, runRowFigures(store))).toEqual([]);
      expect(mismatchLogs()).toEqual([]);
    }
  );
});

describe('run usage reconciliation under debug logging', () => {
  let testDir: string;
  const workflow = {
    name: 'usage-debug',
    nodes: [
      { id: 'only', kind: 'agent', source: { kind: 'inline', prompt: 'work' }, depends_on: [] },
    ] satisfies DagNode[],
  };
  beforeEach(async () => {
    testDir = join(tmpdir(), `usage-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockLogFn.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 's1', cost: 0.02, tokens: { input: 40, output: 4 } };
    });
  });
  afterEach(async () => {
    mockLogger.level = 'info';
    await removeTempTree(testDir);
  });

  it('logs both figures when the run total disagrees with its node events', async () => {
    mockLogger.level = 'debug';
    // The default mock snapshot reports no usage, so the events disagree with the run.
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('debug-run'),
      })
    );
    expect(mockLogFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: 'debug-run',
        mismatched: ['cost', 'tokens'],
        run: expect.objectContaining({ costUsd: 0.02 }),
        events: expect.objectContaining({ costUsd: 0 }),
      }),
      'dag.run_usage_reconciliation_mismatch'
    );
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('does not read the event log below debug', async () => {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('info-run'),
      })
    );
    expect(store.getDagResumeSnapshot).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });
});
