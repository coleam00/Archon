/**
 * `--item <key>` on wait, cancel and abandon: which runs the verb acts on, and the
 * refusals that keep the engine from choosing between runs.
 */
import {
  mockWaitForRunAttention,
  spyOnJsonStdout,
  spyOnStderr,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  workflowAbandonItemCommand,
  workflowCancelItemCommand,
  workflowWaitItemCommand,
} from './workflow-item-runs';

type ItemRunRow =
  | Pick<WorkflowRun, 'id' | 'workflow_name' | 'status' | 'started_at'>
  | {
      type: 'degraded';
      reason: 'run_unreadable';
      runId: string;
    };

const run = (id: string, status: WorkflowRun['status']): ItemRunRow => ({
  id,
  workflow_name: 'implement',
  status,
  started_at: new Date('2026-11-16T10:00:00.000Z'),
});

function itemHost(runs: ItemRunRow[]): {
  host: WorkflowHost;
  cancelWorkflow: ReturnType<typeof mock>;
  abandonWorkflow: ReturnType<typeof mock>;
} {
  const host = createTestWorkflowHost();
  host.deps.store.getItemRuns = async () =>
    ({
      item: { id: 'item-1', projectKey: 'project', key: 'issue-42' },
      runs,
      descendantIds: [],
    }) as unknown as Awaited<ReturnType<WorkflowHost['deps']['store']['getItemRuns']>>;
  const cancelWorkflow = mock(async (id: string) => ({
    kind: 'stopped',
    run: { id, workflow_name: 'implement' },
    cleanupWarnings: [],
    cascadeFailures: 0,
    blockedParentRunId: null,
  }));
  const abandonWorkflow = mock(async (id: string) => ({
    run: { id, workflow_name: 'implement' },
    cascadeFailures: 0,
    blockedParentRunId: null,
    owner: { kind: 'stopped', pid: 7 },
  }));
  host.operations.cancelWorkflow =
    cancelWorkflow as unknown as typeof host.operations.cancelWorkflow;
  host.operations.abandonWorkflow =
    abandonWorkflow as unknown as typeof host.operations.abandonWorkflow;
  return { host, cancelWorkflow, abandonWorkflow };
}

