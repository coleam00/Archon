// @archon-test-isolated
import { describe, expect, it, mock, spyOn } from 'bun:test';
import * as git from '@archon/git';
import { runNodeRetryLoop } from './retry';
import { assertCheckoutUntouched } from './checkout-guard';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from '../node-execution';
import { serializeNodeOutput, type NodeExecutionResult } from '../node-record-serialization';
import { createMockDeps, createMockPlatform, createMockStore, makeWorkflowRun } from './test-utils';

const node = { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Work' } } as const;
const unpriced: NodeExecutionResult = {
  state: 'failed',
  output: '',
  error: 'Retry',
  failureKind: 'transient',
  costPartial: true,
};

describe('retry usage completeness', () => {
  it.each([
    { state: 'completed', output: 'Done', costUsd: 0.03 },
    { state: 'failed', output: '', error: 'Exhausted', failureKind: 'transient', costUsd: 0.03 },
    { state: 'failed', output: '', error: 'Fatal', failureKind: 'fatal', costUsd: 0.03 },
    { state: 'failed', output: '', error: 'Contract', retryable: false, costUsd: 0.03 },
    { state: 'completed', output: 'Partial', costUsd: 0.03, costPartial: true },
  ] satisfies NodeExecutionResult[])(
    'keeps an unpriced attempt through $output $error',
    async last => {
      const store = createMockStore();
      const run = mock(
        async (): Promise<NodeExecutionResult> =>
          run.mock.calls.length === 1 ? { ...unpriced } : { ...last }
      );
      const result = await runNodeRetryLoop(
        node,
        createMockPlatform(),
        'conv',
        makeWorkflowRun('retry'),
        store,
        node.id,
        { maxRetries: 1, delayMs: 0, onError: 'all' },
        run,
        unpriced
      );
      expect(run).toHaveBeenCalledTimes(2);
      expect(result.costUsd).toBe(0.03);
      expect(result.costPartial).toBe(true);
      expect(result.state).toBe(last.state);
    }
  );

  it('keeps an unpriced attempt when stopped between retries', async () => {
    const store = createMockStore();
    store.getWorkflowRunStatus.mockResolvedValue('cancelled');
    const run = mock(async () => ({ ...unpriced, costUsd: 0.01 }));
    const result = await runNodeRetryLoop(
      node,
      createMockPlatform(),
      'conv',
      makeWorkflowRun('retry'),
      store,
      node.id,
      { maxRetries: 1, delayMs: 0, onError: 'all' },
      run,
      unpriced
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: 'failed',
      failureKind: 'cancelled',
      costUsd: 0.01,
      costPartial: true,
    });
  });

  it('does not infer unpriced work from deterministic attempts without a provider', async () => {
    const run = mock(
      async (): Promise<NodeExecutionResult> =>
        run.mock.calls.length === 1
          ? { state: 'failed', output: '', error: 'Retry', failureKind: 'transient' }
          : { state: 'completed', output: 'Done' }
    );
    const result = await runNodeRetryLoop(
      { id: 'exec', kind: 'exec', runtime: 'sh', script: 'work' },
      createMockPlatform(),
      'conv',
      makeWorkflowRun('retry'),
      createMockStore(),
      'exec',
      { maxRetries: 1, delayMs: 0, onError: 'all' },
      run,
      unpriced
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBeUndefined();
    expect(result.costPartial).toBe(false);
  });

  it('keeps accumulated retry completeness through a checkout amendment', async () => {
    const execution = finishNodeExecution(
      startNodeExecution({
        runId: 'guarded',
        path: node.id,
        node,
        invocation: newNodeInvocation(),
        provider: 'claude',
      }),
      { status: 'completed' },
      { costUsd: 0.03, output: { text: 'Done' } }
    );
    const status = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
    try {
      const deps = createMockDeps();
      const result = await assertCheckoutUntouched(
        { ...node, mutates_checkout: false },
        '/unused',
        [],
        new Map([['changed', { status: ' M', content: { kind: 'file', value: 'before' } }]]),
        { ...serializeNodeOutput(execution), costPartial: true },
        deps,
        '/unused',
        undefined
      );
      expect(result).toMatchObject({
        state: 'failed',
        failureKind: 'output_contract',
        costUsd: 0.03,
        costPartial: true,
      });
      expect(result.execution?.accounting).toBe('amendment');
    } finally {
      status.mockRestore();
    }
  });
});
