import { afterEach, beforeEach, expect, it, mock, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { RATE_LIMIT_MAX_RETRIES, RATE_LIMIT_PAUSE_DELAY_MS } from '../../../../executor-shared';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
  persistedEvents,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import type { DagNode } from '../../../../schemas';
import type { WorkflowConfig, WorkflowDeps } from '../../../../deps';
import type { IWorkflowStore } from '../../../../store';

export function setupCreditExhaustionTests() {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-credit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    await removeTempTree(testDir);
  });

  /** A provider turn that ends in a typed quota failure. */
  function quotaExhaustedQuery(
    resetAt?: string
  ): Mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']> {
    return mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* () {
      yield {
        type: 'result',
        isError: true,
        sessionId: 'dag-session-credit',
        failure: {
          class: 'quota_exhausted',
          evidence: "You've hit your session limit",
          ...(resetAt !== undefined ? { resetAt } : {}),
        },
      };
    });
  }

  function quotaConfig(autoResumeOnQuotaReset = true): WorkflowConfig {
    return { ...minimalConfig, workflows: { autoResumeOnQuotaReset } };
  }

  const investigateWorkflow = {
    name: 'credit-wait-test',
    nodes: [
      {
        id: 'investigate',
        kind: 'agent' as const,
        source: { kind: 'inline' as const, prompt: 'Investigate the issue' },
      },
    ],
  };

  function useQuery(sendQuery: ReturnType<typeof quotaExhaustedQuery>): void {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    });
  }

  /** A provider turn that ends in a typed rate limit, on every attempt. */
  function rateLimitedQuery(
    resetAt?: string
  ): Mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']> {
    return mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* () {
      yield {
        type: 'result',
        isError: true,
        sessionId: 'dag-session-rate',
        failure: {
          class: 'rate_limited',
          evidence: 'HTTP 429',
          ...(resetAt !== undefined ? { resetAt } : {}),
        },
      };
    });
  }

  /** Run with the rate-limit retry delays shortened to a millisecond. */
  async function withShortRetryDelays(run: () => Promise<unknown>): Promise<void> {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      await run();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }
  return {
    get testDir() {
      return testDir;
    },
    quotaExhaustedQuery,
    quotaConfig,
    investigateWorkflow,
    useQuery,
    rateLimitedQuery,
    withShortRetryDelays,
  };
}

