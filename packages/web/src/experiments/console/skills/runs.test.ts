import { afterEach, describe, expect, test } from 'bun:test';
import type { components } from '@/lib/api.generated';
import { detailFixture, terminalRecord } from '../primitives/run.test-fixtures';
import { toRun } from '../primitives/run';
import { getRun, listRuns, respondRun } from './runs';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(payload: unknown): void {
  globalThis.fetch = Object.assign(() => Promise.resolve(Response.json(payload)), {
    preconnect: originalFetch.preconnect,
  });
}

describe('run responses', () => {
  test('getRun preserves succeeded terminal returns', async () => {
    const response: components['schemas']['WorkflowRunDetail'] = {
      ...detailFixture,
      run: {
        ...detailFixture.run,
        outcome: 'succeeded',
        terminal_record: terminalRecord(
          {
            availability: 'available',
            node_id: 'result',
            value: { rationale: 'The change is delivered.' },
          },
          'succeeded'
        ),
      },
    };
    respond(response);
    const detail = await getRun('run-1');
    expect(detail.run.outcome).toBe('succeeded');
    expect(detail.run.terminalRecord).toEqual(response.run.terminal_record);
  });

  test('getRun preserves terminal returns, engine nodes and normalized events', async () => {
    respond(detailFixture);
    const detail = await getRun('run-1');
    expect(detail.run).toMatchObject({
      status: 'completed',
      outcome: 'failed',
      terminalRecord: detailFixture.run.terminal_record,
    });
    expect(detail.nodes).toEqual(detailFixture.run.nodes);
    expect(detail.events).toMatchObject([
      { id: 'event-1', runId: 'run-1', kind: 'node_transition', transition: 'completed' },
    ]);
  });

  test('listRuns retains dashboard enrichment without a terminal record', async () => {
    const { terminal_record, ...dashboardRun } = detailFixture.run;
    void terminal_record;
    const response: components['schemas']['DashboardRunsResponse'] = {
      runs: [
        {
          ...dashboardRun,
          codebase_name: 'Archon',
          platform_type: 'cli',
          worker_platform_id: null,
          parent_platform_id: null,
          active_nodes: ['a', 'b'],
          current_step_name: null,
          total_steps: null,
          current_step_status: null,
          agents_completed: null,
          agents_failed: null,
          agents_total: null,
        },
      ],
      total: 1,
      counts: { all: 1, running: 0, completed: 1, failed: 0, cancelled: 0, pending: 0, paused: 0 },
    };
    respond(response);
    const result = await listRuns();
    expect(result.runs[0]).toMatchObject({
      projectName: 'Archon',
      origin: 'cli',
      activeNodes: ['a', 'b'],
      workerPlatformId: null,
      terminalRecord: null,
    });
    expect(result.counts).toEqual(response.counts);
    expect(result.total).toBe(1);
  });
});

describe('respondRun', () => {
  test('sends the displayed API occurrence and optional text unchanged', async () => {
    const run = toRun({
      id: 'review-run',
      workflow_name: 'review',
      codebase_id: null,
      status: 'paused',
      started_at: '2026-10-05T10:00:00Z',
      metadata: {
        approval: {
          nodeId: 'review-gate',
          pauseId: 'pause-before',
          message: 'Review',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    globalThis.fetch = ((url, init) => {
      expect(url).toBe('/api/workflows/runs/review-run/respond');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        decision: 'revise',
        text: 'Keep this feedback',
        expectedGate: { nodeId: 'review-gate', pauseId: 'pause-before' },
      });
      return Promise.resolve(Response.json({ success: true }));
    }) as typeof fetch;
    const approval = run.approval;
    if (approval?.pauseId === undefined) throw new Error('Missing displayed pause identity');
    await respondRun(run.id, 'revise', 'Keep this feedback', {
      nodeId: approval.nodeId,
      pauseId: approval.pauseId,
    });
  });

  test('preserves manual and legacy calls without an expected occurrence', async () => {
    globalThis.fetch = ((_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ decision: 'approve' });
      return Promise.resolve(Response.json({ success: true }));
    }) as typeof fetch;
    await respondRun('legacy-run', 'approve');
  });
});
