import {
  mockGetWorkflowRun,
  mockListWorkflowRuns,
  mockListDashboardRuns,
  mockGetWorkflowRunByWorkerPlatformId,
  mockListWorkflowEvents,
  mockListProviderEvents,
  mockGetConversationById,
  mockObserveRunOwner,
  type MockWorkflowRun,
  type MockWorkflowEvent,
  NOW_DATE,
  MOCK_RUNNING_RUN,
  MOCK_COMPLETED_RUN,
  MOCK_FAILED_RUN,
  makeDashboardWorkflowRun,
  MOCK_EVENTS,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import {
  RUN_GRAPH_METADATA_KEY,
  terminalRecordSchema,
} from '@archon/workflows/schemas/terminal-record';
import { buildTerminalRecord, observeRunArtifacts } from '@archon/workflows/terminal-record';
import { fanOutOutcome as fanOutOutcomeOf } from '@archon/workflows/schemas/fan-out-outcome';
import {
  nodeExecutionMetadataSchema,
  type NodeCostScope,
  type NodeExecutionMetadata,
} from '@archon/workflows/schemas/node-execution';
import {
  finishNodeExecution,
  newNodeInvocation,
  startNodeExecution,
} from '@archon/workflows/node-execution';
import { serializeNodeStateRecord } from '@archon/workflows/node-record-serialization';
import { describe, test, expect, beforeEach } from 'bun:test';
import { z } from '@hono/zod-openapi';
import type { ApprovalContext } from '@archon/workflows/schemas/workflow-run';
import type { ProviderEventRecord } from '@archon/workflows/schemas/provider-event';
import {
  dashboardWorkflowRunSchema as apiDashboardWorkflowRunSchema,
  workflowRunDetailSchema,
  workflowRunSchema as apiWorkflowRunSchema,
} from './schemas/workflow.schemas';
import { makeDashboardRunsResult } from '../test/workflow-mock-factories';

describe('workflow run API wait metadata', () => {
  const attentionWait = {
    owner: 'loop_group' as const,
    nodeId: 'recover-ci',
    bodyWaitId: 'pause',
    iteration: 14,
    sessionId: null,
    sessionProvider: null,
    kind: 'attention' as const,
    waitingSince: '2026-08-31T10:00:00.000Z',
    message: 'Re-run CI, then resume.',
  };

  test('projects the engine wait union through regular and dashboard run metadata', () => {
    const metadata = { wait: attentionWait, custom: 'preserved' };

    expect(apiWorkflowRunSchema.shape.metadata.parse(metadata)).toEqual(metadata);
    expect(apiDashboardWorkflowRunSchema.shape.metadata.parse(metadata)).toEqual(metadata);
  });

  test('rejects a malformed projected wait while leaving unrelated metadata open-ended', () => {
    expect(
      apiWorkflowRunSchema.shape.metadata.safeParse({
        wait: { ...attentionWait, waitingSince: undefined },
      }).success
    ).toBe(false);
    expect(apiWorkflowRunSchema.shape.metadata.parse({ custom: { nested: true } })).toEqual({
      custom: { nested: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockReset();
  });

  test('returns empty runs array when no runs exist', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(0);
  });

  test('returns list of workflow runs', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN, MOCK_COMPLETED_RUN]);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ id: string; outcome: 'succeeded' | 'failed' | null }>;
    };
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]?.id).toBe('run-uuid-1');
    expect(body.runs.map(run => run.outcome)).toEqual([null, 'failed']);
  });

  test('converts Date objects to ISO strings in response', async () => {
    const now = new Date('2025-06-01T12:00:00.000Z');
    mockListWorkflowRuns.mockImplementationOnce(async () => [
      {
        ...MOCK_RUNNING_RUN,
        started_at: now,
        completed_at: null,
        last_activity_at: undefined,
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ started_at: string; completed_at: null; last_activity_at: null }>;
    };
    expect(body.runs[0]?.started_at).toBe('2025-06-01T12:00:00.000Z');
    expect(body.runs[0]?.completed_at).toBeNull();
    expect(body.runs[0]?.last_activity_at).toBeNull();
  });

  test('filters by status query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN]);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=running');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBe('running');
  });

  test('ignores invalid status values', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=invalid_status');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by conversationId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?conversationId=conv-123');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.conversationId).toBe('conv-123');
  });

  test('filters by codebaseId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?codebaseId=cb-uuid-1');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.codebaseId).toBe('cb-uuid-1');
  });

  test('caps limit at 200', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?limit=9999');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('uses default limit of 50 when not specified', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.limit).toBe(50);
  });

  test('returns 500 when DB throws', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => {
      throw new Error('DB failure');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list workflow runs');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs/:runId
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs/:runId/provider-events', () => {
  const record: ProviderEventRecord = {
    runId: 'run-uuid-1',
    stepName: 'plan',
    attemptId: 'attempt-1',
    seq: 0,
    observedAt: '2026-10-02T10:00:00.000Z',
    event: {
      type: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      output: 'x'.repeat(16_384),
      outputTruncated: true,
    },
  };

  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockListProviderEvents.mockReset();
  });

  test('serves the store records unchanged, filtered by step and cursor', async () => {
    mockGetWorkflowRun.mockImplementation(async () => MOCK_RUNNING_RUN);
    mockListProviderEvents.mockImplementation(async () => [record]);
    const { app } = makeApp();

    const all = await app.request('/api/workflows/runs/run-uuid-1/provider-events');
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ events: [record] });
    expect(mockListProviderEvents).toHaveBeenLastCalledWith('run-uuid-1', { stepName: undefined });

    await app.request('/api/workflows/runs/run-uuid-1/provider-events?step=plan');
    expect(mockListProviderEvents).toHaveBeenLastCalledWith('run-uuid-1', { stepName: 'plan' });

    await app.request(
      '/api/workflows/runs/run-uuid-1/provider-events?step=plan&attemptId=attempt-1&afterSeq=3'
    );
    expect(mockListProviderEvents).toHaveBeenLastCalledWith('run-uuid-1', {
      stepName: 'plan',
      after: { attemptId: 'attempt-1', seq: 3 },
    });
  });

  test('rejects a half-given cursor and a cursor without a step', async () => {
    mockGetWorkflowRun.mockImplementation(async () => MOCK_RUNNING_RUN);
    const { app } = makeApp();
    for (const query of [
      'step=plan&attemptId=attempt-1',
      'step=plan&afterSeq=1',
      'attemptId=attempt-1&afterSeq=1',
      'step=plan&attemptId=attempt-1&afterSeq=-1',
    ]) {
      const response = await app.request(`/api/workflows/runs/run-uuid-1/provider-events?${query}`);
      expect(response.status).toBe(400);
    }
    expect(mockListProviderEvents).not.toHaveBeenCalled();
  });

  test('returns 404 for an unknown run', async () => {
    mockGetWorkflowRun.mockImplementation(async () => null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/missing/provider-events');
    expect(response.status).toBe(404);
  });
});

