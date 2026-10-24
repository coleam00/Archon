import { expect, it } from 'bun:test';
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
