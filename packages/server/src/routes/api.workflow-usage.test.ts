import {
  mockGetWorkflowRun,
  mockListWorkflowRuns,
  mockFindOpenWorkRuns,
  mockListAttentionQueueRows,
  mockListDashboardRuns,
  mockGetWorkflowRunByWorkerPlatformId,
  mockListWorkflowEvents,
  mockGetConversationById,
  MOCK_COMPLETED_RUN,
  makeDashboardWorkflowRun,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { expect, test } from 'bun:test';
import type { z } from '@hono/zod-openapi';
import { makeDashboardRunsResult } from '../test/workflow-mock-factories';
import {
  dashboardRunsResponseSchema,
  workflowRunByWorkerResponseSchema,
  workflowRunDetailSchema,
  workflowRunListResponseSchema,
  workflowRunMetadataSchema,
  runsNeedingAttentionResponseSchema,
} from './schemas/workflow.schemas';

const cases: {
  name: string;
  usage: Record<string, unknown>;
  expected: z.infer<typeof workflowRunMetadataSchema>;
}[] = [
  { name: 'absent', usage: {}, expected: {} },
  {
    name: 'historical values',
    usage: Object.fromEntries(
      Object.keys(workflowRunMetadataSchema.shape).map(key => [key, 'unknown'])
    ),
    expected: {},
  },
  {
    name: 'malformed nested engine metadata',
    usage: {
      approval: { nodeId: 'gate', message: 'Choose', iteration: 'invalid' },
      wait: { owner: 'node', kind: 'attention', nodeId: 42 },
      tool_call_attention: [{}],
      stop_reason: { reason: 'legacy' },
      total_tokens_out: 42,
    },
    expected: { total_tokens_out: 42 },
  },
  {
    name: 'valid engine metadata and legacy approval normalization',
    usage: {
      approval: { nodeId: 'gate', message: 'Choose' },
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'attention',
        waitingSince: '2026-10-12T00:00:00.000Z',
        message: 'Continue?',
      },
      tool_call_attention: [],
      stop_reason: { reason: 'node_error' },
    },
    expected: {
      approval: {
        nodeId: 'gate',
        message: 'Choose',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
      },
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'attention',
        waitingSince: '2026-10-12T00:00:00.000Z',
        message: 'Continue?',
      },
      tool_call_attention: [],
      stop_reason: { reason: 'node_error' },
    },
  },
  {
    name: 'mixed historical and reported values',
    usage: { total_cost_usd: 'free', total_tokens_in: 'unknown', total_tokens_out: 42 },
    expected: { total_tokens_out: 42 },
  },
  {
    name: 'reported values including zero and null',
    usage: {
      total_cost_usd: 0,
      total_tokens_in: 100,
      total_tokens_out: null,
      total_tokens_unknown: true,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: null,
      total_cache_partial: false,
    },
    expected: {
      total_cost_usd: 0,
      total_tokens_in: 100,
      total_tokens_out: null,
      total_tokens_unknown: true,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: null,
      total_cache_partial: false,
    },
  },
];

for (const { name, usage, expected } of cases) {
  test(`run responses conform to their metadata contracts with ${name}`, async () => {
    const metadata = { ...usage, custom: { preserved: true } };
    const original = structuredClone(metadata);
    const run = { ...MOCK_COMPLETED_RUN, conversation_id: null, metadata };
    mockListWorkflowRuns.mockResolvedValueOnce([run]);
    mockFindOpenWorkRuns.mockResolvedValueOnce([run]);
    const pausedRun = { ...run, status: 'paused' as const };
    mockListAttentionQueueRows.mockResolvedValueOnce([makeDashboardWorkflowRun(pausedRun)]);
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    mockListWorkflowEvents.mockResolvedValueOnce([]);
    mockGetConversationById.mockResolvedValueOnce(null);
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(run);
    mockListDashboardRuns.mockResolvedValueOnce(
      makeDashboardRunsResult({ runs: [makeDashboardWorkflowRun(run)] })
    );
    const { app } = makeApp();
    const list = await app.request('/api/workflows/runs');
    const open = await app.request('/api/workflows/runs?open=true');
    const attention = await app.request('/api/runs/attention');
    const detail = await app.request(`/api/workflows/runs/${run.id}`);
    const worker = await app.request('/api/workflows/runs/by-worker/worker-id');
    const dashboard = await app.request('/api/dashboard/runs');
    for (const response of [list, open, attention, detail, worker, dashboard]) {
      expect(response.status).toBe(200);
    }
    const runs = [
      ...workflowRunListResponseSchema.parse(await list.json()).runs,
      ...workflowRunListResponseSchema.parse(await open.json()).runs,
      ...runsNeedingAttentionResponseSchema.parse(await attention.json()).runs,
      workflowRunDetailSchema.parse(await detail.json()).run,
      workflowRunByWorkerResponseSchema.parse(await worker.json()).run,
      ...dashboardRunsResponseSchema.parse(await dashboard.json()).runs,
    ];
    expect(runs).toHaveLength(6);
    for (const result of runs) {
      expect(result.metadata).toEqual({ ...expected, custom: { preserved: true } });
    }
    expect(metadata).toEqual(original);
  });
}
