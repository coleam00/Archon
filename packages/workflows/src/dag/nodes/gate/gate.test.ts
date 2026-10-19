// @archon-test-isolated
import { createEscalationStore } from '../../pause-test-utils';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  type MockWorkflowPlatform,
  createMockPlatform,
  persistedEvents,
  runUsageWrites,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../../../event-emitter';
import type { DagNode, WorkflowDefinition } from '../../../schemas';
import { dagNodeSchema } from '../../../schemas';
import { expandWorkflowIncludes } from '../../../include-expander';
import type { IWorkflowPlatform } from '../../../deps';
import { WorkflowRunPauseConflictError, type IWorkflowStore } from '../../../store';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';

describe('executeDagWorkflow -- approval node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  it('fresh approval node pauses with extended context (capture_response + on_reject)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-test',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [
                { id: 'approve' },
                {
                  id: 'reject',
                  rework: { prompt: 'Fix based on: $REJECTION_REASON', maxAttempts: 3 },
                },
              ],
              captureResponse: true,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    // AI should NOT have been called (fresh approval just pauses)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // pauseWorkflowRun should have been called with extended context
    const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'review',
      message: 'Approve this plan?',
      captureResponse: true,
      onRejectPrompt: 'Fix based on: $REJECTION_REASON',
      onRejectMaxAttempts: 3,
    });
  });

  it('keeps the approval gate paused when its prompt cannot be delivered', async () => {
    const store = createEscalationStore('dag-test-run-id');
    const platform = createMockPlatform();
    platform.sendMessage = mock(async (_conversationId, message): Promise<void> => {
      if (message.includes('Approval required')) throw new Error('401 unauthorized');
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-undelivered',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve?',
              decisions: [{ id: 'approve' }, { id: 'reject' }],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'dag-test-run-id',
      event_type: 'pause_notice_undelivered',
      step_name: 'review',
      data: { nodeId: 'review', occurrence: expect.any(String), platform: 'test' },
    });
    expect(store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'approval_requested', step_name: 'review' })
    );
    expect(store.getState().status).toBe('paused');
    expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(false);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'loop',
      node: {
        id: 'refine',
        kind: 'loop',
        loop: {
          fresh_context: false,
          prompt: 'Refine.',
          until: 'APPROVED',
          max_iterations: 3,
          interactive: true,
          gate_message: 'Review.',
        },
      },
    },
    {
      kind: 'loop_group',
      node: {
        id: 'refine',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          interactive: true,
          gate_message: 'Review.',
          nodes: [{ id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'draft' } }],
        },
      },
    },
  ])('keeps the $kind gate paused when its prompt cannot be delivered', async ({ node }) => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Draft.' };
      yield { type: 'result', sessionId: 'undelivered-loop' };
    });
    const store = createEscalationStore('dag-test-run-id');
    const platform = createMockPlatform();
    platform.sendMessage = mock(async (_conversationId, message): Promise<void> => {
      if (message.includes('Input required')) throw new Error('401 unauthorized');
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-loop',
        cwd: testDir,
        workflow: { name: 'loop-undelivered', nodes: [node] as DagNode[] },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'dag-test-run-id',
      event_type: 'pause_notice_undelivered',
      step_name: 'refine',
      data: { nodeId: 'refine', occurrence: expect.any(String), platform: 'test' },
    });
    expect(store.getState().status).toBe('paused');
    expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(false);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('delivers the nested proposal action at the approval gate, including legacy local resumes', async () => {
    // 'legacy' is a row an older binary wrote: the reader turns its declared_fields into
    // depth-1 paths, and the producer's own schema must still authorize the nested read.
    for (const resume of ['none', 'no-contract', 'legacy'] as const) {
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: {
            name: 'nested-gate',
            nodes: [
              {
                id: 'review',
                kind: 'exec',
                runtime: 'sh',
                script: `printf '%s' '{"proposal":{"action":"add"}}'`,
                output_format: {
                  type: 'object',
                  properties: {
                    proposal: {
                      type: 'object',
                      properties: { action: { type: 'string' } },
                      required: ['action'],
                    },
                  },
                  required: ['proposal'],
                },
              },
              {
                id: 'gate',
                kind: 'gate',
                message: 'Proposed: $review.output.proposal.action',
                depends_on: ['review'],
                decisions: [{ id: 'approve' }, { id: 'reject' }],
                captureResponse: false,
                decisionsAuthored: false,
              },
            ],
          },
          workflowRun: makeWorkflowRun(`nested-gate-${resume}`),
          ...(resume !== 'none'
            ? {
                priorCompletedNodes: new Map([
                  [
                    'review',
                    {
                      output: '{"proposal":{"action":"add"}}',
                      ...(resume === 'legacy' ? { declaredOutputPaths: [['proposal']] } : {}),
                    },
                  ],
                ]),
              }
            : {}),
        })
      );
      expect(store.pauseWorkflowRun.mock.calls[0]?.[1].message).toBe('Proposed: add');
      const producer = persistedEvents(store).find(
        e =>
          e.step_name === 'review' &&
          ['node_completed', 'node_skipped_prior_success'].includes(e.event_type)
      );
      expect(producer?.data?.declared_output_paths).toEqual([['proposal'], ['proposal', 'action']]);
    }
  });

  it('fails the consuming node for missing schemaless nested JSON', async () => {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'missing-nested',
          nodes: [
            { id: 'review', kind: 'exec', runtime: 'sh', script: `printf '%s' '{"proposal":{}}'` },
            {
              id: 'read',
              kind: 'exec',
              runtime: 'sh',
              script: 'printf %s $review.output.proposal.action',
              depends_on: ['review'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('missing-nested'),
      })
    );
    const failed = persistedEvents(store).find(
      e => e.step_name === 'read' && e.event_type === 'node_failed'
    );
    expect(failed?.data?.error).toContain('$review.output.proposal.action');
    expect(failed?.data?.error).toContain("field 'action'");
  });

  it('nested bindings preserve objects and scalars through the logical input channel', async () => {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'nested-binding',
          nodes: [
            {
              id: 'review',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '%s' '{"proposal":{"details":{"ready":false,"count":0}}}'`,
            },
            {
              id: 'read',
              kind: 'exec',
              runtime: 'bun',
              script:
                "process.stdout.write([process.env.INPUTS_DETAILS, process.env.INPUTS_COUNT].join('|'))",
              depends_on: ['review'],
              with: {
                details: { from: '$review.output.proposal.details', if_skipped: null },
                count: '$review.output.proposal.details.count',
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('nested-binding'),
      })
    );
    expect(
      persistedEvents(store).find(e => e.step_name === 'read' && e.event_type === 'node_completed')
        ?.data?.node_output
    ).toBe('{"ready":false,"count":0}|0');
  });

  it('approval node without capture_response stores empty node output', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-no-capture',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve?',
              decisions: [{ id: 'approve' }, { id: 'reject' }],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    // GateNode.captureResponse is a required boolean (#2486) — an undeclared
    // capture_response resolves to false, not undefined.
    const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'review',
      message: 'Approve?',
      captureResponse: false,
    });
  });

  it.each([
    { external: false, tokensUnknown: false },
    { external: true, tokensUnknown: false },
    { external: false, tokensUnknown: true },
    { external: true, tokensUnknown: true },
  ])(
    'counts rework once across pause and resume (external=$external, tokensUnknown=$tokensUnknown)',
    async ({ external, tokensUnknown }) => {
      const tokens = { input: 100, output: 10, cacheRead: 40, cacheWrite: 5 };
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Fixed based on feedback' };
        yield {
          type: 'result',
          sessionId: 'reject-fix-session',
          cost: 0.05,
          ...(tokensUnknown ? { tokensUnknown: true } : { tokens }),
        };
      });

      const store = createMockStore();
      const pauseWorkflowRun = store.pauseWorkflowRun;
      if (external) {
        let pauseAttempted = false;
        store.pauseWorkflowRun = mock(async () => {
          pauseAttempted = true;
          throw new WorkflowRunPauseConflictError('reject-resume-run');
        });
        store.getWorkflowRunStatus = mock(async () => (pauseAttempted ? 'failed' : 'running'));
      }
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();

      const workflowRun = makeWorkflowRun('reject-resume-run', {
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review',
            message: 'Approve this plan?',
            onRejectPrompt: 'Fix based on: $REJECTION_REASON',
            onRejectMaxAttempts: 3,
          },
          rejection_reason: 'Missing edge case handling',
          rejection_count: 1,
        },
      });

      const options = dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-reject-resume',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [
                { id: 'approve' },
                {
                  id: 'reject',
                  rework: { prompt: 'Fix based on: $REJECTION_REASON', maxAttempts: 3 },
                },
              ],
              captureResponse: true,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      });
      await executeDagWorkflow(options);

      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const aiPrompt = mockSendQueryDag.mock.calls[0][0] as string;
      expect(aiPrompt).toContain('Missing edge case handling');

      const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
        .calls;
      expect(pauseCalls.length).toBe(1);
      expect(
        platform.sendMessage.mock.calls.some(([, message]) => message.includes('Approval required'))
      ).toBe(!external);
      const expectedUsage = {
        total_cost_usd: 0.05,
        ...(tokensUnknown
          ? {
              total_tokens_unknown: true,
              total_tokens_in: null,
              total_tokens_out: null,
              total_cache_read_tokens: null,
              total_cache_write_tokens: null,
              total_cache_partial: null,
            }
          : {
              total_tokens_in: 100,
              total_tokens_out: 10,
              total_cache_read_tokens: 40,
              total_cache_write_tokens: 5,
            }),
      };
      expect(runUsageWrites(store)).toEqual([expectedUsage]);
      const events = persistedEvents(store);
      expect(
        events.filter(e => e.event_type === 'node_completed' && e.step_name === 'review:on_reject')
      ).toHaveLength(1);
      expect(
        events.filter(e => e.event_type === 'node_completed' && e.step_name === 'review')
      ).toHaveLength(0);
      const snapshot = await foldDagResumeSnapshot(events, workflowRun.id);
      expect(snapshot.costUsd).toBe(0.05);
      expect(snapshot.tokens).toEqual(tokensUnknown ? undefined : tokens);
      expect(snapshot.tokensUnknown).toBe(tokensUnknown);

      pauseWorkflowRun.mockClear();
      store.pauseWorkflowRun = pauseWorkflowRun;
      store.getWorkflowRunStatus = mock(async () => 'running');
      await executeDagWorkflow({
        ...options,
        workflowRun: makeWorkflowRun(workflowRun.id),
        priorCompletedNodes: snapshot.completedNodeOutputs,
        priorUsage: snapshot,
      });
      expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
      expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
      expect(runUsageWrites(store)).toEqual([expectedUsage, expectedUsage]);
    }
  );

  it('resolves $TYPED_ARTIFACTS_FILE in an approval rework prompt', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'reworked' };
      yield { type: 'result', sessionId: 'rework-listing-session' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('rework-listing-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Missing edge case handling',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-rework-listing',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [
                { id: 'approve' },
                {
                  id: 'reject',
                  rework: { prompt: 'Listing: $TYPED_ARTIFACTS_FILE', maxAttempts: 3 },
                },
              ],
              captureResponse: true,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    const aiPrompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(aiPrompt).not.toContain('$TYPED_ARTIFACTS_FILE');
    const listingPath = aiPrompt.replace('Listing: ', '');
    expect(listingPath).toContain(join('.archon', 'typed-artifacts'));
    const listing = JSON.parse(await readFile(listingPath, 'utf8')) as { runId: string };
    expect(listing.runId).toBe('rework-listing-run');
  });

  it('on_reject does not write node_completed for the approval gate node ID', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Fixed based on feedback' };
      yield { type: 'result', sessionId: 'reject-no-poison-session' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('reject-no-poison-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Missing edge case handling',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-no-poison',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [
                { id: 'approve' },
                {
                  id: 'reject',
                  rework: { prompt: 'Fix based on: $REJECTION_REASON', maxAttempts: 3 },
                },
              ],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    // The on_reject synthetic node must NOT produce a node_completed event with
    // step_name equal to the approval gate's own ID ('review'). If it did, a
    // subsequent resume would find the event via the DAG resume snapshot and
    // skip the approval gate entirely, bypassing the human gate.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    const completedStepNames = nodeCompletedEvents.map(
      (call: unknown[]) => (call[0] as Record<string, unknown>).step_name
    );
    expect(completedStepNames).not.toContain('review');

    // The synthetic on_reject node MUST produce a node_completed event with the
    // distinct ID 'review:on_reject'. This ensures the synthetic node itself is
    // recorded as completed so it is not re-run on a subsequent resume.
    expect(completedStepNames.filter((n: unknown) => n === 'review:on_reject').length).toBe(1);
  });

  it.each([false, true])(
    'preserves exhausted approval cancellation result (rollback=%s)',
    async rollback => {
      const store = createMockStore();
      if (rollback)
        store.cancelWorkflowRun = mock(async () => {
          throw new Error('approval cancellation rolled back');
        });
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();

      // rejection_count already at max_attempts
      const workflowRun = makeWorkflowRun('reject-exhausted-run', {
        metadata: {
          approval: {
            type: 'approval',
            nodeId: 'review',
            message: 'Approve this plan?',
            onRejectPrompt: 'Fix based on: $REJECTION_REASON',
            onRejectMaxAttempts: 3,
          },
          rejection_reason: 'Still not right',
          rejection_count: 3,
        },
      });

      const execution = executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-approval',
          cwd: testDir,
          workflow: {
            name: 'approval-exhausted',
            nodes: [
              {
                id: 'review',
                kind: 'gate',
                message: 'Approve this plan?',
                decisions: [
                  { id: 'approve' },
                  { id: 'reject', rework: { prompt: 'Fix: $REJECTION_REASON', maxAttempts: 3 } },
                ],
                captureResponse: false,
                decisionsAuthored: false,
              },
            ],
          },
          workflowRun,
        })
      );

      if (rollback) {
        await expect(execution).rejects.toThrow(
          'Failed to persist terminal workflow status: approval cancellation rolled back'
        );
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        return;
      }
      await execution;

      // AI should NOT have been called (max attempts reached, straight to cancel)
      expect(mockSendQueryDag.mock.calls.length).toBe(0);

      // cancelWorkflowRun should have been called
      const cancelCalls = store.cancelWorkflowRun.mock.calls;
      expect(cancelCalls.length).toBe(1);
      expect(store.cancelWorkflowRun).toHaveBeenCalledWith(workflowRun.id, {
        step_name: 'review',
        reason: 'max_attempts (3) exhausted',
        cancel_reason: 'approval_rejected',
      });

      // pauseWorkflowRun should NOT have been called
      const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
        .calls;
      expect(pauseCalls.length).toBe(0);
    }
  );

  it('on_reject with max_attempts: 1 cancels on first rejection', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('reject-max1-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 1,
        },
        rejection_reason: 'Bad',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval',
        cwd: testDir,
        workflow: {
          name: 'approval-max1',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve?',
              decisions: [
                { id: 'approve' },
                { id: 'reject', rework: { prompt: 'Fix: $REJECTION_REASON', maxAttempts: 1 } },
              ],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    // Should cancel immediately, no AI call
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect(store.cancelWorkflowRun.mock.calls.length).toBe(1);
  });

  it('approval message substitutes $nodeId.output.field references from upstream structured output', async () => {
    // Repro for: approval gates were rendering literal "$gather-context.output.repo_name"
    // instead of resolved values, breaking interactive workflows like atlas-onboard.
    // Parity: prompt/bash/loop/cancel nodes already get substituteNodeOutputRefs;
    // approval.message must too so the human sees concrete values.
    const structuredJson = {
      repo_name: 'hcr-els',
      app_code: 'CCELS',
      frontend_port: 3012,
    };

    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'gather-context.md'), 'Gather context: $USER_MESSAGE');

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: JSON.stringify(structuredJson) };
      yield { type: 'result', sessionId: 'sid-approval-sub', structuredOutput: structuredJson };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('approval-sub-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-approval-sub',
        cwd: testDir,
        workflow: {
          name: 'approval-sub-test',
          nodes: [
            {
              id: 'gather-context',
              kind: 'agent',
              source: { kind: 'command', name: 'gather-context' },
              output_format: {
                type: 'object',
                properties: {
                  repo_name: { type: 'string' },
                  app_code: { type: 'string' },
                  frontend_port: { type: 'number' },
                },
              },
            },
            {
              id: 'confirm',
              depends_on: ['gather-context'],
              kind: 'gate',
              message:
                'Repo: $gather-context.output.repo_name | App: $gather-context.output.app_code | Port: $gather-context.output.frontend_port',
              decisions: [{ id: 'approve' }, { id: 'reject' }],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun,
      })
    );

    // gather-context AI call ran once; approval node does NOT call AI
    expect(mockSendQueryDag.mock.calls.length).toBe(1);

    // pauseWorkflowRun should receive the SUBSTITUTED message, not the literal placeholders
    const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'confirm',
      message: 'Repo: hcr-els | App: CCELS | Port: 3012',
    });

    // The fix touches FOUR emission sites (safeSendMessage / createWorkflowEvent /
    // pauseWorkflowRun / event-emitter). Assert the other two reachable surfaces too —
    // a future regression at any one of them would otherwise pass this test silently.
    // (Per CodeRabbit review of PR coleam00/Archon#1426.)

    // (a) The chat-surface prompt emitted via platform.sendMessage must contain the
    //     substituted message and must NOT contain literal $gather-context.output refs.
    const sentMessages = (
      platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
    ).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentMessages.some(m => m.includes('Repo: hcr-els | App: CCELS | Port: 3012'))).toBe(
      true
    );
    expect(sentMessages.some(m => m.includes('$gather-context.output'))).toBe(false);

    // (b) The persisted approval_requested workflow event's data.message must be substituted.
    const approvalRequestedEvents = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === 'approval_requested'
    );
    expect(approvalRequestedEvents.length).toBe(1);
    expect(approvalRequestedEvents[0][0].data?.message).toBe(
      'Repo: hcr-els | App: CCELS | Port: 3012'
    );
  });

  describe('gate prompts spell commands for the surface', () => {
    // Mirrors the Slack adapter: its registered slash command is `/archon-workflow`.
    function slackPlatform(): MockWorkflowPlatform &
      Required<Pick<IWorkflowPlatform, 'formatWorkflowCommand'>> {
      return {
        ...createMockPlatform(),
        formatWorkflowCommand: (command: string) => `/archon-workflow ${command}`,
      };
    }

    function sentText(platform: MockWorkflowPlatform): string {
      return platform.sendMessage.mock.calls.map(([, message]) => message).join('\n');
    }

    function expectSlackSpelling(text: string): void {
      expect(text).toContain('/archon-workflow ');
      expect(text.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    }

    it('approval gate prompt', async () => {
      const platform = slackPlatform();
      const workflowRun = makeWorkflowRun('gate-run');

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          cwd: testDir,
          workflow: {
            name: 'approval-spelling',
            nodes: [
              {
                id: 'review',
                kind: 'gate',
                message: 'Approve this plan?',
                decisions: [{ id: 'approve' }, { id: 'reject' }],
                captureResponse: false,
                decisionsAuthored: false,
              },
            ],
          },
          workflowRun,
        })
      );

      const text = sentText(platform);
      expect(text).toContain('Approve: `/archon-workflow approve gate-run`');
      expect(text).toContain('Reject: `/archon-workflow reject gate-run`');
      expectSlackSpelling(text);
    });

    it('renders declared choices and emits the persisted vocabulary', async () => {
      const platform = slackPlatform();
      const deps = createMockDeps();
      const decisions = [
        { id: 'approve', label: 'Ship it' },
        { id: 'revise', label: 'Try again' },
        { id: 'cancel' },
      ];
      const emitted: WorkflowEmitterEvent[] = [];
      const unsubscribe = getWorkflowEventEmitter().subscribe(event => emitted.push(event));
      try {
        await executeDagWorkflow(
          dagOptions({
            deps,
            platform,
            cwd: testDir,
            workflowRun: makeWorkflowRun('gate-run'),
            workflow: {
              name: 'declared-choices',
              nodes: [
                {
                  id: 'review',
                  kind: 'gate',
                  message: 'Choose',
                  decisions,
                  decisionsAuthored: true,
                  captureResponse: false,
                },
              ],
            },
          })
        );
      } finally {
        unsubscribe();
      }
      const text = sentText(platform);
      expect(text).toContain('Ship it');
      expect(text).toContain(
        'Try again (revise): `/archon-workflow respond gate-run revise [text]`'
      );
      expect(text).toContain('cancel: `/archon-workflow respond gate-run cancel [text]`');
      expect(text).not.toContain('reject gate-run');
      const pause = deps.store.pauseWorkflowRun.mock.calls[0]?.[1];
      expect(emitted.find(event => event.type === 'approval_pending')).toMatchObject({
        decisions: pause?.decisions,
        pauseId: pause?.pauseId,
      });
      expect(pause?.decisions).toEqual(decisions);
    });

    it('interactive loop gate prompt', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Plan.' };
        yield { type: 'result', sessionId: 'loop-spelling' };
      });
      const platform = slackPlatform();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          cwd: testDir,
          workflow: {
            name: 'loop-spelling',
            nodes: [
              {
                id: 'refine',
                kind: 'loop',
                loop: {
                  fresh_context: false,
                  prompt: 'Refine.',
                  until: 'APPROVED',
                  max_iterations: 3,
                  interactive: true,
                  gate_message: 'Review.',
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('loop-run'),
        })
      );

      const text = sentText(platform);
      expect(text).toContain('`/archon-workflow approve loop-run <your feedback>`');
      expectSlackSpelling(text);
    });

    it('interactive loop_group gate prompt', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Draft.' };
        yield { type: 'result', sessionId: 'loop-group-spelling' };
      });
      const platform = slackPlatform();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          cwd: testDir,
          workflow: {
            name: 'loop-group-spelling',
            nodes: [
              {
                id: 'refine',
                kind: 'loop_group',
                loop_group: {
                  until: 'DONE',
                  max_iterations: 3,
                  interactive: true,
                  gate_message: 'Review.',
                  nodes: [
                    {
                      id: 'work',
                      kind: 'agent',
                      source: { kind: 'inline', prompt: 'draft' },
                    },
                  ],
                },
              },
            ] as DagNode[],
          },
          workflowRun: makeWorkflowRun('group-run'),
        })
      );

      const text = sentText(platform);
      expect(text).toContain('`/archon-workflow approve group-run <your feedback>`');
      expectSlackSpelling(text);
    });
  });
});

describe('executeDagWorkflow -- approval node inside an included block', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-inc-approval-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[]): WorkflowDefinition {
    return { name, description: name, nodes: nodes.map(n => dagNodeSchema.parse(n)) };
  }

  it('pauses at the namespaced approval id and exposes capture_response via it', async () => {
    const block = buildWf('apblk', [
      { id: 'approve', approval: { message: 'Approve this?', capture_response: true } },
    ]);
    // `interactive: true` because the block carries an approval gate: a composed gate the
    // top-level workflow cannot drive inline is a load error (#1764).
    const parent = {
      ...buildWf('apparent', [
        { id: 'setup', bash: 'echo setup' },
        { id: 'rev', include: 'apblk', depends_on: ['setup'] },
        // Reads the include's output; the block's sole sink is the approval node, so
        // $rev.output resolves to the captured response via the namespaced id.
        { id: 'after', bash: 'echo $rev.output', depends_on: ['rev'] },
      ]),
      interactive: true,
    };
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['apblk', block],
        ['apparent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const expanded = workflows.get('apparent')!;

    // capture_response (stored as $<approvalId>.output) is reachable via the namespaced id.
    const after = expanded.nodes.find(n => n.id === 'after');
    expect(after && 'script' in after ? after.script : '').toBe('echo $rev__approve.output');

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-approval-run', { workflow_name: 'apparent' });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc-approval',
        cwd: testDir,
        workflow: { name: 'apparent', nodes: expanded.nodes as DagNode[] },
        workflowRun,
      })
    );

    const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls;
    expect(pauseCalls.length).toBe(1);
    // The gate pauses under the namespaced approval id, not the bare block id.
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'rev__approve',
      message: 'Approve this?',
      captureResponse: true,
    });
  });

  it('the same approval block included twice yields distinct namespaced approval ids', () => {
    const block = buildWf('apblk', [
      { id: 'approve', approval: { message: 'Approve?', capture_response: false } },
    ]);
    const parent = {
      ...buildWf('apparent', [
        { id: 'a', include: 'apblk' },
        { id: 'b', include: 'apblk', depends_on: ['a'] },
      ]),
      interactive: true, // composed approval gate (#1764)
    };
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['apblk', block],
        ['apparent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    const ids = workflows.get('apparent')!.nodes.map(n => n.id);
    // Distinct ApprovalContext.nodeId per inclusion → no cross-talk between the two gates.
    expect(ids).toContain('a__approve');
    expect(ids).toContain('b__approve');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
