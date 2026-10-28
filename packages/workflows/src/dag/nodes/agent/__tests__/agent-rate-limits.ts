import { expect, it, mock } from 'bun:test';
import { testTimeout } from '@archon/paths/test-utils';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  stubMissingContainer,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import type { DagNode } from '../../../../schemas';
import type { setupCreditExhaustionTests } from './agent-quota-waits';

export function registerRateLimitTests(fixture: ReturnType<typeof setupCreditExhaustionTests>) {
  it(
    'waits until the reset a rate-limited failure reports',
    async () => {
      const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
      fixture.useQuery(fixture.rateLimitedQuery(resetAt));
      const store = createMockStore();

      await fixture.withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: fixture.testDir,
            workflow: fixture.investigateWorkflow,
            workflowRun: makeWorkflowRun('rate-reset-run'),
            config: fixture.quotaConfig(),
          })
        )
      );

      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'rate-reset-run',
        expect.objectContaining({ kind: 'quota', nodeId: 'investigate', resumeAt: resetAt }),
        { kind: 'started', stepName: 'investigate' }
      );
    },
    testTimeout(10_000)
  );

  it(
    'fails an exhausted rate limit when the operator turned the wait off',
    async () => {
      fixture.useQuery(fixture.rateLimitedQuery());
      const store = createMockStore();

      await fixture.withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: fixture.testDir,
            workflow: fixture.investigateWorkflow,
            workflowRun: makeWorkflowRun('rate-disabled-run'),
            config: fixture.quotaConfig(false),
          })
        )
      );

      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.createWorkflowEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'quota_resume_skipped',
          step_name: 'investigate',
          data: { reason: 'disabled' },
        })
      );
    },
    testTimeout(10_000)
  );

  it(
    'fails when a node beside an exhausted rate limit failed for another reason',
    async () => {
      fixture.useQuery(fixture.rateLimitedQuery());
      const store = createMockStore();

      await fixture.withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: fixture.testDir,
            workflow: {
              name: 'rate-mixed-test',
              nodes: [
                ...fixture.investigateWorkflow.nodes,
                { id: 'broken', kind: 'exec', runtime: 'sh', script: 'exit 3' },
              ] as DagNode[],
            },
            workflowRun: makeWorkflowRun('rate-mixed-run'),
            config: fixture.quotaConfig(),
          })
        )
      );

      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    },
    testTimeout(10_000)
  );

  it(
    'fails a loop group whose body failed both on an exhausted rate limit and for another reason',
    async () => {
      fixture.useQuery(fixture.rateLimitedQuery());
      const store = createMockStore();

      await fixture.withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            conversationId: 'conv-rate',
            cwd: fixture.testDir,
            workflow: {
              name: 'rate-mixed-group',
              nodes: [
                {
                  id: 'refine',
                  kind: 'loop_group',
                  loop_group: {
                    until: 'DONE',
                    max_iterations: 3,
                    nodes: [
                      { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'draft' } },
                      { id: 'broken', kind: 'exec', runtime: 'sh', script: 'exit 3' },
                    ],
                  },
                },
              ] as DagNode[],
            },
            workflowRun: makeWorkflowRun('rate-mixed-group-run'),
            config: fixture.quotaConfig(),
          })
        )
      );

      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      const groupFailed = persistedEvents(store).find(
        event => event.event_type === 'node_failed' && event.step_name === 'refine'
      );
      expect(groupFailed?.data?.error).toContain("'broken'");
      expect(groupFailed?.data?.provider_failure).toBeUndefined();
    },
    testTimeout(10_000)
  );

  it('preserves a mixed-reset loop group deadline through the final wait', async () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const resetAt = new Date(now + 10 * 60_000).toISOString();
    fixture.useQuery(
      mock(async function* (prompt: string) {
        yield {
          type: 'result' as const,
          isError: true,
          failure: {
            class: 'rate_limited' as const,
            evidence: 'HTTP 429',
            ...(prompt.includes('reported-reset') ? { resetAt } : {}),
          },
        };
      })
    );
    const store = createMockStore();
    store.createWorkflowEvent.mockImplementation(async event => {
      if (event.event_type === 'node_failed' && event.step_name === 'refine')
        Math.random = () => 0.1;
    });
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => now;
    Math.random = () => 0.7;
    try {
      await fixture.withShortRetryDelays(() =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: fixture.testDir,
            workflowRun: makeWorkflowRun('mixed-reset-group'),
            config: fixture.quotaConfig(),
            workflow: {
              name: 'mixed-reset-group',
              nodes: [
                {
                  id: 'refine',
                  kind: 'loop_group',
                  loop_group: {
                    until: 'DONE',
                    max_iterations: 1,
                    fresh_context: true,
                    nodes: [
                      {
                        id: 'reported',
                        kind: 'agent',
                        source: { kind: 'inline', prompt: 'reported-reset' },
                      },
                      {
                        id: 'resetless',
                        kind: 'agent',
                        source: { kind: 'inline', prompt: 'resetless' },
                      },
                    ],
                  },
                },
              ],
            },
          })
        )
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'mixed-reset-group',
        expect.objectContaining({ resumeAt: new Date(now + 12 * 60_000).toISOString() }),
        { kind: 'started', stepName: 'refine' }
      );
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });

  it('does not wait for a container run, which the continuation host cannot continue', async () => {
    fixture.useQuery(fixture.quotaExhaustedQuery(new Date(Date.now() + 10 * 60_000).toISOString()));
    const store = createMockStore();
    const execSpy = stubMissingContainer();

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-credit',
          cwd: fixture.testDir,
          workflow: fixture.investigateWorkflow,
          workflowRun: makeWorkflowRun('container-credit-run'),
          config: fixture.quotaConfig(),
          execContext: { kind: 'container', containerId: 'container-1' },
        })
      );
    } finally {
      execSpy.mockRestore();
    }

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'quota_resume_skipped',
        data: { reason: 'container_unsupported' },
      })
    );
  });
}
