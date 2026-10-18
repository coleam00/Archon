// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { mockWorkflowRun } from '../test/mocks/workflow-run';

const mockQuery = createMockQuery();

// Mock the connection module before importing the module under test.
// `getDatabase().withTransaction` runs its callback against the SAME mockQuery,
// so a transactional function's statements land in mockQuery.mock.calls in
// order, exactly like the non-transactional ones.
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDatabase: () => ({
    withTransaction: <T>(fn: (query: typeof mockQuery) => Promise<T>): Promise<T> => fn(mockQuery),
  }),
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  pauseWorkflowRunForWait,
  listDueWorkflowContinuations,
  listWorkflowEventSignalCandidates,
  deferWorkflowContinuation,
  signalWorkflowWait,
  clearWorkflowWaitContext,
} from './workflow-run-waits';

describe('durable workflow waits', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  const wait = {
    owner: 'node' as const,
    nodeId: 'await-ci',
    kind: 'event' as const,
    event: 'checks.complete',
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2026-08-25T10:00:00.000Z',
  };

  test('pauses a running run with a distinct wait envelope', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await pauseWorkflowRunForWait('workflow-run-123', wait, {
      kind: 'started',
      stepName: 'await-ci',
    });
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("SET status = 'paused'");
    expect(query).toContain("jsonb_set(metadata - 'approval', '{wait}'");
    expect(JSON.parse(params[1] as string)).toEqual(wait);
    expect(mockQuery.mock.calls[1]?.[0]).toContain('INSERT INTO remote_agent_workflow_events');
  });

  test('records an attention pause without inventing a deadline', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    const attentionWait = {
      owner: 'node' as const,
      nodeId: 'rerun-ci',
      kind: 'attention' as const,
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Re-run the failing check, then resume.',
    };

    await pauseWorkflowRunForWait('workflow-run-123', attentionWait, {
      kind: 'started',
      stepName: 'rerun-ci',
    });

    const [, pauseParams] = mockQuery.mock.calls[0] as [string, unknown[]];
    const [, eventParams] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(JSON.parse(pauseParams[1] as string)).toEqual(attentionWait);
    const eventData = JSON.parse(eventParams[5] as string) as Record<string, unknown>;
    expect(eventData).toEqual({ kind: 'attention' });
    expect(eventData).not.toHaveProperty('resume_at');
  });

  test('fails the pause transaction when the wait-start audit cannot be recorded', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockRejectedValueOnce(new Error('event insert failed'));

    await expect(
      pauseWorkflowRunForWait('workflow-run-123', wait, {
        kind: 'started',
        stepName: 'await-ci',
      })
    ).rejects.toThrow('Failed to pause workflow run for wait: event insert failed');

    expect(mockQuery.mock.calls).toHaveLength(2);
  });

  test('rejects widened mixed wait fields before persistence', async () => {
    const mixed = {
      owner: 'node' as const,
      nodeId: 'later',
      kind: 'time' as const,
      event: 'checks.complete',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2026-08-25T10:00:00.000Z',
    };

    await expect(
      pauseWorkflowRunForWait('workflow-run-123', mixed, { kind: 'continued' })
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('lists due paused waits, quota-failed continuations and answered gates', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));
    const result = await listDueWorkflowContinuations(new Date('2026-08-25T10:00:00.000Z'), 25);
    expect(result).toHaveLength(1);
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("status = 'paused'");
    expect(query).toContain("status = 'failed'");
    expect(query).toContain("IN ('time', 'event', 'quota')");
    expect(query).toContain("metadata->>'continuation_retry_at' IS NULL");
    expect(query).toContain("metadata->'approval'->>'resolved' IN ('approved', 'rejected')");
    expect(query).toContain("NOT IN ('child_workflow', 'fan_out', 'writeback')");
    expect(query).toContain("ORDER BY CASE WHEN COALESCE(metadata->>'continuation_retry_at'");
    expect(params).toEqual(['2026-08-25T10:00:00.000Z', 25, 0]);
  });

  test('lists typed outputs for exact open event waits and skips malformed rows', async () => {
    const structuredOutput = {
      repo: { host: 'github.com', path: 'example/repo' },
      number: 42,
    };
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          run_id: 'run-object-json',
          run_metadata: { wait },
          event_data: { output_type: 'pull-request', structured_output: structuredOutput },
        },
        {
          run_id: 'run-string-json',
          run_metadata: JSON.stringify({ wait }),
          event_data: JSON.stringify({
            output_type: 'pull-request',
            structured_output: structuredOutput,
          }),
        },
        {
          run_id: 'malformed-metadata',
          run_metadata: '{',
          event_data: { output_type: 'pull-request', structured_output: structuredOutput },
        },
        {
          run_id: 'malformed-event',
          run_metadata: { wait },
          event_data: '{',
        },
        {
          run_id: 'wrong-event',
          run_metadata: { wait: { ...wait, event: 'deploy.complete' } },
          event_data: { output_type: 'pull-request', structured_output: structuredOutput },
        },
        {
          run_id: 'already-signaled',
          run_metadata: {
            wait: { ...wait, signaledAt: '2026-08-24T10:01:00.000Z' },
          },
          event_data: { output_type: 'pull-request', structured_output: structuredOutput },
        },
      ])
    );

    const now = new Date('2026-08-24T10:02:00.000Z');
    await expect(listWorkflowEventSignalCandidates('checks.complete', now)).resolves.toEqual([
      { runId: 'run-object-json', wait, outputType: 'pull-request', structuredOutput },
      { runId: 'run-string-json', wait, outputType: 'pull-request', structuredOutput },
    ]);

    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id');
    expect(query).toContain("r.status = 'paused'");
    expect(query).toContain("r.metadata->'wait'->>'kind' = 'event'");
    expect(query).toContain("r.metadata->'wait'->>'event' = $1");
    expect(query).toContain("r.metadata->'wait'->>'signaledAt' IS NULL");
    expect(query).toContain("r.metadata->'wait'->>'resumeAt' > $2");
    expect(query).toContain("e.event_type = 'node_completed'");
    expect(query).toContain("e.data->>'output_type' <> ''");
    expect(query).toContain("jsonb_typeof(e.data->'structured_output')");
    expect(params).toEqual(['checks.complete', now.toISOString()]);
  });

  test('defers an unresolvable continuation without changing lifecycle status', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await deferWorkflowContinuation('workflow-run-123', '2026-08-25T10:01:00.000Z', {
      kind: 'wait',
      pauseId: 'wait-occurrence',
      nodeId: wait.nodeId,
      resumeAt: wait.resumeAt,
    });

    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("status = 'paused'");
    expect(query).toContain("status = 'failed'");
    expect(query).not.toContain('SET status =');
    expect(query).toContain("metadata->'wait'->>'pauseId' = $7");
    expect(query).toContain("metadata->'wait'->>'nodeId' = $4");
    expect(JSON.parse(params[1] as string)).toEqual({
      continuation_retry_at: '2026-08-25T10:01:00.000Z',
    });
    expect(params.slice(2)).toEqual([
      wait.resumeAt,
      wait.nodeId,
      null,
      null,
      'wait-occurrence',
      null,
      null,
    ]);
  });

  test('keys quota backoff to the exact attempt cursor', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await deferWorkflowContinuation('workflow-run-123', '2026-08-25T10:01:00.000Z', {
      kind: 'quota',
      attempt: 2,
      resumeAt: '2026-08-25T10:00:00.000Z',
    });

    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("CAST(metadata->'scheduled_resume'->>'attempt' AS INTEGER) = $5");
    expect(params.slice(2)).toEqual(['2026-08-25T10:00:00.000Z', null, 2, null, null, null, null]);
  });

  test('clears only the exact active wait cursor on a running run', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    const wait = {
      owner: 'node' as const,
      nodeId: 'await-ci',
      kind: 'event' as const,
      event: 'checks.complete',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2026-08-25T10:00:00.000Z',
    };

    await expect(
      clearWorkflowWaitContext('workflow-run-123', wait, {
        stepName: 'await-ci',
        result: { status: 'satisfied', waited_ms: 1000 },
      })
    ).resolves.toMatchObject({ cleared: true });
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("metadata - 'wait'");
    expect(query).toContain("status = 'running'");
    expect(query).toContain("metadata->'wait'->>'nodeId' = $2");
    expect(query).toContain("metadata->'wait'->>'resumeAt' = $3");
    expect(params).toEqual(['workflow-run-123', 'await-ci', wait.resumeAt]);
    expect(mockQuery.mock.calls[1]?.[0]).toContain('INSERT INTO remote_agent_workflow_events');
    expect(mockQuery.mock.calls[2]?.[0]).toContain('INSERT INTO remote_agent_workflow_events');
  });

  test('keys attention wait consumption to its waiting timestamp', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    const attentionWait = {
      owner: 'node' as const,
      nodeId: 'rerun-ci',
      kind: 'attention' as const,
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Re-run the failing check, then resume.',
    };

    await expect(
      clearWorkflowWaitContext('workflow-run-123', attentionWait, {
        stepName: 'rerun-ci',
        result: { status: 'satisfied', waited_ms: 1000 },
      })
    ).resolves.toMatchObject({ cleared: true });

    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("metadata->'wait'->>'waitingSince' = $3");
    expect(params).toEqual(['workflow-run-123', 'rerun-ci', attentionWait.waitingSince]);
  });

  test('signals only the matching still-open event wait', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    expect(
      await signalWorkflowWait(
        'workflow-run-123',
        {
          owner: 'node',
          nodeId: 'await-ci',
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
        { conclusion: 'success' }
      )
    ).toEqual({ signaled: true });
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("metadata->'wait'->>'event' = $2");
    expect(query).toContain("metadata->'wait'->>'nodeId' = $3");
    expect(query).toContain("metadata->'wait'->>'resumeAt' = $4");
    expect(query).toContain("metadata->'wait'->>'signaledAt' IS NULL");
    expect(query).toContain("metadata->'wait'->>'resumeAt' > $5");
    expect(params[1]).toBe('checks.complete');
    expect(params[2]).toBe('await-ci');
    expect(params[3]).toBe('2026-08-25T10:00:00.000Z');
    expect(JSON.parse(params[5] as string)).toEqual({ conclusion: 'success' });
    expect(mockQuery.mock.calls[1]?.[0]).toContain('INSERT INTO remote_agent_workflow_events');
  });

  test('preserves an omitted signal payload as absent', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await expect(
      signalWorkflowWait('workflow-run-123', {
        owner: 'node',
        nodeId: 'await-ci',
        kind: 'event',
        event: 'checks.complete',
        waitingSince: '2026-08-24T10:00:00.000Z',
        resumeAt: '2026-08-25T10:00:00.000Z',
      })
    ).resolves.toEqual({ signaled: true });

    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("'{wait,signaledAt}'");
    expect(query).not.toContain("'{wait,payload}'");
    expect(params).toHaveLength(5);
  });
});
