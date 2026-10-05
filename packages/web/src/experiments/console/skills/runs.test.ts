import { afterEach, describe, expect, test } from 'bun:test';
import { respondRun } from './runs';
import { toRun } from '../primitives/run';

describe('respondRun', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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
