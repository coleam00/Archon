import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { RunsPage } from './RunsPage';
import { invalidate, set, subscribeKey } from '../store/cache';
import { K } from '../store/keys';
import { toRun } from '../primitives/run';
import { listRunsNeedingAttention } from '../skills/runs';

afterEach(() => {
  invalidate('runs');
});

const old = toRun({
  id: 'old-run',
  workflow_name: 'old-review',
  codebase_id: null,
  status: 'paused',
  started_at: '2026-10-01T00:00:00.000Z',
  attention: {
    kind: 'awaiting_response',
    runId: 'old-run',
    respondTo: { runId: 'old-run', nodeId: 'review' },
    message: 'Approve old work',
    occurrence: 'old-pause',
  },
  metadata: { approval: { nodeId: 'review', message: 'Approve old work', pauseId: 'old-pause' } },
});
const action = toRun({
  id: 'action-run',
  workflow_name: 'rotate-key',
  codebase_id: null,
  status: 'paused',
  started_at: '2026-10-12T00:00:00.000Z',
  attention: {
    kind: 'attention',
    runId: 'action-run',
    nodeId: 'hold',
    message: 'Rotate the key, then resume',
    occurrence: 'legacy:hold',
    form: 'message',
    options: [],
  },
});

test('the banner includes an attention wait with Resume and a gate beyond the first 50 runs', () => {
  const runs = Array.from({ length: 50 }, (_, i) =>
    toRun({
      id: `newer-${i}`,
      workflow_name: 'newer',
      codebase_id: null,
      status: 'running',
      started_at: '2026-10-12T00:00:00.000Z',
    })
  );
  set(K.runs('all'), {
    runs,
    total: 52,
    counts: { all: 52, running: 50, paused: 2, failed: 0, cancelled: 0, completed: 0, pending: 0 },
  });
  set(K.runsAttention, [old, action]);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>
  );
  expect(html).toContain('Needs your input');
  expect(html).toContain('data-pending-run-id="old-run"');
  expect(html).toContain('Approve old work');
  expect(html).toContain('data-pending-run-id="action-run"');
  expect(html).toContain('Rotate the key, then resume');
  expect(html).toContain('Resume');
  expect(html).toContain('Abandon');
});

test('the attention cache refetches on the same runs cue as the feed', async () => {
  let reads = 0;
  let changes = 0;
  const unsubscribe = subscribeKey(
    K.runsAttention,
    () => {
      changes++;
    },
    async () => {
      reads++;
      return [action];
    }
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    invalidate('runs');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    expect(changes).toBe(2);
  } finally {
    unsubscribe();
  }
});

test('the console attention skill uses the unpaged endpoint and preserves its API projection', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      return Response.json({
        runs: [
          {
            id: action.id,
            workflow_name: action.workflow,
            codebase_id: null,
            status: 'paused',
            started_at: action.startedAt,
            attention: action.attention,
          },
        ],
      });
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    expect((await listRunsNeedingAttention())[0]?.attention).toEqual(action.attention);
    expect(requests).toEqual(['/api/runs/attention']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unreadable paused gates appear as repair entries without fabricated actions', () => {
  const repair = toRun({
    id: 'repair-run',
    workflow_name: 'broken-gate',
    codebase_id: null,
    status: 'paused',
    started_at: '2026-10-12T00:00:00.000Z',
    attention: {
      kind: 'unreadable',
      runId: 'repair-run',
      reason: 'malformed_gate',
      detail: 'paused with an approval gate this build cannot read',
    },
  });
  set(K.runsAttention, [repair]);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>
  );
  expect(html).toContain('data-pending-run-id="repair-run"');
  expect(html).toContain('Repair needed:');
  expect(html).toContain('href="/console/r/repair-run"');
  expect(html).not.toContain('Resume');
  expect(html).not.toContain('Approve');
  expect(html).not.toContain('Reject');
});
