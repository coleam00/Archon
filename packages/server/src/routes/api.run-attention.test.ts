import {
  mockGetWorkflowRun,
  mockListAttentionQueueRows,
  mockListWorkflowEvents,
  mockGetConversationById,
  mockFindLatestEnvironment,
  mockLabelAttentionWait,
  MOCK_RUNNING_RUN,
  makeDashboardWorkflowRun,
  makeApp,
} from '../test/api-workflow-runs-harness';
import { describe, test, expect } from 'bun:test';
import type {
  WorkflowAttentionWaitContext,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import {
  workflowRunSchema as apiWorkflowRunSchema,
  runsNeedingAttentionResponseSchema,
} from './schemas/workflow.schemas';

test('the attention endpoint and detail expose the shared projection with wire dates', async () => {
  const run: WorkflowRun = {
    ...MOCK_RUNNING_RUN,
    status: 'paused',
    metadata: {
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'attention',
        waitingSince: '2026-10-12T00:00:00.000Z',
        message: 'Rotate key',
      },
    },
  };
  mockListAttentionQueueRows.mockImplementationOnce(async () => [makeDashboardWorkflowRun(run)]);
  mockGetWorkflowRun.mockImplementationOnce(async () => run);
  const { app } = makeApp();
  const list = await app.request('/api/runs/attention');
  expect(list.status).toBe(200);
  const body = runsNeedingAttentionResponseSchema.parse(await list.json());
  expect(body.runs[0]?.attention).toEqual({
    kind: 'attention',
    runId: run.id,
    nodeId: 'hold',
    occurrence: 'legacy:hold',
    message: 'Rotate key',
    form: 'message',
    options: [],
  });
  mockListWorkflowEvents.mockResolvedValueOnce([]);
  mockGetConversationById.mockResolvedValueOnce(null);
  const detail = await app.request(`/api/workflows/runs/${run.id}`);
  expect(detail.status).toBe(200);
  const detailBody = (await detail.json()) as { run: unknown };
  expect(apiWorkflowRunSchema.parse(detailBody.run).attention).toEqual(body.runs[0]?.attention);
});

