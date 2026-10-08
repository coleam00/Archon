import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { describeWorkflowStoreConformance } from '../store-conformance';
import * as telemetry from '../run-terminal-telemetry';
import { createFileWorkflowStore } from './store';
import { commit } from './commit';
const roots = trackTempRoots();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
});
describeWorkflowStoreConformance('files', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'workflow-files-')));
  const reports: string[] = [];
  const spy = spyOn(telemetry, 'reportRunTerminalTelemetry').mockImplementation(run => {
    reports.push(run.id);
  });
  restore = () => spy.mockRestore();
  const store = await createFileWorkflowStore({ root });
  return {
    store,
    backdate: (id, dates) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        Object.assign(run, dates);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    terminalReports: () => reports,
    close: async () => {},
  };
});

test('undelivered approval compares the exact persisted context and reports one terminal transition', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'workflow-approval-files-')));
  const store = await createFileWorkflowStore({ root });
  const run = await store.createWorkflowRun({ workflow_name: 'approval', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  const approval = {
    nodeId: 'review',
    pauseId: 'pause',
    message: 'Choose',
    type: 'approval' as const,
    onRejectPrompt: undefined,
    onRejectMaxAttempts: undefined,
    decisions: [{ id: 'approve', label: undefined }],
  };
  await store.pauseWorkflowRun(run.id, approval);
  const before = await Bun.file(join(root, 'runs', run.id, 'log.jsonl')).text();
  expect(await store.failPausedApproval(run.id, { ...approval, pauseId: 'stale' }, 'lost')).toEqual(
    { failed: false }
  );
  expect(await Bun.file(join(root, 'runs', run.id, 'log.jsonl')).text()).toBe(before);
  const report = spyOn(telemetry, 'reportRunTerminalTelemetry').mockImplementation(() => {});
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.failPausedApproval(run.id, approval, 'lost'))
    );
    expect(results.filter(result => result.failed)).toHaveLength(1);
    expect(await store.getWorkflowRun(run.id)).toMatchObject({
      status: 'failed',
      metadata: { error: 'lost' },
    });
    expect(
      (await store.listWorkflowEvents(run.id)).filter(
        event => event.event_type === 'workflow_failed'
      )
    ).toHaveLength(1);
    expect(report).toHaveBeenCalledTimes(1);
  } finally {
    report.mockRestore();
  }
});