export function registerQuotaWaitTests(fixture: ReturnType<typeof setupCreditExhaustionTests>) {
  it.each([
    'The error message "Your credit balance is too low" is what the API returns when funds run out.',
    "A user once saw: You've hit your session limit · resets 3am. Handle it in the UI.",
  ])('a node whose output only mentions a credit or session limit completes: %s', async text => {
    const sendQuery = mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
      async function* () {
        yield { type: 'agent_message_chunk', text };
        yield { type: 'result', sessionId: 'dag-session-credit' };
      }
    );
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    });

    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('credit-exhaustion-run');
    const logDir = join(fixture.testDir, 'logs');

    await executeDagWorkflow(
      dagOptions({
        deps,
        platform,
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: {
          name: 'credit-test',
          nodes: [
            {
              id: 'investigate',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Investigate the issue' },
            },
          ],
        },
        workflowRun,
        logDir,
      })
    );

    const eventCalls = (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>)
      .mock.calls;
    const events = eventCalls.map(c => c[0].event_type);
    expect(events).toContain('node_completed');
    expect(events).not.toContain('node_failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it.each(['2099-10-03T23:00:00.000Z', undefined])(
    'a typed quota failure fails the node with its reset time when present: %s',
    async resetAt => {
      const sendQuery = fixture.quotaExhaustedQuery(resetAt);
      mockGetAgentProviderDag.mockReturnValue({
        sendQuery,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      });
      const store = createMockStore();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-credit',
          cwd: fixture.testDir,
          workflow: {
            name: 'credit-test',
            nodes: [
              {
                id: 'investigate',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Investigate the issue' },
                retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
              },
            ],
          },
          workflowRun: makeWorkflowRun('typed-credit-failure-run'),
          config: fixture.quotaConfig(false),
        })
      );

      const eventCalls = (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>)
        .mock.calls;
      const events = eventCalls.map(c => c[0].event_type);
      expect(events).toContain('node_failed');
      expect(events).not.toContain('node_completed');
      const failedEvent = eventCalls.find(c => c[0].event_type === 'node_failed');
      expect(failedEvent?.[0].data?.error).toBe(
        resetAt !== undefined
          ? `Node 'investigate' failed: the provider's usage or credit limit is used up until ${resetAt}: You've hit your session limit`
          : "Node 'investigate' failed: the provider's usage or credit limit is used up. Resume the run once it reopens: You've hit your session limit"
      );
      expect(failedEvent?.[0].data?.provider_failure).toEqual({
        class: 'quota_exhausted',
        evidence: "You've hit your session limit",
        ...(resetAt !== undefined ? { resetAt } : {}),
      });
      expect(sendQuery).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    }
  );

  it('waits until the reset instant a typed quota failure reports, instead of failing', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fixture.useQuery(fixture.quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: fixture.investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-wait-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-run',
      {
        owner: 'node',
        nodeId: 'investigate',
        kind: 'quota',
        pauseId: expect.any(String),
        waitingSince: expect.any(String),
        resumeAt: resetAt,
      },
      { kind: 'started', stepName: 'investigate' }
    );
    // The typed failure is recorded on the node, unchanged.
    const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
    expect(failed?.data?.provider_failure).toEqual({
      class: 'quota_exhausted',
      evidence: "You've hit your session limit",
      resetAt,
    });
  });

  it('propagates a rejected quota pause write while the run is still running', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fixture.useQuery(fixture.quotaExhaustedQuery(resetAt));
    const store = createMockStore();
    const failure = new Error('quota pause write failed');
    store.pauseWorkflowRunForWait.mockRejectedValue(failure);

    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-credit',
          cwd: fixture.testDir,
          workflow: fixture.investigateWorkflow,
          workflowRun: makeWorkflowRun('credit-write-failure-run'),
          config: fixture.quotaConfig(),
        })
      )
    ).rejects.toBe(failure);
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-write-failure-run',
      expect.objectContaining({ kind: 'quota', resumeAt: resetAt }),
      { kind: 'started', stepName: 'investigate' }
    );
    expect(store.getWorkflowRunStatus).toHaveBeenCalledWith('credit-write-failure-run');
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('waits when the quota failure comes from a loop-group body node', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fixture.useQuery(fixture.quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: {
          name: 'credit-wait-group',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                nodes: [{ id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'draft' } }],
              },
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-group-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-group-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'refine', resumeAt: resetAt }),
      { kind: 'started', stepName: 'refine' }
    );
  });

  it('waits when a loop-group body node failed reading the limited node output', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fixture.useQuery(fixture.quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: {
          name: 'credit-wait-group-reader',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                nodes: [
                  { id: 'prep', kind: 'exec', runtime: 'sh', script: 'echo ready' },
                  {
                    id: 'work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'draft' },
                    depends_on: ['prep'],
                  },
                  {
                    id: 'join',
                    kind: 'exec',
                    runtime: 'sh',
                    script: 'echo $work.output',
                    depends_on: ['prep', 'work'],
                    trigger_rule: 'all_done',
                  },
                ],
              },
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-group-reader-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(persistedEvents(store)).toContainEqual(
      expect.objectContaining({ event_type: 'node_failed', step_name: 'refine.join' })
    );
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-group-reader-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'refine', resumeAt: resetAt }),
      { kind: 'started', stepName: 'refine' }
    );
  });

  it('waits when a node failed reading the limited node output', async () => {
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fixture.useQuery(fixture.quotaExhaustedQuery(resetAt));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: {
          name: 'credit-wait-reader',
          nodes: [
            { id: 'sweep', kind: 'agent', source: { kind: 'inline', prompt: 'sweep' } },
            {
              id: 'record',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo $sweep.output',
              depends_on: ['sweep'],
              trigger_rule: 'all_done',
            },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-reader-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(persistedEvents(store)).toContainEqual(
      expect.objectContaining({ event_type: 'node_failed', step_name: 'record' })
    );
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-reader-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'sweep', resumeAt: resetAt }),
      { kind: 'started', stepName: 'sweep' }
    );
  });

  it.each([
    ['still ahead', 10 * 60_000],
    ['already passed', -60_000],
  ])('waits for the latest reset when another usage reset is %s', async (_case, offsetMs) => {
    const sooner = new Date(Date.now() + offsetMs).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    // The later reset is the first node, so a pass that kept the first or the earliest
    // reset would wait on the wrong one.
    fixture.useQuery(
      mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* (prompt) {
        yield {
          type: 'result',
          isError: true,
          sessionId: 'dag-session-credit',
          failure: {
            class: 'quota_exhausted',
            evidence: "You've hit your session limit",
            resetAt: prompt.includes('later') ? later : sooner,
          },
        };
      })
    );
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: {
          name: 'credit-wait-latest',
          nodes: [
            { id: 'first', kind: 'agent', source: { kind: 'inline', prompt: 'later' } },
            { id: 'second', kind: 'agent', source: { kind: 'inline', prompt: 'sooner' } },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-wait-latest-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'node_failed')
        .map(event => event.step_name)
        .sort()
    ).toEqual(['first', 'second']);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'credit-wait-latest-run',
      expect.objectContaining({ kind: 'quota', nodeId: 'first', resumeAt: later }),
      { kind: 'started', stepName: 'first' }
    );
  });

  it('never waits on error text that only reads like a quota limit', async () => {
    // Untyped provider errors: the words say "usage limit reached" with a reset epoch,
    // but no provider classified the failure, so the run fails.
    const resetEpoch = Math.floor(Date.now() / 1000) + 600;
    fixture.useQuery(
      mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(async function* () {
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_during_execution',
          errors: [`Claude AI usage limit reached|${String(resetEpoch)}`],
          sessionId: 'dag-session-credit',
        };
      })
    );
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: fixture.investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-prose-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
  });

  it('fails as before when a typed quota failure reports no reset', async () => {
    fixture.useQuery(fixture.quotaExhaustedQuery());
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: fixture.investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-no-reset-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'credit-no-reset-run',
      expect.stringContaining('investigate'),
      { exitReason: 'node_error' }
    );
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'quota_resume_skipped',
        step_name: 'investigate',
        data: { reason: 'reset_unavailable' },
      })
    );
  });

  it.each([
    ['the operator turned the wait off', false, 10 * 60_000, 'disabled'],
    ['the reported reset has already passed', true, -60_000, 'reset_passed'],
  ])('fails when %s', async (_case, autoResume, resetOffsetMs, reason) => {
    fixture.useQuery(
      fixture.quotaExhaustedQuery(new Date(Date.now() + resetOffsetMs).toISOString())
    );
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: fixture.investigateWorkflow,
        workflowRun: makeWorkflowRun('credit-fail-run'),
        config: fixture.quotaConfig(autoResume),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'quota_resume_skipped',
        step_name: 'investigate',
        data: { reason },
      })
    );
  });

  it('fails when another node failed for a reason the reset does not clear', async () => {
    fixture.useQuery(fixture.quotaExhaustedQuery(new Date(Date.now() + 10 * 60_000).toISOString()));
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-credit',
        cwd: fixture.testDir,
        workflow: {
          name: 'credit-mixed-test',
          nodes: [
            ...fixture.investigateWorkflow.nodes,
            { id: 'broken', kind: 'exec', runtime: 'sh', script: 'exit 3' },
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('credit-mixed-run'),
        config: fixture.quotaConfig(),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it(
    'waits a jittered backoff when a rate limit outlasts its retries, instead of failing',
    async () => {
      const sendQuery = fixture.rateLimitedQuery();
      fixture.useQuery(sendQuery);
      const store = createMockStore();
      const before = Date.now();

      await fixture.withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: fixture.testDir,
            workflow: fixture.investigateWorkflow,
            workflowRun: makeWorkflowRun('rate-wait-run'),
            config: fixture.quotaConfig(),
          })
        )
      );

      expect(sendQuery).toHaveBeenCalledTimes(1 + RATE_LIMIT_MAX_RETRIES);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'rate-wait-run',
        expect.objectContaining({ owner: 'node', nodeId: 'investigate', kind: 'quota' }),
        { kind: 'started', stepName: 'investigate' }
      );
      const wait = store.pauseWorkflowRunForWait.mock.calls[0]?.[1];
      const resumeAt = Date.parse(wait?.kind === 'quota' ? wait.resumeAt : '');
      expect(resumeAt).toBeGreaterThanOrEqual(before + RATE_LIMIT_PAUSE_DELAY_MS / 2);
      expect(resumeAt).toBeLessThanOrEqual(Date.now() + (RATE_LIMIT_PAUSE_DELAY_MS * 3) / 2);
      const failed = persistedEvents(store).find(event => event.event_type === 'node_failed');
      expect(failed?.data?.provider_failure).toEqual({
        class: 'rate_limited',
        evidence: 'HTTP 429',
      });
    },
    testTimeout(10_000)
  );
}