describe('wait, cancel and abandon --item', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOnStderr();
    stdoutSpy = spyOnJsonStdout();
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb-1',
      name: 'project',
      default_cwd: '/test/path',
    });
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  it('cancel acts on the one running run and leaves ended runs alone', async () => {
    const { host, cancelWorkflow } = itemHost([
      run('done', 'completed'),
      run('live', 'running'),
      run('broke', 'failed'),
    ]);

    expect(await workflowCancelItemCommand(host, 'issue-42', '/test/path', { json: true })).toBe(0);

    expect(cancelWorkflow.mock.calls.map(call => call[0])).toEqual(['live']);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      action: 'cancel',
      item: 'issue-42',
      results: [{ ok: true, runId: 'live', action: 'cancel', processStopped: true }],
    });
  });

  it('cancel acts on a pending run and reports it was pending', async () => {
    const { host, cancelWorkflow } = itemHost([run('done', 'completed'), run('queued', 'pending')]);
    cancelWorkflow.mockImplementationOnce(async (id: string) => ({
      kind: 'pending',
      run: { id, workflow_name: 'implement' },
    }));

    expect(await workflowCancelItemCommand(host, 'issue-42', '/test/path', { json: true })).toBe(0);

    expect(cancelWorkflow.mock.calls.map(call => call[0])).toEqual(['queued']);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      results: [{ ok: true, runId: 'queued', previousStatus: 'pending', processStopped: false }],
    });
  });

  it('cancel refuses and lists the runs when several are running', async () => {
    const { host, cancelWorkflow } = itemHost([run('a', 'running'), run('b', 'running')]);

    expect(await workflowCancelItemCommand(host, 'issue-42', '/test/path', { json: true })).toBe(1);

    expect(cancelWorkflow).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      item: 'issue-42',
      reason: 'several_runs',
      runs: [
        { id: 'a', status: 'running' },
        { id: 'b', status: 'running' },
      ],
    });
  });

  it('cancel --all-runs acts on each in start order and one failure does not stop the rest', async () => {
    const { host, cancelWorkflow } = itemHost([run('a', 'running'), run('b', 'running')]);
    cancelWorkflow.mockImplementationOnce(async () => {
      throw new Error('owner did not stop');
    });

    const code = await workflowCancelItemCommand(host, 'issue-42', '/test/path', {
      json: true,
      allRuns: true,
    });

    expect(code).toBe(1);
    expect(cancelWorkflow.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      results: [
        { ok: false, runId: 'a', action: 'cancel', error: 'owner did not stop' },
        { ok: true, runId: 'b', action: 'cancel' },
      ],
    });
  });

  it('abandon acts on the live run, not on a failed one', async () => {
    const { host, abandonWorkflow } = itemHost([run('broke', 'failed'), run('gate', 'paused')]);

    expect(await workflowAbandonItemCommand(host, 'issue-42', '/test/path')).toBe(0);

    expect(abandonWorkflow.mock.calls.map(call => call[0])).toEqual(['gate']);
    expect(consoleSpy).toHaveBeenCalledWith('Abandoned workflow run: gate');
  });

  it('refuses with no_run when no run on the item is in a state the verb applies to', async () => {
    const { host, abandonWorkflow } = itemHost([run('done', 'completed')]);

    expect(await workflowAbandonItemCommand(host, 'issue-42', '/test/path', { json: true })).toBe(
      1
    );

    expect(abandonWorkflow).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      reason: 'no_run',
      runs: [{ id: 'done', status: 'completed' }],
    });
  });

  it('refuses the whole item when one of its runs cannot be read', async () => {
    const { host, cancelWorkflow } = itemHost([
      run('live', 'running'),
      { type: 'degraded', reason: 'run_unreadable', runId: 'lost' },
    ]);

    expect(await workflowCancelItemCommand(host, 'issue-42', '/test/path', { json: true })).toBe(1);

    expect(cancelWorkflow).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({ reason: 'unreadable' });
  });

  it.each([
    [
      'attention',
      { kind: 'attention', attention: { kind: 'terminal', runId: 'live', status: 'failed' } },
      0,
      true,
    ],
    ['deadline', { kind: 'deadline', runId: 'live', observedStatus: 'running' }, 3, true],
    ['not_found', { kind: 'not_found', runId: 'live' }, 1, false],
  ] as const)(
    'wait names the run that reported %s, with the run-id form exit status',
    async (kind, result, exitCode, ok) => {
      const { host } = itemHost([run('done', 'completed'), run('live', 'running')]);
      mockWaitForRunAttention.mockResolvedValueOnce(result);

      // A run's deadline does not stop the item's wait; the item's own deadline does.
      const code = await workflowWaitItemCommand(host, 'issue-42', '/test/path', {
        json: true,
        timeoutSeconds: 0.01,
      });

      expect(code).toBe(exitCode);

      expect(mockWaitForRunAttention.mock.calls.at(-1)?.[1]).toBe('live');
      const payload = JSON.parse(firstJsonPayload(stdoutSpy));
      expect(payload).toMatchObject({ ok, action: 'wait', item: 'issue-42' });
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]).toMatchObject(
        kind === 'not_found'
          ? { runId: 'live', error: 'not_found' }
          : { runId: 'live', result: kind }
      );
    }
  );

  it('wait refuses an item with no live run instead of blocking', async () => {
    const { host } = itemHost([run('done', 'completed')]);

    expect(await workflowWaitItemCommand(host, 'issue-42', '/test/path', { json: true })).toBe(1);

    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'wait',
      item: 'issue-42',
      reason: 'no_run',
    });
  });
});
