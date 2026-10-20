import {
  mockGetWorkflowRun,
  mockListWorkflowRuns,
  mockListDashboardRuns,
  mockGetWorkflowRunByWorkerPlatformId,
  mockListWorkflowEvents,
  mockGetConversationById,
  MOCK_COMPLETED_RUN,
  makeDashboardWorkflowRun,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { expect, test } from 'bun:test';
import { workflowRunUsageSchema } from '@archon/workflows/schemas/workflow-run-usage';
import { makeDashboardRunsResult } from '../test/workflow-mock-factories';
import {
  dashboardRunsResponseSchema,
  workflowRunByWorkerResponseSchema,
  workflowRunDetailSchema,
  workflowRunListResponseSchema,
} from './schemas/workflow.schemas';

const cases = [
  { name: 'absent', usage: {}, expected: {} },
  {
    name: 'historical values',
    usage: Object.fromEntries(
      Object.keys(workflowRunUsageSchema.shape).map(key => [key, 'unknown'])
    ),
    expected: {},
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
  test(`run responses conform to their usage contracts with ${name}`, async () => {
    const metadata = { ...usage, custom: { preserved: true } };
    const original = structuredClone(metadata);
    const run = { ...MOCK_COMPLETED_RUN, conversation_id: null, metadata };
    mockListWorkflowRuns.mockResolvedValueOnce([run]);
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    mockListWorkflowEvents.mockResolvedValueOnce([]);
    mockGetConversationById.mockResolvedValueOnce(null);
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(run);
    mockListDashboardRuns.mockResolvedValueOnce(
      makeDashboardRunsResult({ runs: [makeDashboardWorkflowRun(run)] })
    );
    const { app } = makeApp();
    const list = await app.request('/api/workflows/runs');
    const detail = await app.request(`/api/workflows/runs/${run.id}`);
    const worker = await app.request('/api/workflows/runs/by-worker/worker-id');
    const dashboard = await app.request('/api/dashboard/runs');
    for (const response of [list, detail, worker, dashboard]) expect(response.status).toBe(200);
    const runs = [
      ...workflowRunListResponseSchema.parse(await list.json()).runs,
      workflowRunDetailSchema.parse(await detail.json()).run,
      workflowRunByWorkerResponseSchema.parse(await worker.json()).run,
      ...dashboardRunsResponseSchema.parse(await dashboard.json()).runs,
    ];
    expect(runs).toHaveLength(4);
    for (const result of runs) {
      expect(result.metadata).toEqual({ ...expected, custom: { preserved: true } });
    }
    expect(metadata).toEqual(original);
  });
}