describe('the attention queue over HTTP', () => {
  const waitFor = (id: string, labels: Record<string, string>): WorkflowAttentionWaitContext => ({
    owner: 'node',
    nodeId: 'ask',
    kind: 'attention',
    waitingSince: '2026-10-14T00:00:00.000Z',
    message: 'CI is red. Retry?',
    pauseId: `pause-${id}`,
    form: 'approval',
    labels,
  });
  const attentionRun = (id: string, labels: Record<string, string>): WorkflowRun => ({
    ...MOCK_RUNNING_RUN,
    id,
    status: 'paused',
    metadata: { wait: waitFor(id, labels) },
  });
  const other = attentionRun('run-other', { ci: 'other' });
  const pr = attentionRun('run-pr', { ci: 'pr' });

  test('lists typed items with the console rows, filtered by label, and counts by label', async () => {
    mockListAttentionQueueRows.mockImplementation(async () => [
      makeDashboardWorkflowRun(other),
      makeDashboardWorkflowRun(pr),
    ]);
    mockFindLatestEnvironment.mockImplementation(async () => ({ branch_name: 'fix/ci' }));
    try {
      const { app } = makeApp();
      const list = await app.request('/api/runs/attention?label=ci%3Dother');
      expect(list.status).toBe(200);
      const body = runsNeedingAttentionResponseSchema.parse(await list.json());
      expect(body.items.map(item => item.runId)).toEqual(['run-other']);
      expect(body.runs.map(run => run.id)).toEqual(['run-other']);
      expect(body.items[0]).toMatchObject({
        kind: 'attention',
        occurrence: 'pause-run-other',
        form: 'approval',
        labels: { ci: 'other' },
        revision: 1,
        fanOut: null,
        context: { workingPath: '/tmp/worktrees/feature', branch: 'fix/ci' },
      });

      const counts = await app.request('/api/runs/attention?countBy=label%3Aci');
      expect(await counts.json()).toEqual({
        counts: {
          by: 'label',
          key: 'ci',
          counts: [
            { value: 'other', count: 1 },
            { value: 'pr', count: 1 },
          ],
        },
      });
      const twice = await app.request('/api/runs/attention?label=ci%3Dother&label=ci%3Dpr');
      expect(twice.status).toBe(400);
      expect(await twice.json()).toMatchObject({ error: "Label 'ci' is given twice" });
      expect((await app.request('/api/runs/attention?sort=newest')).status).toBe(400);
      expect((await app.request('/api/runs/attention?sort=age&countBy=project')).status).toBe(400);
      expect((await app.request('/api/runs/attention?project=nowhere')).status).toBe(400);
    } finally {
      mockListAttentionQueueRows.mockReset();
      mockFindLatestEnvironment.mockReset();
    }
  });

  test('lists and reads each fan-out question by its child identity', async () => {
    const children = [0, 1].map(index => ({
      ...attentionRun(`child-${index}`, {}),
      parent_run_id: 'questions-parent',
      metadata: {
        parent_node_id: 'answers',
        child_index: index,
        wait: waitFor(`child-${index}`, {}),
      },
    }));
    mockListAttentionQueueRows.mockImplementation(async () =>
      children.map(makeDashboardWorkflowRun)
    );
    mockGetWorkflowRun.mockImplementation(async id => children.find(run => run.id === id) ?? null);
    try {
      const { app } = makeApp();
      const list = await app.request('/api/runs/attention');
      expect(list.status).toBe(200);
      const { items } = runsNeedingAttentionResponseSchema.parse(await list.json());
      expect(items.map(item => ({ runId: item.runId, fanOut: item.fanOut }))).toEqual(
        children.map((run, index) => ({
          runId: run.id,
          fanOut: { parentRunId: 'questions-parent', nodeId: 'answers', index },
        }))
      );
      for (const item of items) {
        expect(item.kind).toBe('attention');
        const read = await app.request(`/api/runs/${item.runId}/attention`);
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ item });
      }
    } finally {
      mockListAttentionQueueRows.mockReset();
      mockGetWorkflowRun.mockReset();
    }
  });

  test('reads one item, and refuses a stale label write with 409', async () => {
    mockGetWorkflowRun.mockImplementation(async id => (id === other.id ? other : null));
    try {
      const { app } = makeApp();
      const read = await app.request(`/api/runs/${other.id}/attention`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        item: { runId: other.id, labels: { ci: 'other' } },
      });
      expect((await app.request('/api/runs/missing/attention')).status).toBe(404);

      const label = (body: unknown): Promise<Response> =>
        Promise.resolve(
          app.request(`/api/runs/${other.id}/attention/labels`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        );
      const stale = await label({ occurrence: 'pause-old', set: { class: 'ci-other' } });
      expect(stale.status).toBe(409);
      expect(mockLabelAttentionWait).not.toHaveBeenCalled();

      mockLabelAttentionWait.mockImplementationOnce(async () => ({
        labeled: true,
        wait: { ...waitFor(other.id, { ci: 'other', class: 'ci-other' }), revision: 2 },
      }));
      const written = await label({ occurrence: `pause-${other.id}`, set: { class: 'ci-other' } });
      expect(written.status).toBe(200);
      expect(await written.json()).toEqual({
        runId: other.id,
        occurrence: `pause-${other.id}`,
        revision: 2,
        labels: { ci: 'other', class: 'ci-other' },
      });
      expect(mockLabelAttentionWait).toHaveBeenCalledWith(other.id, {
        pauseId: `pause-${other.id}`,
        set: { class: 'ci-other' },
        unset: [],
        via: 'api',
      });
    } finally {
      mockGetWorkflowRun.mockReset();
      mockLabelAttentionWait.mockReset();
    }
  });
});
