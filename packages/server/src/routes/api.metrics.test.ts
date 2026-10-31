import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { MetricsStore } from '@archon/workflows/metrics';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { metricsReportSchema } from './schemas/metrics.schemas';
import { registerMetricsRoute } from './api.metrics';

const row = {
  eventId: 'event-1',
  runId: 'run-1',
  workflowName: 'count-prs',
  codebaseId: null,
  nodeId: 'count',
  nodeType: 'bash',
  completedAt: '2026-10-20T01:00:00.000Z',
  metrics: [{ name: 'factory.prs_merged', kind: 'count', unit: 'prs', value: 3, subject: null }],
};

const store: MetricsStore = {
  listMetricRecords: async () => [row],
  getWorkflowRunsByIds: async () => [],
  listWorkflowRuns: async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, pending: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 },
  }),
  listEventsForRuns: async ids =>
    new Map(
      ids.map(id => [
        id,
        [
          {
            id: row.eventId,
            workflow_run_id: id,
            event_type: 'node_completed',
            step_index: null,
            step_name: row.nodeId,
            data: {},
            created_at: row.completedAt,
          },
        ],
      ])
    ),
};

const run: WorkflowRun = {
  origin: { conversationId: 'conv-1' },
  id: row.runId,
  workflow_name: row.workflowName,
  conversation_id: 'conv-1',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'completed',
  outcome: null,
  user_message: '',
  metadata: {},
  started_at: new Date('2026-10-20T00:00:00.000Z'),
  completed_at: null,
  last_activity_at: null,
  working_path: null,
  user_id: null,
  parent_run_id: null,
  output_root: null,
  checkout_baseline: null,
  adopted_from_run_id: null,
};

function app(overrides: Partial<MetricsStore> = {}): OpenAPIHono {
  const app = new OpenAPIHono();
  registerMetricsRoute(app, { ...store, ...overrides });
  return app;
}

describe('GET /api/metrics', () => {
  test('returns the report from the store in the served schema', async () => {
    const response = await app().request('/api/metrics?since=2026-10-01&until=2026-10-30');
    expect(response.status).toBe(200);
    const report = metricsReportSchema.parse(await response.json());
    expect(report.window).toEqual({
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-30T00:00:00.000Z',
    });
    expect(report.metrics.map(m => [m.name, m.instruments[0]?.value])).toEqual([
      ['factory.prs_merged', 3],
    ]);
  });

  test('subject narrows the report to that subject', async () => {
    const response = await app().request(
      '/api/metrics?since=2026-10-01&until=2026-10-30&subject=pr-1'
    );
    expect(response.status).toBe(200);
    expect(metricsReportSchema.parse(await response.json()).metrics).toEqual([]);
  });

  test('compare splits each group at the cut', async () => {
    const response = await app().request(
      '/api/metrics?since=2026-10-01&until=2026-10-30&compare=2026-10-15'
    );
    expect(response.status).toBe(200);
    const [instrument] =
      metricsReportSchema.parse(await response.json()).metrics[0]?.instruments ?? [];
    expect(instrument?.compare).toMatchObject({
      at: '2026-10-15T00:00:00.000Z',
      before: { n: 0 },
      after: { n: 0 },
      unattributed: 1,
    });
  });

  test('a malformed compare returns 400', async () => {
    const response = await app().request('/api/metrics?compare=last-release');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('compare must be');
  });

  test('compare with byModel returns 400', async () => {
    const response = await app().request('/api/metrics?compare=2026-10-15&byModel=review');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('cannot be combined');
  });

  test('a byModel node no producing run ran returns 400 with the nodes they ran', async () => {
    const response = await app({ getWorkflowRunsByIds: async () => [run] }).request(
      '/api/metrics?since=2026-10-01&until=2026-10-30&byModel=review'
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      'no producing run ran an AI node "review"; AI nodes they ran: none'
    );
  });

  test('a malformed since returns 400', async () => {
    const response = await app().request('/api/metrics?since=yesterday');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('since must be');
  });
});
