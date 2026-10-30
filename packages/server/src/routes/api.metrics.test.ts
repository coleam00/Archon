import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { MetricsStore } from '@archon/workflows/metrics';
import { metricsReportSchema } from './schemas/metrics.schemas';
import { registerMetricsRoute } from './api.metrics';

const row = {
  eventId: 'event-1',
  runId: 'run-1',
  runStartedAt: new Date('2026-10-20T00:00:00Z'),
  workflowName: 'count-prs',
  codebaseId: null,
  nodeId: 'count',
  completedAt: '2026-10-20T01:00:00.000Z',
  metrics: [{ name: 'factory.prs_merged', kind: 'count', unit: 'prs', value: 3, subject: null }],
};

const store: MetricsStore = {
  listMetricRecords: async () => [row],
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

function app(): OpenAPIHono {
  const app = new OpenAPIHono();
  registerMetricsRoute(app, store);
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

  test('a malformed since returns 400', async () => {
    const response = await app().request('/api/metrics?since=yesterday');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('since must be');
  });
});