describe('GET /api/workflows/runs/:runId', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockListWorkflowEvents.mockReset();
    mockGetConversationById.mockReset();
  });

  const approvalContexts: ApprovalContext[] = [
    { nodeId: 'gate', message: 'Choose' },
    {
      nodeId: 'gate',
      message: 'Choose',
      decisionsAuthored: true,
      decisions: [
        { id: 'accept', label: 'Accept plan' },
        { id: 'revise', label: 'Revise plan' },
      ],
    },
  ];

  test.each(approvalContexts)(
    'projects engine-owned decisions without changing persisted metadata: %j',
    async approval => {
      const run = { ...MOCK_RUNNING_RUN, status: 'paused' as const, metadata: { approval } };
      mockGetWorkflowRun.mockImplementationOnce(async () => run);
      mockListWorkflowEvents.mockImplementationOnce(async () => []);
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${run.id}`);
      expect(response.status).toBe(200);
      const body = z.object({ run: apiWorkflowRunSchema }).parse(await response.json());
      expect(body.run.metadata.approval?.decisions).toEqual(getApprovalDecisions(approval));
      expect(run.metadata.approval).toEqual(approval);
      if (!('decisions' in approval)) expect(run.metadata.approval).not.toHaveProperty('decisions');
    }
  );

  test('returns run with events for a known runId', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () => MOCK_EVENTS);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'web-conv-abc',
      platform_type: 'web',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: { id: string; workflow_name: string };
      events: Array<{ event_type: string }>;
    };
    expect(body.run.id).toBe('run-uuid-1');
    expect(body.run.workflow_name).toBe('deploy');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(3);
    expect(body.events[0]?.event_type).toBe('step_started');
    // Provider activity has its own route; the detail payload leaves it out.
    expect(mockListWorkflowEvents).toHaveBeenCalledWith('run-uuid-1', {
      excludeEventTypes: expect.arrayContaining(['provider_event', 'tool_called']),
    });
  });

  test('exposes the persisted terminal record and suppresses it during resumed execution', async () => {
    const terminalRecord = terminalRecordSchema.parse({
      run_id: MOCK_FAILED_RUN.id,
      status: 'failed',
      outcome: null,
      error: 'producer failed',
      first_failed_node: 'producer',
      nodes: [{ node_id: 'producer', state: 'failed', error: 'producer failed' }],
      returns: { availability: 'unavailable', node_id: 'producer', reason: 'node_not_completed' },
      artifacts: {
        root: '/deleted/artifacts',
        files: [{ path: 'discoveries/finding.md', size: 7 }],
        limitations: [],
      },
    });
    for (const status of ['failed', 'running'] as const) {
      mockGetWorkflowRun.mockImplementationOnce(async () => ({ ...MOCK_FAILED_RUN, status }));
      mockListWorkflowEvents.mockImplementationOnce(async () => [
        {
          id: 'terminal-event',
          workflow_run_id: MOCK_FAILED_RUN.id,
          event_type: 'workflow_failed',
          step_index: null,
          step_name: null,
          data: { terminal_record: terminalRecord },
          created_at: new Date().toISOString(),
        },
      ]);
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${MOCK_FAILED_RUN.id}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { run: { terminal_record: unknown } };
      expect(body.run.terminal_record).toEqual(status === 'failed' ? terminalRecord : null);
    }
  });

  test('historical terminal runs have no fabricated record', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_FAILED_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    const { app } = makeApp();
    const response = await app.request(`/api/workflows/runs/${MOCK_FAILED_RUN.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { terminal_record: unknown } };
    expect(body.run.terminal_record).toBeNull();
  });

  describe('serves the engine node states the console renders', () => {
    // The #3544 workflow: `prepare` is always_run, `flaky` fails on its first try.
    const graphRun = {
      ...MOCK_FAILED_RUN,
      metadata: { [RUN_GRAPH_METADATA_KEY]: { node_ids: ['prepare', 'flaky'] } },
    };
    let seq = 0;
    const event = (event_type: string, step_name: string | null, data = {}): MockWorkflowEvent => ({
      id: `event-${++seq}`,
      workflow_run_id: graphRun.id,
      event_type,
      step_index: null,
      step_name,
      data,
      created_at: NOW_DATE.toISOString(),
    });
    const firstAttemptThenResetOnResume = (): MockWorkflowEvent[] => [
      event('node_started', 'prepare'),
      event('node_completed', 'prepare'),
      event('node_started', 'flaky'),
      event('node_failed', 'flaky', { error: 'flaky failed' }),
      event('workflow_failed', null),
      event('workflow_resumed', null),
      event('workflow_started', null),
      event('node_always_run_reset', 'prepare'),
    ];
    async function getNodes(run: MockWorkflowRun, events: MockWorkflowEvent[]) {
      mockGetWorkflowRun.mockImplementationOnce(async () => run);
      mockListWorkflowEvents.mockImplementationOnce(async () => events);
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/${run.id}`);
      expect(response.status).toBe(200);
      return (
        (await response.json()) as {
          run: { nodes: unknown; terminal_record: { nodes: unknown } | null };
        }
      ).run;
    }

    test('a node reset on resume is pending while the resumed run is active', async () => {
      const events = firstAttemptThenResetOnResume();
      const run = await getNodes({ ...graphRun, status: 'running' }, events);
      expect(run.terminal_record).toBeNull();
      expect(run.nodes).toEqual([
        { node_id: 'prepare', state: 'pending' },
        { node_id: 'flaky', state: 'failed', error: 'flaky failed' },
      ]);
      const record = buildTerminalRecord({
        run: graphRun,
        events,
        artifacts: await observeRunArtifacts(graphRun),
      });
      expect(run.nodes).toEqual(record.nodes);
    });

    test('a resumed node whose re-run fails is failed, as the terminal record says', async () => {
      const events = [
        ...firstAttemptThenResetOnResume(),
        event('node_started', 'prepare'),
        event('node_failed', 'prepare', { error: 'prepare failed' }),
      ];
      const record = buildTerminalRecord({
        run: graphRun,
        events,
        artifacts: await observeRunArtifacts(graphRun),
      });
      const run = await getNodes(graphRun, [
        ...events,
        event('workflow_failed', null, { terminal_record: record }),
      ]);
      expect(run.terminal_record?.nodes).toEqual(record.nodes);
      expect(run.nodes).toEqual(record.nodes);
      expect(run.nodes).toContainEqual({
        node_id: 'prepare',
        state: 'failed',
        error: 'prepare failed',
      });
    });

    test("serves a fan-out node's slot record on the node and in the terminal record", async () => {
      const fanOutOutcome = fanOutOutcomeOf([
        { index: 0, outcome: 'completed', child_run_id: 'child-a' },
        { index: 1, outcome: 'failed', child_run_id: 'child-b', error: 'exit 1' },
      ]);
      const events = [
        event('node_started', 'flaky'),
        event('node_completed', 'flaky', {
          node_output: '[]',
          fan_out: true,
          fan_out_outcome: fanOutOutcome,
        }),
      ];
      const record = buildTerminalRecord({
        run: graphRun,
        events,
        artifacts: await observeRunArtifacts(graphRun),
      });
      const run = await getNodes(graphRun, [
        ...events,
        event('workflow_failed', null, { terminal_record: record }),
      ]);
      expect(run.nodes).toContainEqual({
        node_id: 'flaky',
        state: 'completed',
        fan_out_outcome: fanOutOutcome,
      });
      expect(run.terminal_record?.nodes).toEqual(run.nodes);
    });

    test('a run recorded before terminal records still lists its nodes', async () => {
      const run = await getNodes(MOCK_FAILED_RUN, [
        event('node_started', 'build'),
        event('node_completed', 'build'),
      ]);
      expect(run.terminal_record).toBeNull();
      expect(run.nodes).toEqual([{ node_id: 'build', state: 'completed' }]);
    });
  });

  test("serves each cost row with the engine's cost scope", async () => {
    const expected = {
      node: 'own',
      aggregate: 'total',
      instance: 'total',
      amendment: 'total',
    } satisfies Record<NodeExecutionMetadata['accounting'], NodeCostScope>;
    const rows: { data: Record<string, unknown>; scope: NodeCostScope | undefined }[] = [
      ...nodeExecutionMetadataSchema.shape.accounting.options.map(accounting => ({
        data: serializeNodeStateRecord(
          finishNodeExecution(
            startNodeExecution({
              runId: MOCK_FAILED_RUN.id,
              path: accounting,
              node: { id: accounting, kind: 'agent', source: { kind: 'inline', prompt: 'work' } },
              invocation: newNodeInvocation(),
              provider: 'claude',
              accounting,
            }),
            { status: 'completed' },
            { costUsd: 0.01 }
          )
        ).data,
        scope: expected[accounting],
      })),
      // Rows written before `accounting` existed.
      { data: { cost_usd: 0.01, aggregate: true }, scope: 'total' },
      { data: { cost_usd: 0.01 }, scope: 'own' },
      // No cost, so no scope.
      { data: {}, scope: undefined },
    ];
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_FAILED_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () =>
      rows.map(({ data }, index) => ({
        id: `event-${index}`,
        workflow_run_id: MOCK_FAILED_RUN.id,
        event_type: 'cost_usd' in data ? 'node_completed' : 'node_started',
        step_index: null,
        step_name: `node-${index}`,
        data,
        created_at: NOW_DATE.toISOString(),
      }))
    );
    const { app } = makeApp();
    const response = await app.request(`/api/workflows/runs/${MOCK_FAILED_RUN.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: { cost_scope?: NodeCostScope }[] };
    expect(body.events.map(event => event.cost_scope)).toEqual(rows.map(row => row.scope));
    expect(body.events.at(-1)).not.toHaveProperty('cost_scope');
  });

  test('does not disguise an event query failure as an absent terminal record', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_FAILED_RUN);
    mockListWorkflowEvents.mockRejectedValueOnce(new Error('storage unavailable'));
    const { app } = makeApp();
    const response = await app.request(`/api/workflows/runs/${MOCK_FAILED_RUN.id}`);
    expect(response.status).toBe(500);
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run-id');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns authored outcome independently from failed lifecycle status', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_FAILED_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'web-conv-abc',
      platform_type: 'web',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { status: string; outcome: string | null };
    };
    expect(body.run).toMatchObject({ status: 'failed', outcome: 'succeeded' });
  });

  test('includes conversation_platform_id for CLI runs (no parent_conversation_id)', async () => {
    // CLI run: conversation_id set, no parent_conversation_id
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      parent_conversation_id: null,
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'cli-conv-xyz',
      platform_type: 'cli',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        conversation_platform_id: string | null;
        worker_platform_id: string | undefined;
      };
    };
    // CLI run: conversation_platform_id should be set, worker_platform_id should be undefined
    expect(body.run.conversation_platform_id).toBe('cli-conv-xyz');
    expect(body.run.worker_platform_id).toBeUndefined();
  });

  test('includes worker_platform_id for web runs (with parent_conversation_id)', async () => {
    // Web run: conversation_id is the worker, parent_conversation_id is the parent
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      parent_conversation_id: 'parent-conv-uuid',
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    // First call: worker conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'worker-platform-id',
      platform_type: 'web',
    }));
    // Second call: parent conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'parent-platform-id',
      platform_type: 'web',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        worker_platform_id: string | undefined;
        parent_platform_id: string | undefined;
        conversation_platform_id: string | null;
      };
    };
    expect(body.run.worker_platform_id).toBe('worker-platform-id');
    expect(body.run.parent_platform_id).toBe('parent-platform-id');
  });

  test('returns run with null conversation fields when no conversation_id', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      conversation_id: null,
      parent_conversation_id: null,
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: { conversation_platform_id: null };
    };
    expect(body.run.conversation_platform_id).toBeNull();
  });

  test('returns 500 when DB throws', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => {
      throw new Error('DB timeout');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get workflow run');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/dashboard/runs
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/runs', () => {
  beforeEach(() => {
    mockListDashboardRuns.mockReset();
  });

  test('projects legacy decisions on dashboard runs from the engine owner', async () => {
    const approval = { nodeId: 'gate', message: 'Choose' };
    mockListDashboardRuns.mockImplementationOnce(async () =>
      makeDashboardRunsResult({
        runs: [
          makeDashboardWorkflowRun({
            ...MOCK_RUNNING_RUN,
            status: 'paused',
            metadata: { approval },
          }),
        ],
      })
    );
    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(200);
    const body = z
      .object({ runs: z.array(apiDashboardWorkflowRunSchema) })
      .parse(await response.json());
    expect(body.runs[0]?.metadata.approval?.decisions).toEqual(getApprovalDecisions({}));
    expect(approval).not.toHaveProperty('decisions');
  });

  test("serves each run's owner observation on the dashboard list and the run detail", async () => {
    mockObserveRunOwner.mockImplementation(async (_store, run) =>
      run.status === 'running' ? 'unreachable' : null
    );
    try {
      mockListDashboardRuns.mockImplementationOnce(async () =>
        makeDashboardRunsResult({
          runs: [
            makeDashboardWorkflowRun(MOCK_RUNNING_RUN),
            makeDashboardWorkflowRun(MOCK_COMPLETED_RUN),
          ],
        })
      );
      mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
      mockListWorkflowEvents.mockImplementationOnce(async () => []);
      const { app } = makeApp();

      const list = z
        .object({ runs: z.array(apiDashboardWorkflowRunSchema) })
        .parse(await (await app.request('/api/dashboard/runs')).json());
      expect(list.runs.map(run => run.owner_observation)).toEqual(['unreachable', null]);
      const detail = workflowRunDetailSchema.parse(
        await (await app.request(`/api/workflows/runs/${MOCK_RUNNING_RUN.id}`)).json()
      );
      expect(detail.run).toMatchObject({ status: 'running', owner_observation: 'unreachable' });
    } finally {
      mockObserveRunOwner.mockImplementation(async () => null);
    }
  });

  test('returns paginated runs with total and counts', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () =>
      makeDashboardRunsResult({
        runs: [
          {
            ...makeDashboardWorkflowRun(MOCK_RUNNING_RUN),
            active_nodes: ['parallel-a', 'parallel-b'],
          },
          makeDashboardWorkflowRun(MOCK_COMPLETED_RUN),
        ],
        total: 2,
        counts: { all: 5, running: 1, completed: 2, failed: 1, cancelled: 1 },
      })
    );

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ status: string; outcome: string | null; active_nodes: string[] }>;
      total: number;
      counts: { all: number };
    };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]?.active_nodes).toEqual(['parallel-a', 'parallel-b']);
    expect(body.runs[1]).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(body.total).toBe(2);
    expect(body.counts.all).toBe(5);
  });

  test('filters by status query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=running');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBe('running');
  });

  test('accepts paused as valid status', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=paused');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBe('paused');
  });

  test('ignores invalid status values in dashboard runs', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=bogus');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by codebaseId query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?codebaseId=cb-1');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.codebaseId).toBe('cb-1');
  });

  test('filters by search query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?search=deploy');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.search).toBe('deploy');
  });

  test('supports after and before date filters', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?after=2024-01-01T00:00:00Z&before=2024-12-31T23:59:59Z');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.after).toBe('2024-01-01T00:00:00Z');
    expect(callArgs?.before).toBe('2024-12-31T23:59:59Z');
  });

  test('caps limit at 200', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?limit=9999');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('supports offset for pagination', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?offset=50');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.offset).toBe(50);
  });

  test('returns 500 when DB throws', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => {
      throw new Error('query timeout');
    });

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list dashboard runs');
  });
});

describe('GET /api/workflows/runs/by-worker/:platformId', () => {
  beforeEach(() => {
    mockGetWorkflowRunByWorkerPlatformId.mockReset();
  });

  test('returns run when found', async () => {
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/some-platform-id');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { status: string; outcome: string | null };
    };
    expect(body.run).toMatchObject({ status: 'completed', outcome: 'failed' });
  });

  test('returns 404 when not found', async () => {
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/unknown-id');
    expect(response.status).toBe(404);
  });
});
