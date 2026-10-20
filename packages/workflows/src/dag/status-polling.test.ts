// @archon-test-isolated
import { afterEach, beforeEach, expect, it, mock, setSystemTime } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { WorkflowStatusReadError } from '../workflow-status-read';
import { executeDagWorkflow } from '../dag-executor';
import { waitForNodeRetry, lastNodeCancelCheck } from './run-control';
import {
  createMockStore,
  createMockDeps,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  mockGetAgentProviderDag,
  mockSendQueryDag,
  mockClaudeCapabilities,
} from './test-utils';

let cwd: string;
beforeEach(async () => {
  cwd = join(tmpdir(), `status-poll-${crypto.randomUUID()}`);
  await mkdir(cwd, { recursive: true });
  lastNodeCancelCheck.clear();
});
afterEach(async () => {
  setSystemTime();
  await removeTempTree(cwd);
});

it.each(
  (['agent', 'loop'] as const).flatMap(kind =>
    [false, true].map(transient => [kind, transient] as const)
  )
)('handles a paid %s stream status error (transient: %s)', async (kind, transient) => {
  const store = createMockStore();
  const failure = new WorkflowStatusReadError('stream', new Error('Unsupported status'));
  let paid = false;
  let aborted = false;
  let rejected = false;
  store.getWorkflowRunStatus.mockImplementation(async () => {
    if (paid && !rejected) {
      rejected = true;
      throw transient ? new Error('Connection unavailable') : failure;
    }
    return 'running';
  });
  mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, options) {
    options?.abortSignal?.addEventListener('abort', () => {
      aborted = true;
    });
    yield { type: 'result', cost: 0.37, tokens: { input: 100, output: 50 }, sessionId: 'paid' };
    paid = true;
    setSystemTime(new Date(Date.now() + 20_000));
    yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
  });
  mockGetAgentProviderDag.mockImplementation(() => ({
    sendQuery: mockSendQueryDag,
    checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
    getType: () => 'claude',
    getCapabilities: mockClaudeCapabilities,
  }));
  const node =
    kind === 'agent'
      ? {
          id: 'work',
          kind: 'agent' as const,
          source: { kind: 'inline' as const, prompt: 'Work' },
        }
      : {
          id: 'work',
          kind: 'loop' as const,
          loop: { prompt: 'Work', until: 'DONE', max_iterations: 2, fresh_context: false },
        };
  const execution = executeDagWorkflow(
    dagOptions({
      deps: createMockDeps(store),
      cwd,
      workflowRun: makeWorkflowRun('stream'),
      workflow: { name: 'stream', nodes: [node] },
    })
  );
  if (transient) {
    await execution;
    expect(aborted).toBe(false);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    return;
  }
  await expect(execution).rejects.toBe(failure);
  expect(aborted).toBe(true);
  expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(false);
  const { foldDagResumeSnapshot } = await import('../dag-resume-snapshot');
  const snapshot = await foldDagResumeSnapshot(persistedEvents(store), 'stream');
  expect(snapshot.costUsd).toBeCloseTo(0.37);
  expect(snapshot.tokens).toEqual({ input: 100, output: 50 });
  expect(store.failWorkflowRun).not.toHaveBeenCalled();
  expect(store.completeWorkflowRun).not.toHaveBeenCalled();
});

it('retry waits propagate unsupported statuses and tolerate transient query failures', async () => {
  const failure = new WorkflowStatusReadError('retry', new Error('Unsupported status'));
  const status = mock(async () => {
    throw failure;
  });
  await expect(waitForNodeRetry({ getWorkflowRunStatus: status }, 'retry', 'work', 1)).rejects.toBe(
    failure
  );
  const transient = new Error('connection unavailable');
  status.mockImplementation(async () => {
    throw transient;
  });
  await waitForNodeRetry({ getWorkflowRunStatus: status }, 'retry', 'work', 1);
});
