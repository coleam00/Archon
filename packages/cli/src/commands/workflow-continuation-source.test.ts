// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
const paths = await import('@archon/paths');
const warn = mock((_fields: unknown, _message: string) => undefined);
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({ warn, error: mock(() => undefined) }),
}));
mock.module('../utils/stdout', () => ({ writeStdout: async () => undefined }));
const { workflowContinuationCommand } = await import('./workflow-continuations');
const trackTempRoot = trackTempRoots();

test('CLI wake bounds missing source even when the recorded working directory is foreign', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'cli-foreign-source-')));
  const sourcePath = join(root, 'missing-source');
  const run: WorkflowRun = {
    id: 'foreign-cli-source',
    workflow_name: 'deliver',
    status: 'paused',
    outcome: null,
    origin: null,
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    user_message: '',
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: join(root, 'missing-worktree'),
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    metadata: {
      workflow_source: {
        version: 1,
        root: sourcePath,
        origin: root,
        captured_at: new Date().toISOString(),
        digest: 'a'.repeat(64),
        file_count: 1,
        byte_count: 1,
      },
      wait: {
        owner: 'node',
        kind: 'time',
        nodeId: 'delay',
        waitingSince: '2026-08-24T10:00:00Z',
        resumeAt: '2026-08-24T11:00:00Z',
      },
    },
  };
  const getRun = mock(async () => run);
  const defer = mock(async () => undefined);
  const execute = mock(async () => {
    throw new Error('must not execute');
  });
  const host = {
    deps: {
      store: {
        getWorkflowRun: getRun,
        listDueWorkflowContinuations: async () => [run],
        deferWorkflowContinuation: defer,
      },
    },
    engine: { resume: execute },
  } as unknown as WorkflowHost;
  warn.mockClear();
  for (let i = 0; i < 8; i++) await workflowContinuationCommand(host, 'wake', [], { json: true });
  expect(getRun).toHaveBeenCalledTimes(3);
  expect(defer).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]).toEqual([
    expect.objectContaining({ runId: run.id, path: join(sourcePath, 'manifest.json') }),
    expect.stringContaining(`archon workflow abandon ${run.id}`),
  ]);
  expect(run.status).toBe('paused');
});
